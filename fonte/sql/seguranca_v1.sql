-- =====================================================================
-- Segurança v1 (22/11/2026)
--  1. Verificação em duas etapas (TOTP) para quem tem acesso completo
--  2. Trava de preço: pedidos ao Gestão/POS suspeitos ficam "aguardando"
--     até o administrador liberar (fila e promoções)
--  3. Funções que não precisam ficam fechadas para quem não fez login
-- =====================================================================

-- ---------- 1. Verificação em duas etapas ----------
alter table public.usuarios_permitidos add column if not exists exige_2fa boolean not null default true;
-- quem já existe começa sem exigência: ao cadastrar o código no site a exigência liga sozinha
-- (porque passa a existir um fator verificado); evita trancar alguém fora antes de configurar
update public.usuarios_permitidos set exige_2fa = false;

create or replace function public.mfa_ok()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or (not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
          and not coalesce((select u.exige_2fa from usuarios_permitidos u where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))), true));
$$;

create or replace function public.permitido()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from usuarios_permitidos where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and perfil = 'completo')
     and public.mfa_ok();
$$;

create or replace function public.eh_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from usuarios_permitidos where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and admin)
     and public.mfa_ok();
$$;

create or replace function public.entrar()
returns jsonb language plpgsql security definer set search_path = public as $$
declare e text := lower(coalesce(auth.jwt() ->> 'email', '')); n int; u record;
begin
  if e = '' then return jsonb_build_object('ok', false, 'motivo', 'sem login'); end if;
  select count(*) into n from usuarios_permitidos;
  if n = 0 then insert into usuarios_permitidos (email, nome, admin) values (e, 'Administrador', true); end if;
  select * into u from usuarios_permitidos where email = e;
  if found then
    return jsonb_build_object('ok', true, 'admin', u.admin, 'perfil', u.perfil, 'nome', u.nome,
      'aal', coalesce(auth.jwt() ->> 'aal', ''), 'exige_2fa', u.exige_2fa,
      'tem_2fa', exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified'));
  end if;
  return jsonb_build_object('ok', false, 'motivo', 'e-mail não autorizado');
end $$;

create or replace function public.incluir_usuario(p_email text, p_nome text, p_perfil text default 'completo')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.eh_admin() then raise exception 'só administrador (com a verificação em duas etapas) inclui usuários'; end if;
  if coalesce(p_perfil, 'completo') not in ('completo', 'separacao') then raise exception 'perfil inválido'; end if;
  insert into usuarios_permitidos (email, nome, perfil) values (lower(trim(p_email)), p_nome, coalesce(p_perfil, 'completo'))
    on conflict (email) do update set nome = excluded.nome, perfil = case when usuarios_permitidos.admin then 'completo' else excluded.perfil end;
end $$;

-- políticas: (select permitido()) é avaliado uma vez por consulta, não uma vez por linha
do $$
declare p record; q text; w text;
begin
  for p in select * from pg_policies where schemaname = 'public' and (qual ~ 'permitido\(\)' or with_check ~ 'permitido\(\)' or qual ~ 'pode_separar\(\)') loop
    q := case when p.qual is null then null else regexp_replace(regexp_replace(p.qual, '\(\s*SELECT\s+(permitido|pode_separar)\(\)\s+AS\s+\w+\)', '\1()', 'gi'), '(permitido|pode_separar)\(\)', '(select \1())', 'g') end;
    w := case when p.with_check is null then null else regexp_replace(regexp_replace(p.with_check, '\(\s*SELECT\s+(permitido|pode_separar)\(\)\s+AS\s+\w+\)', '\1()', 'gi'), '(permitido|pode_separar)\(\)', '(select \1())', 'g') end;
    if q is not null and w is not null then execute format('alter policy %I on %I.%I using (%s) with check (%s)', p.policyname, p.schemaname, p.tablename, q, w);
    elsif q is not null then execute format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, q);
    else execute format('alter policy %I on %I.%I with check (%s)', p.policyname, p.schemaname, p.tablename, w); end if;
  end loop;
end $$;

-- ---------- 2. Trava de preço ----------
alter table public.fila add column if not exists criado_por text;
alter table public.fila add column if not exists trava_motivo text;
alter table public.fila add column if not exists liberado_por text;
alter table public.fila add column if not exists liberado_em timestamptz;

-- Analisa o SQL que vai para o Gestão (e as linhas --POS dos caixas) e devolve os motivos para segurar.
-- Vazio = pode seguir direto.
create or replace function public.fila_avaliar(p_loja integer, p_tipo text, p_conteudo text)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare
  m text[] := '{}'; t text := coalesce(p_conteudo, ''); norm text; s text; sl text; w text; lin text; j jsonb;
  v numeric; atual numeric; v_ean text; v_id bigint; n_preco int := 0; ok_promo boolean;
begin
  if p_tipo in ('etiqueta', 'impressoras') then return m; end if;  -- não é SQL (vai para a impressora)

  -- linhas dos caixas: --POS {"e":ean,"v":preço,...}
  for lin in select x[1] from regexp_matches(t, '--POS\s*(\{[^\r\n]*\})', 'g') x loop
    begin j := lin::jsonb; exception when others then m := m || 'linha dos caixas ilegível'::text; continue; end;
    if j ? 'v' then
      begin v := (j ->> 'v')::numeric; exception when others then m := m || ('preço dos caixas inválido: ' || left(j ->> 'v', 20)); continue; end;
      n_preco := n_preco + 1;
      v_ean := j ->> 'e';
      select pr.preco_venda into atual from produtos pr where pr.loja_id = p_loja and pr.ean = v_ean limit 1;
      ok_promo := p_tipo = 'promo' and exists (select 1 from promocoes p where p.loja_id = p_loja and p.ean = v_ean and p.status in ('agendada', 'pausada', 'ativa') and (round(p.preco_promo, 2) = round(v, 2) or round(p.preco_normal, 2) = round(v, 2)));
      if v <= 0 then m := m || format('preço zero nos caixas: %s', v_ean);
      elsif atual > 0 and v < atual * 0.5 and not ok_promo then m := m || format('queda de %s%% nos caixas: %s de R$ %s para R$ %s', round((1 - v / atual) * 100), v_ean, to_char(atual, 'FM999990.00'), to_char(v, 'FM999990.00'));
      end if;
    end if;
  end loop;

  -- SQL do Gestão: sem comentários, sem aspas duplas, em maiúsculas
  norm := regexp_replace(t, '/\*.*?\*/', ' ', 'g');
  norm := regexp_replace(norm, '--[^\n]*', ' ', 'g');
  norm := upper(replace(norm, '"', ''));
  for s in select trim(regexp_replace(x, '\s+', ' ', 'g')) from (select y[1] as x from regexp_matches(norm, '((?:[^;'']|''(?:[^'']|'''')*'')+)', 'g') y) z loop  -- separa por ';' fora das aspas
    continue when s = '';
    sl := regexp_replace(s, '''([^'']|'''')*''', '''''', 'g');  -- textos entre aspas apagados (descrição não dispara a trava)
    if sl ~ '\m(DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|RECREATE|MERGE|DECLARE|GEN_ID)\M' or sl ~ '\mEXECUTE\s+(BLOCK|STATEMENT)\M' or sl ~ '^SET\s+(GENERATOR|TERM)\M' then
      m := m || ('comando perigoso: ' || left(s, 70)); continue;
    end if;
    if sl ~ '^(SELECT|COMMIT|ROLLBACK|SET\s+(LIST|BLOBDISPLAY|HEADING|COUNT|STATS|PLAN|WIDTH|ECHO|NAMES|BAIL))\M' then continue; end if;
    if sl ~ '^EXECUTE\s+PROCEDURE\s+ATUALIZAR_ESTOQUE\M' then continue; end if;
    if sl ~ '^INSERT\s+INTO\s+(PRODUTOS|COD_AUXILIARES|HIST_ALT_ESTOQUE_MANUAL)\M' then continue; end if;
    if sl ~ '^DELETE\s+FROM\s+COD_AUXILIARES\s+WHERE\s+S_CODIGO\s*=\s*''''\s+AND\s+ID_PRODUTO\s*=\s*\d+$' then continue; end if;
    if sl ~ '^UPDATE\s+DATAS\s+SET\s+T_ALT_\w+\s*=\s*CURRENT_TIMESTAMP(\s*,\s*T_ALT_\w+\s*=\s*CURRENT_TIMESTAMP)*$' then continue; end if;
    if p_tipo = 'promo' and (sl ~ '^INSERT\s+INTO\s+(PROMOCOES|PROMO_SCANTECH)\M'
        or s ~ '^DELETE\s+FROM\s+PROMO_SCANTECH\s+WHERE\s+I_ID_PROMO\s+IN\s+\(SELECT\s+ID\s+FROM\s+PROMOCOES\s+WHERE\s+S_AUX\s*=\s*''SITE#[^'']*''\)$'
        or s ~ '^DELETE\s+FROM\s+PROMOCOES\s+WHERE\s+S_AUX\s*=\s*''SITE#[^'']*''$') then continue; end if;
    if sl ~ '^UPDATE\s+PRODUTOS\s+SET\M' then
      w := substring(sl from '\mWHERE\M(.*)$');
      if w is null or w !~ '^\s*(ID\s*=\s*\d+|CODIGO_BARRAS\s*=\s*'''')(\s+AND\s+.*)?$' or w ~ '\mOR\M' then
        m := m || ('alteração em massa no cadastro: ' || left(s, 80)); continue;
      end if;
      if sl ~ '\mPRECO_VENDA1\s*=' then
        n_preco := n_preco + 1;
        v := substring(s from '\mPRECO_VENDA1\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*(?:,|WHERE\M)')::numeric;
        v_ean := substring(s from '\mWHERE\M.*\mCODIGO_BARRAS\s*=\s*''([^'']*)''');
        v_id := substring(s from '\mWHERE\s+ID\s*=\s*(\d+)')::bigint;
        if v is null then m := m || ('preço calculado em vez de valor fixo: ' || left(s, 70)); continue; end if;
        atual := null;
        if v_ean is not null then select pr.preco_venda into atual from produtos pr where pr.loja_id = p_loja and pr.ean = v_ean limit 1; end if;
        if atual is null and v_id is not null then select pr.preco_venda, pr.ean into atual, v_ean from produtos pr where pr.loja_id = p_loja and pr.id_gestao = v_id limit 1; end if;
        ok_promo := p_tipo = 'promo' and exists (select 1 from promocoes p where p.loja_id = p_loja and p.ean = v_ean and p.status in ('agendada', 'pausada', 'ativa') and (round(p.preco_promo, 2) = round(v, 2) or round(p.preco_normal, 2) = round(v, 2)));
        if v <= 0 then m := m || format('preço zero no Gestão: %s', coalesce(v_ean, 'ID ' || v_id));
        elsif atual > 0 and v < atual * 0.5 and not ok_promo then m := m || format('queda de %s%%: %s de R$ %s para R$ %s', round((1 - v / atual) * 100), coalesce(v_ean, 'ID ' || v_id), to_char(atual, 'FM999990.00'), to_char(v, 'FM999990.00'));
        end if;
      end if;
      continue;
    end if;
    m := m || ('comando fora do padrão do sistema: ' || left(s, 70));
  end loop;

  -- o mesmo item conta duas vezes quando vai ao Gestão e aos caixas (por isso 300 ≈ 150 produtos)
  if n_preco > 300 then m := m || format('muitas mudanças de preço de uma vez (%s)', n_preco); end if;
  return m;
end $$;

-- Gatilho: todo pedido feito por usuário logado passa pela análise
create or replace function public.fila_trava()
returns trigger language plpgsql security definer set search_path = public as $$
declare m text[]; e text; n int;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then return new; end if;  -- agendamentos do servidor (promoções, Bling) passam
  e := lower(coalesce(auth.jwt() ->> 'email', ''));
  new.criado_por := e;
  new.status := 'pendente'; new.pego_em := null; new.aplicado_em := null; new.resultado := null;
  new.dispensado_em := null; new.dispensado_por := null; new.liberado_por := null; new.liberado_em := null; new.trava_motivo := null;
  m := public.fila_avaliar(new.loja_id, new.tipo, new.conteudo);
  if new.tipo not in ('etiqueta', 'impressoras') then
    select count(*) into n from fila where criado_por = e and criado_em > now() - interval '10 minutes' and tipo not in ('etiqueta', 'impressoras');
    if n >= 60 then m := m || format('muitos envios seguidos (%s em 10 min)', n + 1); end if;
  end if;
  if cardinality(m) > 0 then
    new.status := 'aguardando';
    new.trava_motivo := left(array_to_string(m[1:12], ' | ') || case when cardinality(m) > 12 then format(' | … e mais %s', cardinality(m) - 12) else '' end, 3000);
  end if;
  return new;
end $$;
drop trigger if exists fila_trava on public.fila;
create trigger fila_trava before insert on public.fila for each row execute function public.fila_trava();

create or replace function public.fila_liberar(p_ids bigint[])
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.eh_admin() then raise exception 'só o administrador (com a verificação em duas etapas) libera pedidos segurados'; end if;
  update fila set status = 'pendente', liberado_por = lower(coalesce(auth.jwt() ->> 'email', '')), liberado_em = now()
   where id = any(p_ids) and status = 'aguardando';
  get diagnostics n = row_count; return n;
end $$;

create or replace function public.fila_recusar(p_ids bigint[])
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.eh_admin() then raise exception 'só o administrador (com a verificação em duas etapas) recusa pedidos segurados'; end if;
  update fila set status = 'erro', aplicado_em = now(), liberado_por = lower(coalesce(auth.jwt() ->> 'email', '')), liberado_em = now(),
         resultado = 'TRAVA DE SEGURANÇA: pedido recusado pelo administrador. Nada foi gravado no Gestão nem nos caixas (ENSAIO RECUSADO).' || chr(10) || 'Motivo da trava: ' || coalesce(trava_motivo, '')
   where id = any(p_ids) and status = 'aguardando';
  get diagnostics n = row_count; return n;
end $$;

-- Promoções: preço de promoção muito abaixo do atual (ou "preço normal" falso) fica aguardando liberação
alter table public.promocoes add column if not exists trava_motivo text;

create or replace function public.promo_avaliar(p public.promocoes)
returns text language plpgsql stable security definer set search_path = public as $$
declare atual numeric; ref numeric; r text := '';
begin
  select pr.preco_venda into atual from produtos pr where pr.loja_id = p.loja_id and pr.ean = p.ean limit 1;
  ref := coalesce(nullif(atual, 0), p.preco_normal);
  if atual > 0 and p.preco_normal is not null and p.preco_normal < atual * 0.5 then
    r := r || format('preço normal informado (R$ %s) muito abaixo do atual (R$ %s); ', to_char(p.preco_normal, 'FM999990.00'), to_char(atual, 'FM999990.00'));
  end if;
  if p.preco_promo is not null and p.preco_promo <= 0 then r := r || 'preço de promoção zero; ';
  elsif ref > 0 and p.preco_promo is not null and p.preco_promo < ref * 0.5 then
    r := r || format('promoção %s%% abaixo do preço (R$ %s → R$ %s); ', round((1 - p.preco_promo / ref) * 100), to_char(ref, 'FM999990.00'), to_char(p.preco_promo, 'FM999990.00'));
  end if;
  return nullif(r, '');
end $$;

create or replace function public.promocoes_trava()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text; n int;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then return new; end if;
  if coalesce(current_setting('app.liberando', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    new.criado_por := lower(coalesce(auth.jwt() ->> 'email', ''));
    new.fila_ini := null; new.fila_fim := null; new.aplicada_em := null; new.encerrada_em := null;
    new.status := 'agendada'; new.trava_motivo := null;
    r := public.promo_avaliar(new);
    select count(*) into n from promocoes where criado_por = new.criado_por and criado_em > now() - interval '10 minutes';
    if n >= 200 then r := coalesce(r, '') || format('muitas promoções seguidas (%s em 10 min); ', n + 1); end if;
    if r is not null then new.status := 'aguardando'; new.trava_motivo := r; end if;
    return new;
  end if;
  -- UPDATE
  if old.status = 'aguardando' and new.status not in ('aguardando', 'cancelada') then
    raise exception 'Promoção segurada pela trava de segurança: só o administrador libera.';
  end if;
  if (new.preco_promo, new.preco_normal, new.ean, new.loja_id, new.desconto_pct, new.combo_preco) is distinct from
     (old.preco_promo, old.preco_normal, old.ean, old.loja_id, old.desconto_pct, old.combo_preco) then
    r := public.promo_avaliar(new);
    if r is not null then raise exception 'Alteração bloqueada pela trava de segurança: %', r; end if;
  end if;
  return new;
end $$;
drop trigger if exists promocoes_trava on public.promocoes;
create trigger promocoes_trava before insert or update on public.promocoes for each row execute function public.promocoes_trava();

create or replace function public.promo_liberar(p_ids bigint[])
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.eh_admin() then raise exception 'só o administrador (com a verificação em duas etapas) libera promoções seguradas'; end if;
  perform set_config('app.liberando', '1', true);
  update promocoes set status = 'agendada', obs = trim(coalesce(obs, '') || ' [liberada por ' || lower(coalesce(auth.jwt() ->> 'email', '')) || ' em ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || ']')
   where id = any(p_ids) and status = 'aguardando';
  get diagnostics n = row_count;
  perform set_config('app.liberando', '', true);
  return n;
end $$;

-- ---------- 3. Permissões das funções ----------
revoke execute on function public.mfa_ok(), public.eh_admin(), public.fila_avaliar(integer, text, text), public.fila_trava(),
  public.promo_avaliar(public.promocoes), public.promocoes_trava() from public, anon, authenticated;
grant execute on function public.mfa_ok(), public.eh_admin() to authenticated;
revoke execute on function public.fila_liberar(bigint[]), public.fila_recusar(bigint[]), public.promo_liberar(bigint[]) from public, anon;
grant execute on function public.fila_liberar(bigint[]), public.fila_recusar(bigint[]), public.promo_liberar(bigint[]) to authenticated;

-- não precisam de acesso sem login
revoke execute on function public.cadastro_compacto(integer), public.entrar(), public.estacoes_status(), public.incluir_usuario(text, text, text),
  public.promocoes_rodar_site(), public.sugestao_compra(integer, integer, integer) from public, anon;
-- funções de gatilho e o agendador das promoções: ninguém chama pelo site
revoke execute on function public.cupons_normalizar(), public.fila_rotear(), public.precos_hist_tg(), public.promocoes_rodar() from public, anon, authenticated;

-- caminho de busca fixo nas funções auxiliares
alter function public.promo_txt_fb(text) set search_path = public;
alter function public.promo_fim_ts(public.promocoes) set search_path = public;
alter function public.promo_ligada(public.promocoes, timestamp) set search_path = public;
alter function public.meio_norm(text) set search_path = public;
alter function public.meio_cod(integer, integer) set search_path = public;
