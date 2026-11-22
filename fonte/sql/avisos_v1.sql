-- =====================================================================
-- Avisos no celular (Web Push) — 22/11/2026
-- Aparelhos inscritos, preferências por usuário e fila de eventos.
-- Quem envia é a função de borda "avisos", chamada a cada minuto pelo pg_cron
-- (só quando há evento novo).
-- Tipos: venda_mkt (venda nos marketplaces), carga (envio ao Gestão/caixas gravado ou com erro),
--        trava (envio segurado pela trava de segurança), boletos (8h e 17h30), resumo (vendas do dia, 21h), teste
-- =====================================================================

create table if not exists public.avisos_aparelhos (
  id bigserial primary key,
  email text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  nome text,
  criado_em timestamptz not null default now(),
  ultimo_ok timestamptz,
  falhas int not null default 0
);
create table if not exists public.avisos_prefs (
  email text primary key,
  tipos text[] not null,
  atualizado_em timestamptz not null default now()
);
create table if not exists public.avisos_eventos (
  id bigserial primary key,
  tipo text not null,
  email text,             -- preenchido = só para essa pessoa (ex.: teste)
  titulo text not null,
  corpo text,
  url text,
  tag text,
  criado_em timestamptz not null default now(),
  enviado_em timestamptz,
  resultado text
);
create index if not exists avisos_eventos_pend on public.avisos_eventos (id) where enviado_em is null;
create table if not exists public.avisos_config (
  id int primary key default 1 check (id = 1),
  vapid_public text not null,
  vapid_private text not null,
  subject text not null default 'mailto:novaraphaella@gmail.com'
);
alter table public.avisos_config enable row level security;  -- sem políticas: só a função de borda (service_role) lê
alter table public.avisos_aparelhos enable row level security;
alter table public.avisos_prefs enable row level security;
alter table public.avisos_eventos enable row level security;

-- tipos que cada perfil pode receber
create or replace function public.avisos_tipos_do(p_email text)
returns text[] language sql stable security definer set search_path = public as $$
  select case
    when u.perfil = 'separacao' then array['venda_mkt']
    when u.admin then array['venda_mkt', 'carga', 'trava', 'boletos', 'resumo']
    else array['venda_mkt', 'carga', 'boletos', 'resumo'] end
  from usuarios_permitidos u where lower(u.email) = lower(p_email);
$$;

-- ----- RPCs do site -----
create or replace function public.avisos_minhas()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.pode_separar() then null else jsonb_build_object(
    'permitidos', to_jsonb(public.avisos_tipos_do(auth.jwt() ->> 'email')),
    'tipos', to_jsonb(coalesce((select p.tipos from avisos_prefs p where p.email = lower(auth.jwt() ->> 'email')), public.avisos_tipos_do(auth.jwt() ->> 'email'))),
    'aparelhos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome, 'endpoint', a.endpoint, 'criado_em', a.criado_em, 'ultimo_ok', a.ultimo_ok) order by a.id)
                           from avisos_aparelhos a where a.email = lower(auth.jwt() ->> 'email')), '[]'::jsonb)) end;
$$;

create or replace function public.avisos_inscrever(p_endpoint text, p_p256dh text, p_auth text, p_nome text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.pode_separar() then raise exception 'sem permissão'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'aparelho inválido'; end if;
  insert into avisos_aparelhos (email, endpoint, p256dh, auth, nome)
  values (lower(auth.jwt() ->> 'email'), p_endpoint, p_p256dh, p_auth, left(p_nome, 80))
  on conflict (endpoint) do update set email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth, nome = excluded.nome, falhas = 0;
end $$;

create or replace function public.avisos_remover(p_id bigint)
returns void language sql security definer set search_path = public as $$
  delete from avisos_aparelhos where id = p_id and email = lower(auth.jwt() ->> 'email');
$$;

create or replace function public.avisos_salvar(p_tipos text[])
returns void language plpgsql security definer set search_path = public as $$
declare e text := lower(auth.jwt() ->> 'email');
begin
  if not public.pode_separar() then raise exception 'sem permissão'; end if;
  insert into avisos_prefs (email, tipos) values (e, array(select unnest(p_tipos) intersect select unnest(public.avisos_tipos_do(e))))
  on conflict (email) do update set tipos = excluded.tipos, atualizado_em = now();
end $$;

create or replace function public.avisos_teste()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.pode_separar() then raise exception 'sem permissão'; end if;
  insert into avisos_eventos (tipo, email, titulo, corpo, url, tag)
  values ('teste', lower(auth.jwt() ->> 'email'), 'Nova Raphaella', 'Notificações funcionando neste aparelho ✅', '/#hoje', 'teste');
end $$;

-- ----- usados pela função de borda (somente service_role) -----
create or replace function public.avisos_pegar()
returns setof public.avisos_eventos language sql security definer set search_path = public as $$
  update avisos_eventos set enviado_em = now()
   where id in (select id from avisos_eventos where enviado_em is null order by id limit 200 for update skip locked)
  returning *;
$$;

create or replace function public.avisos_destinos(p_tipo text, p_email text)
returns table (id bigint, email text, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select a.id, a.email, a.endpoint, a.p256dh, a.auth
    from avisos_aparelhos a
    join usuarios_permitidos u on lower(u.email) = a.email
   where (p_email is null or a.email = lower(p_email))
     and (p_tipo = 'teste' or (p_tipo = any(public.avisos_tipos_do(a.email))
          and p_tipo = any(coalesce((select p.tipos from avisos_prefs p where p.email = a.email), public.avisos_tipos_do(a.email)))));
$$;

create or replace function public.avisos_falhou(p_id bigint)
returns void language sql security definer set search_path = public as $$
  with u as (update avisos_aparelhos set falhas = falhas + 1 where id = p_id returning id, falhas)
  delete from avisos_aparelhos a using u where a.id = u.id and u.falhas >= 10;
$$;

-- ----- eventos -----
create or replace function public.avisos_brl(v numeric)
returns text language sql immutable set search_path = public as $$
  select 'R$ ' || replace(replace(replace(to_char(coalesce(v, 0), 'FM999G999G990D00'), '.', '#'), ',', '.'), '#', ',');
$$;

-- venda nova nos marketplaces (pedidos que o Bling traz a cada 2 minutos)
create or replace function public.avisos_tg_pedido()
returns trigger language plpgsql security definer set search_path = public as $$
declare hoje date := (now() at time zone 'America/Sao_Paulo')::date; n int;
begin
  if new.data is null or new.data < hoje - 1 or new.ignorado_em is not null or coalesce(new.situacao, '') ~* 'cancel' then return new; end if;
  n := coalesce(jsonb_array_length(case when jsonb_typeof(new.itens) = 'array' then new.itens else '[]'::jsonb end), 0);
  insert into avisos_eventos (tipo, titulo, corpo, url, tag)
  values ('venda_mkt', 'Venda nova · ' || coalesce(new.canal, 'online'),
          avisos_brl(new.total) || case when n > 0 then ' · ' || n || case when n > 1 then ' itens' else ' item' end else '' end
            || case when coalesce(new.cliente, '') <> '' then ' · ' || split_part(new.cliente, ' ', 1) else '' end,
          '/#separacao', 'venda-' || new.id);
  return new;
end $$;
drop trigger if exists avisos_pedido on public.pedidos_online;
create trigger avisos_pedido after insert on public.pedidos_online for each row execute function public.avisos_tg_pedido();

-- envio ao Gestão / caixas terminou (gravado ou erro) e envio segurado pela trava
create or replace function public.avisos_tg_fila()
returns trigger language plpgsql security definer set search_path = public as $$
declare pos text;
begin
  if new.tipo in ('teste', 'diagnostico', 'etiqueta', 'impressoras') then return new; end if;
  if tg_op = 'INSERT' then
    if new.status = 'aguardando' then
      insert into avisos_eventos (tipo, titulo, corpo, url, tag)
      values ('trava', '🔒 Envio segurado · Loja ' || new.loja_id, coalesce(new.titulo, new.tipo) || ' — ' || left(coalesce(new.trava_motivo, ''), 140), '/#hoje', 'trava-' || new.id);
    end if;
    return new;
  end if;
  if new.status is distinct from old.status and new.status in ('aplicado', 'erro') then
    if new.status = 'erro' and coalesce(new.resultado, '') like 'TRAVA DE SEGURANÇA%' then return new; end if;  -- recusado pelo administrador
    pos := substring(coalesce(new.resultado, '') from '(POS (OK|AVISO|ERRO):[^\r\n]*)');
    insert into avisos_eventos (tipo, titulo, corpo, url, tag)
    values ('carga',
            case when new.status = 'aplicado' then '✅ Gravado no Gestão · Loja ' || new.loja_id else '⚠️ Erro no Gestão · Loja ' || new.loja_id end,
            coalesce(new.titulo, new.tipo) || case when pos is not null then E'\n' || replace(replace(replace(pos, 'POS OK: ', 'caixas: '), 'POS AVISO: ', 'caixas — atenção: '), 'POS ERRO: ', 'caixas NÃO atualizados: ') else '' end,
            case when new.tipo in ('entrada', 'precos') then '/#notas' else '/#hoje' end, 'carga-' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists avisos_fila on public.fila;
create trigger avisos_fila after insert or update of status on public.fila for each row execute function public.avisos_tg_fila();

-- promoções seguradas (um aviso por lote salvo)
create or replace function public.avisos_tg_promo()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from novas where status = 'aguardando';
  if n > 0 then
    insert into avisos_eventos (tipo, titulo, corpo, url, tag)
    values ('trava', '🔒 Promoção segurada', n || ' promoção(ões) com desconto acima de 50% aguardando sua liberação', '/#promocoes', 'trava-promo');
  end if;
  return null;
end $$;
drop trigger if exists avisos_promo on public.promocoes;
create trigger avisos_promo after insert on public.promocoes referencing new table as novas for each statement execute function public.avisos_tg_promo();

-- boletos sem marcar como pago: de manhã (vencem hoje + vencidos) e no fim da tarde (o que ainda ficou)
create or replace function public.avisos_boletos(p_momento text)
returns text language plpgsql security definer set search_path = public as $$
declare hoje date := (now() at time zone 'America/Sao_Paulo')::date; nh int; vh numeric; nv int; vv numeric; lista text; corpo text; tit text;
begin
  with b as (
    select d.dados ->> 'emit' as forn, (x ->> 'venc')::date as venc,
           coalesce((x ->> 'valor')::numeric, 0) * case when (x ->> 'nf') is not null and coalesce((d.dados -> 'cfg' ->> 'fb')::numeric, 1) > 1 then (d.dados -> 'cfg' ->> 'fb')::numeric else 1 end as valor
      from docs d, jsonb_array_elements(case when jsonb_typeof(d.dados -> 'boletos') = 'array' then d.dados -> 'boletos' else '[]'::jsonb end) x
     where d.colecao = 'notas' and coalesce(x ->> 'pago', '') = '' and coalesce(x ->> 'venc', '') ~ '^\d{4}-\d{2}-\d{2}'
  ), v as (select * from b where venc <= hoje), top as (select * from v order by (venc = hoje) desc, valor desc limit 5)
  select (select count(*) from v where venc = hoje), (select sum(valor) from v where venc = hoje),
         (select count(*) from v where venc < hoje), (select sum(valor) from v where venc < hoje),
         (select string_agg('• ' || left(coalesce(forn, '?'), 26) || ' ' || avisos_brl(valor) || case when venc < hoje then ' (venceu ' || to_char(venc, 'DD/MM') || ')' else '' end, E'\n' order by (venc = hoje) desc, valor desc) from top)
    into nh, vh, nv, vv, lista;
  if coalesce(nh, 0) + coalesce(nv, 0) = 0 then return 'nada'; end if;
  corpo := lista || case when nh + nv > 5 then E'\n+ ' || (nh + nv - 5) || ' outro(s)' else '' end;
  tit := case when p_momento = 'tarde' then 'Ainda sem marcar como pago'
              when nh > 0 then 'Boletos de hoje' else 'Boletos vencidos sem marcar como pago' end
         || ': ' || (nh + nv) || ' · ' || avisos_brl(coalesce(vh, 0) + coalesce(vv, 0));
  insert into avisos_eventos (tipo, titulo, corpo, url, tag) values ('boletos', tit, corpo, '/#boletos', 'boletos-' || p_momento);
  return 'ok';
end $$;

-- resumo das vendas do dia (lojas + marketplaces)
create or replace function public.avisos_resumo()
returns text language plpgsql security definer set search_path = public as $$
declare hoje date := (now() at time zone 'America/Sao_Paulo')::date; l1 numeric; l2 numeric; n1 int; n2 int; s1 numeric; s2 numeric; mk text; mkt numeric; corpo text;
begin
  select sum(total) filter (where loja_id = 1), sum(total) filter (where loja_id = 2), count(*) filter (where loja_id = 1), count(*) filter (where loja_id = 2)
    into l1, l2, n1, n2 from cupons where data = hoje and not coalesce(cancelado, false) and not coalesce(gemeo, false);
  select sum(total) filter (where loja_id = 1), sum(total) filter (where loja_id = 2)
    into s1, s2 from cupons where data = hoje - 7 and not coalesce(cancelado, false) and not coalesce(gemeo, false);
  select string_agg(canal || ' ' || avisos_brl(t) || ' (' || n || ')', ' · ' order by t desc), sum(t) into mk, mkt
    from (select coalesce(canal, 'online') canal, sum(total) t, count(*) n from pedidos_online
           where data = hoje and ignorado_em is null and coalesce(situacao, '') !~* 'cancel' group by 1) z;
  if coalesce(l1, 0) + coalesce(l2, 0) + coalesce(mkt, 0) = 0 then return 'sem vendas'; end if;
  corpo := 'Loja 1: ' || avisos_brl(l1) || ' (' || coalesce(n1, 0) || ' cupons)' || case when s1 > 0 then ' · ' || case when l1 >= s1 then '+' else '' end || round((coalesce(l1, 0) / s1 - 1) * 100) || '% vs semana passada' else '' end
        || E'\nLoja 2: ' || avisos_brl(l2) || ' (' || coalesce(n2, 0) || ' cupons)' || case when s2 > 0 then ' · ' || case when l2 >= s2 then '+' else '' end || round((coalesce(l2, 0) / s2 - 1) * 100) || '% vs semana passada' else '' end
        || E'\nOnline: ' || coalesce(mk, 'nenhuma venda');
  insert into avisos_eventos (tipo, titulo, corpo, url, tag)
  values ('resumo', 'Vendas de hoje: ' || avisos_brl(coalesce(l1, 0) + coalesce(l2, 0) + coalesce(mkt, 0)), corpo, '/#hoje', 'resumo-' || hoje);
  return 'ok';
end $$;

-- chama a função de borda quando há evento pendente
create or replace function public.avisos_cron()
returns text language plpgsql security definer set search_path = public, extensions as $$
declare t text; r extensions.http_response;
begin
  if not exists (select 1 from avisos_eventos where enviado_em is null) then return 'nada'; end if;
  select cron_token into t from bling_auth where id = 1;
  if t is null then return 'sem token'; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '50');
  r := extensions.http(('POST', 'https://nzecxuuzszkrzukkbaqx.supabase.co/functions/v1/avisos',
        array[extensions.http_header('x-cron-token', t)], 'application/json', '{"acao":"enviar"}')::extensions.http_request);
  return r.status || ' ' || left(r.content, 300);
end $$;

-- permissões
revoke execute on function public.avisos_tipos_do(text), public.avisos_pegar(), public.avisos_falhou(bigint), public.avisos_destinos(text, text), public.avisos_tg_pedido(),
  public.avisos_tg_fila(), public.avisos_tg_promo(), public.avisos_boletos(text), public.avisos_resumo(), public.avisos_cron() from public, anon, authenticated;
grant execute on function public.avisos_pegar(), public.avisos_destinos(text, text), public.avisos_falhou(bigint) to service_role;
revoke execute on function public.avisos_minhas(), public.avisos_inscrever(text, text, text, text), public.avisos_remover(bigint),
  public.avisos_salvar(text[]), public.avisos_teste() from public, anon;
grant execute on function public.avisos_minhas(), public.avisos_inscrever(text, text, text, text), public.avisos_remover(bigint),
  public.avisos_salvar(text[]), public.avisos_teste() to authenticated;

-- agendamentos (horário de Brasília = UTC-3)
select cron.schedule('avisos-enviar', '* * * * *', 'select public.avisos_cron()');
select cron.schedule('avisos-boletos-manha', '0 11 * * *', $$select public.avisos_boletos('manha')$$);
select cron.schedule('avisos-boletos-tarde', '30 20 * * *', $$select public.avisos_boletos('tarde')$$);
select cron.schedule('avisos-resumo-dia', '0 0 * * *', 'select public.avisos_resumo()');
