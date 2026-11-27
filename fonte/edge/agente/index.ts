// Função que atende o agente instalado em cada loja.
// O agente se identifica pelo token da loja; a função grava com a chave de serviço.
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  let corpo: any;
  try { corpo = await req.json(); } catch { return json({ erro: "JSON inválido" }, 400); }
  const { token, acao, dados } = corpo ?? {};
  if (!token || !acao) return json({ erro: "faltam token e acao" }, 400);

  const { data: loja } = await sb.from("lojas").select("id, nome").eq("token", token).maybeSingle();
  if (!loja) return json({ erro: "token não reconhecido" }, 401);
  const loja_id = loja.id;

  try {
    if (acao === "heartbeat") {
      await sb.from("lojas").update({ ultimo_contato: new Date().toISOString(), versao_agente: dados?.versao ?? null, info: dados ?? null }).eq("id", loja_id);
      return json({ ok: true, loja: loja.nome });
    }

    if (acao === "produtos") {
      const linhas = Array.isArray(dados) ? dados : [];
      if (linhas.length > 1000) return json({ erro: "máximo 1000 produtos por chamada" }, 400);
      const agora = new Date().toISOString();
      const rows = linhas.map((p: any) => ({
        loja_id, id_gestao: p.id, codigo_interno: p.ci ?? null, ean: p.ean ?? null, descricao: p.desc ?? null,
        estoque: p.est ?? null, preco_compra: p.pc ?? null, preco_venda: p.pv ?? null, custo_medio: p.cm ?? null,
        grupo: p.g ?? null, departamento: p.d ?? null, sessao: p.s ?? null, familia: p.f ?? null, ncm: p.ncm ?? null,
        ativo: p.at == null ? null : p.at == 1, ult_alt_preco: p.uap || null, ult_alteracao: p.ua || null, atualizado_em: agora,
      }));
      if (rows.length) {
        const { error } = await sb.from("produtos").upsert(rows, { onConflict: "loja_id,id_gestao" });
        if (error) return json({ erro: error.message }, 500);
      }
      return json({ ok: true, gravados: rows.length });
    }

    if (acao === "remover_produtos") {
      const ids = Array.isArray(dados) ? dados.map(Number).filter((n: number) => n > 0) : [];
      if (ids.length) {
        const { error } = await sb.from("produtos").delete().eq("loja_id", loja_id).in("id_gestao", ids);
        if (error) return json({ erro: error.message }, 500);
      }
      return json({ ok: true, removidos: ids.length });
    }

    if (acao === "listas") {
      const linhas = Array.isArray(dados) ? dados : [];
      const rows = linhas.map((l: any) => ({ loja_id, tipo: l.t, id: l.id, descricao: l.desc ?? null, pai: l.pai ?? null }));
      const del = await sb.from("listas").delete().eq("loja_id", loja_id);
      if (del.error) return json({ erro: del.error.message }, 500);
      if (rows.length) {
        const { error } = await sb.from("listas").insert(rows);
        if (error) return json({ erro: error.message }, 500);
      }
      return json({ ok: true, gravados: rows.length });
    }

    // Códigos auxiliares (segundo código de barras do mesmo produto) — vão inteiros quando mudam
    if (acao === "auxiliares") {
      const linhas = Array.isArray(dados) ? dados : [];
      const agora = new Date().toISOString();
      const vistos = new Set<string>();
      const rows: any[] = [];
      for (const a of linhas) {
        const ean = String(a.ean ?? "").trim(), idp = Number(a.id);
        if (!ean || !(idp > 0) || vistos.has(ean)) continue;
        vistos.add(ean); rows.push({ loja_id, ean_aux: ean, id_produto: idp, atualizado_em: agora });
      }
      const del = await sb.from("auxiliares").delete().eq("loja_id", loja_id);
      if (del.error) return json({ erro: del.error.message }, 500);
      for (let i = 0; i < rows.length; i += 1000) {
        const { error } = await sb.from("auxiliares").insert(rows.slice(i, i + 1000));
        if (error) return json({ erro: error.message }, 500);
      }
      return json({ ok: true, gravados: rows.length });
    }

    // Pares NCM -> CEST usados no cadastro do Gestão (para sugerir o CEST na entrada manual)
    if (acao === "ncm_cest") {
      const linhas = Array.isArray(dados) ? dados : [];
      const rows: any[] = [], vistos = new Set<string>();
      for (const l of linhas) {
        const ncm = String(l.ncm ?? "").replace(/\D/g, ""), cest = String(l.cest ?? "").replace(/\D/g, "");
        if (ncm.length < 4 || !cest || vistos.has(ncm + "|" + cest)) continue;
        vistos.add(ncm + "|" + cest); rows.push({ loja_id, ncm, cest, qtd: Number(l.qtd) || 0 });
      }
      const del = await sb.from("ncm_cest").delete().eq("loja_id", loja_id);
      if (del.error) return json({ erro: del.error.message }, 500);
      for (let i = 0; i < rows.length; i += 1000) {
        const { error } = await sb.from("ncm_cest").insert(rows.slice(i, i + 1000));
        if (error) return json({ erro: error.message }, 500);
      }
      return json({ ok: true, gravados: rows.length });
    }

    if (acao === "publicar_site") {
      const { nome, conteudo, tipo } = dados ?? {};
      if (!nome || !/^[\w.-]+$/.test(nome) || typeof conteudo !== "string" || !conteudo.length) return json({ erro: "nome ou conteúdo inválido" }, 400);
      const { error } = await sb.from("site_arquivos").upsert({ nome, conteudo, tipo: tipo || "text/html; charset=utf-8", atualizado_em: new Date().toISOString(), origem: loja.nome });
      if (error) return json({ erro: error.message }, 500);
      return json({ ok: true, bytes: conteudo.length });
    }

    if (acao === "atualizacao") {
      // o agente pergunta qual é a versão atual; se a dele for outra, recebe os arquivos novos
      const { data, error } = await sb.from("agente_arquivos").select("nome, conteudo, versao");
      if (error) return json({ erro: error.message }, 500);
      const alvo = (data ?? []).find((a: any) => a.nome === "agente.ps1")?.versao ?? null;
      if (!alvo || alvo === dados?.versao) return json({ ok: true, versao: alvo });
      return json({ ok: true, versao: alvo, arquivos: (data ?? []).map((a: any) => ({ nome: a.nome, conteudo: a.conteudo })) });
    }

    if (acao === "backup") {
      // cópia de segurança: tudo o que só existe na nuvem (notas, boletos, validades) e os arquivos do sistema
      const tudo: any = { ok: true, gerado_em: new Date().toISOString(), loja: loja.nome, docs: [], site: [], agente: [] };
      for (let i = 0; ; i += 1000) {
        const { data, error } = await sb.from("docs").select("path, colecao, dados, atualizado_em").order("path").range(i, i + 999);
        if (error) return json({ erro: error.message }, 500);
        tudo.docs.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      const s = await sb.from("site_arquivos").select("nome, conteudo, atualizado_em");
      if (s.error) return json({ erro: s.error.message }, 500);
      tudo.site = s.data ?? [];
      const a = await sb.from("agente_arquivos").select("nome, conteudo, versao");
      tudo.agente = a.data ?? [];
      // registra quando a loja baixou a cópia (o painel "Sistema" avisa se ficar mais de um dia sem)
      await sb.from("lojas").update({ backup_em: new Date().toISOString() }).eq("id", loja_id);
      return json(tudo);
    }

    if (acao === "fila_pegar") {
      // pega e marca em uma operação só (dois ouvintes não levam o mesmo pedido)
      const { data, error } = await sb.rpc("fila_pegar_proximo", { p_loja: loja_id });
      if (error) return json({ erro: error.message }, 500);
      const item = Array.isArray(data) ? data[0] : data;
      return json({ ok: true, item: item ?? null });
    }

    if (acao === "fila_concluir") {
      const { id, sucesso, resultado } = dados ?? {};
      if (!id) return json({ erro: "falta id" }, 400);
      const { error } = await sb.from("fila").update({ status: sucesso ? "aplicado" : "erro", aplicado_em: new Date().toISOString(), resultado: String(resultado ?? "").slice(0, 20000) }).eq("id", id).eq("loja_id", loja_id);
      if (error) return json({ erro: error.message }, 500);
      return json({ ok: true });
    }

    return json({ erro: "ação desconhecida: " + acao }, 400);
  } catch (e) {
    return json({ erro: String(e?.message ?? e) }, 500);
  }
});
