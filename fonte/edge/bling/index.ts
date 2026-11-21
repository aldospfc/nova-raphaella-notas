import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Ligação do sistema das lojas com o Bling (API v3, OAuth).
// - O aplicativo do Bling é do Aldo; client id e secret ficam SÓ nos segredos do Supabase: BLING_CLIENT_ID e BLING_CLIENT_SECRET.
// - Tokens ficam na tabela bling_auth (sem acesso pelo site); o acesso dura 6 h e é renovado sozinho com o refresh token.
// - O Bling redireciona para esta mesma URL com ?code=...&state=... depois que o Aldo autoriza (link gerado pela ação "link").
// - Ações do site (POST, usuário logado e permitido): link, status, depositos, produto (busca por EAN/SKU).
// v1 (20/11/2026): conexão e consultas.
// v2 (20/11/2026): checar (EANs no Bling + unificados) e unificar (cria cadastro básico se faltar, balanço na 1ª vez / entrada depois,
//     no depósito Geral; grava estoque_unificado e o histórico estoque_unificado_mov). O lado do Gestão é mandado pelo site, pela fila.
// v3 (20/11/2026): custo vai pelo vínculo produto × fornecedor (o Bling só guarda custo assim). Fornecedor achado pelo CNPJ;
//     se não existir, é cadastrado com os dados do XML (tabela fornecedores). Regra do Aldo: custo só sobe (se o da nota for menor, mantém).
// v4 (21/11/2026): sincronizar (de 5 em 5 min pelo pg_cron, ou pelo botão do site):
//     - venda da Loja 1 (cupons) de produto unificado → saída no Bling (cupom cancelado depois → volta como entrada);
//     - mudança de saldo no Bling feita fora daqui (venda online, kit, ajuste) → soma/subtrai no Gestão da Loja 1 pela fila.
//     Trava em bling_auth.sync_trava para o envio de nota e a sincronização não rodarem juntos (senão a entrada da nota viraria "venda online").
// v5 (21/11/2026): entrada gravada no Gestão da Loja 1 (fila tipo 'entrada', aplicada) com produto já unificado entra sozinha no Bling
//     (operação E, custo pelo fornecedor da nota); controle em estoque_unificado_nota (uma linha por pedido da fila; refaz só o que deu erro, até 5 vezes).
//     acertar: quando Bling e Gestão ficam diferentes, o Aldo escolhe o lado certo; o outro passa a ter o mesmo saldo
//     (para="bling": balanço no Bling com o saldo do Gestão; para="gestao": sincroniza antes e grava no Gestão o saldo do Bling).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const resp = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const API = "https://api.bling.com.br/Api/v3";
const AUTORIZA = "https://www.bling.com.br/Api/v3/oauth/authorize";
const URL_SB = Deno.env.get("SUPABASE_URL")!, SERVICO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

// --- tabela bling_auth pela API REST com a chave de serviço ---
async function lerAuth(): Promise<any> {
  const r = await fetch(URL_SB + "/rest/v1/bling_auth?id=eq.1&select=*", { headers: { apikey: SERVICO, Authorization: "Bearer " + SERVICO } });
  const j = await r.json(); return (j && j[0]) || {};
}
async function gravarAuth(p: Record<string, unknown>) {
  await fetch(URL_SB + "/rest/v1/bling_auth?id=eq.1", {
    method: "PATCH", headers: { apikey: SERVICO, Authorization: "Bearer " + SERVICO, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ ...p, atualizado_em: new Date().toISOString() }),
  });
}
function credenciais() {
  const id = Deno.env.get("BLING_CLIENT_ID"), sec = Deno.env.get("BLING_CLIENT_SECRET");
  return id && sec ? { id, sec } : null;
}
async function pedirToken(corpo: Record<string, string>) {
  const c = credenciais(); if (!c) throw new Error("faltam os segredos BLING_CLIENT_ID / BLING_CLIENT_SECRET no Supabase");
  const r = await fetch(API + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "1.0", Authorization: "Basic " + btoa(c.id + ":" + c.sec) },
    body: new URLSearchParams(corpo).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Bling recusou o token: " + JSON.stringify(j).slice(0, 300));
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: new Date(Date.now() + (Number(j.expires_in) || 21600) * 1000).toISOString() };
}
// devolve um access token válido (renova se faltar menos de 10 min)
async function token(): Promise<string> {
  const a = await lerAuth();
  if (!a.refresh_token) throw new Error("o sistema ainda não está ligado ao Bling");
  if (a.access_token && a.expires_at && new Date(a.expires_at).getTime() - Date.now() > 10 * 60 * 1000) return a.access_token;
  try {
    const t = await pedirToken({ grant_type: "refresh_token", refresh_token: a.refresh_token });
    await gravarAuth({ ...t, ultimo_erro: null });
    return t.access_token;
  } catch (e) { await gravarAuth({ ultimo_erro: String((e as Error).message) }); throw e; }
}
export async function bling(caminho: string, init: RequestInit = {}): Promise<any> {
  const t = await token();
  const r = await fetch(API + caminho, { ...init, headers: { Authorization: "Bearer " + t, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) } });
  const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = { texto: txt }; }
  if (!r.ok) throw new Error(`Bling ${r.status}: ${JSON.stringify(j?.error || j).slice(0, 400)}`);
  return j;
}

// --- tabelas do estoque unificado (chave de serviço) ---
async function rest(caminho: string, init: RequestInit = {}) {
  const r = await fetch(URL_SB + "/rest/v1/" + caminho, { ...init, headers: { apikey: SERVICO, Authorization: "Bearer " + SERVICO, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text(); if (!r.ok) throw new Error("banco: " + t.slice(0, 200)); return t ? JSON.parse(t) : null;
}
const espera = (ms: number) => new Promise(r => setTimeout(r, ms));
let depCache: any = null;
async function depositoGeral(): Promise<{ id: number; nome: string }> {
  if (depCache) return depCache;
  const d = ((await bling("/depositos?limite=100")).data || []).filter((x: any) => x.situacao !== 0);
  const g = d.find((x: any) => /geral/i.test(x.descricao || "")) || d.find((x: any) => x.padrao) || d[0];
  if (!g) throw new Error("nenhum depósito ativo no Bling");
  depCache = { id: g.id, nome: g.descricao }; return depCache;
}
async function buscarProduto(ean: string, codigo: string): Promise<any> {
  if (/^\d{8,14}$/.test(ean)) { const r = await bling(`/produtos?gtins[]=${encodeURIComponent(ean)}&criterio=2&limite=5`); const p = (r.data || []).find((x: any) => x.formato !== "E"); if (p) return p; await espera(340); }
  if (codigo) { const r = await bling(`/produtos?codigos[]=${encodeURIComponent(codigo)}&criterio=2&limite=5`); const p = (r.data || []).find((x: any) => x.formato !== "E" && (!x.gtin || x.gtin === ean)); if (p) return p; }
  return null;
}
async function saldoDeposito(idProduto: number, idDep: number): Promise<number | null> {
  const r = await bling(`/estoques/saldos?idsProdutos[]=${idProduto}`);
  const s = (r.data || [])[0]; if (!s) return null;
  const d = (s.depositos || []).find((x: any) => x.id === idDep);
  return d ? Number(d.saldoFisico) : Number(s.saldoFisicoTotal ?? 0);
}
// fornecedor no Bling pelo CNPJ; cadastra com os dados do XML se faltar
const fornCache: Record<string, number> = {};
let tipoFornId: number | null | undefined;
async function fornecedorBling(cnpj: string): Promise<{ id: number; criado: boolean } | null> {
  cnpj = String(cnpj || "").replace(/\D/g, ""); if (cnpj.length !== 14 && cnpj.length !== 11) return null;
  if (fornCache[cnpj]) return { id: fornCache[cnpj], criado: false };
  const r = await bling(`/contatos?numeroDocumento=${cnpj}&limite=5`); await espera(340);
  const c = (r.data || [])[0]; if (c) { fornCache[cnpj] = c.id; return { id: c.id, criado: false }; }
  const f = ((await rest(`fornecedores?select=*&cnpj=eq.${cnpj}`)) || [])[0];
  if (!f) throw new Error("fornecedor " + cnpj + " não está no Bling nem na aba Fornecedores");
  if (tipoFornId === undefined) { try { const t = await bling("/contatos/tipos"); tipoFornId = ((t.data || []).find((x: any) => /fornecedor/i.test(x.descricao || "")) || {}).id ?? null; } catch { tipoFornId = null; } await espera(340); }
  const corpo: any = { nome: f.razao, fantasia: f.fantasia || undefined, situacao: "A", tipo: cnpj.length === 14 ? "J" : "F", numeroDocumento: cnpj,
    ie: f.ie || undefined, indicadorIe: f.ie ? "1" : "9", telefone: f.fone || undefined, email: f.email || undefined,
    endereco: { geral: { endereco: f.logradouro || "", numero: f.numero || "", complemento: f.complemento || "", bairro: f.bairro || "", cep: f.cep || "", municipio: f.municipio || "", uf: f.uf || "" } },
    ...(tipoFornId ? { tiposContato: [{ id: tipoFornId }] } : {}) };
  const n = await bling("/contatos", { method: "POST", body: JSON.stringify(corpo) }); await espera(340);
  fornCache[cnpj] = n.data?.id; return { id: n.data?.id, criado: true };
}
// custo pelo vínculo produto × fornecedor: cria se não houver; se houver, só troca quando o novo custo é MAIOR
async function custoFornecedor(idProduto: number, idForn: number, custo: number, compra: number | undefined, codigo: string, descricao: string): Promise<string> {
  const l = await bling(`/produtos/fornecedores?idProduto=${idProduto}&idFornecedor=${idForn}&limite=5`); await espera(340);
  const v = (l.data || [])[0];
  if (!v) { await bling("/produtos/fornecedores", { method: "POST", body: JSON.stringify({ produto: { id: idProduto }, fornecedor: { id: idForn }, precoCusto: custo, ...(compra ? { precoCompra: compra } : {}), ...(codigo ? { codigo } : {}), ...(descricao ? { descricao: descricao.slice(0, 120) } : {}), padrao: true }) }); return "custo gravado"; }
  if (Number(v.precoCusto || 0) >= custo) return "custo mantido (o do Bling é maior ou igual)";
  await bling(`/produtos/fornecedores/${v.id}`, { method: "PUT", body: JSON.stringify({ produto: { id: idProduto }, fornecedor: { id: idForn }, precoCusto: custo, ...(compra ? { precoCompra: compra } : {}), codigo: v.codigo || codigo || undefined, descricao: v.descricao || descricao || undefined, padrao: v.padrao ?? true }) });
  return "custo atualizado (subiu)";
}

// --- trava: unificar e sincronizar nunca rodam juntos ---
async function travar(seg = 90): Promise<boolean> {
  const agora = new Date().toISOString(), ate = new Date(Date.now() + seg * 1000).toISOString();
  const r = await rest(`bling_auth?id=eq.1&or=(sync_trava.is.null,sync_trava.lt.${encodeURIComponent('"' + agora + '"')})`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ sync_trava: ate }) });
  return Array.isArray(r) && r.length === 1;
}
async function esperarTrava(maxSeg = 40, seg = 90): Promise<boolean> {
  const fim = Date.now() + maxSeg * 1000;
  while (Date.now() < fim) { if (await travar(seg)) return true; await espera(1500); }
  return false;
}
const destravar = () => rest("bling_auth?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ sync_trava: null }) }).catch(() => {});
const gSql = (x: string) => "'" + String(x).replace(/'/g, "''") + "'";
const nBr = (x: number) => String(Math.round(x * 1000) / 1000);

const nEan = (x: string) => String(x || "").replace(/\D/g, "").replace(/^0+/, "");
// entradas de nota já gravadas no Gestão da Loja 1 → entrada no Bling dos produtos unificados (antes de comparar os saldos)
async function entradasDeNotas(por: string, rel: any) {
  const a = await lerAuth(); if (!a.notas_desde) return;
  const un: any[] = (await rest("estoque_unificado?select=ean,cod_gestao,bling_id,deposito_id,inicio_em,descricao&ativo=eq.true&loja_id=eq.1")) || [];
  if (!un.length) return;
  const porCod = new Map<string, any>(); for (const u of un) { porCod.set(nEan(u.ean), u); if (u.cod_gestao) porCod.set(nEan(u.cod_gestao), u); }
  const filas: any[] = (await rest(`fila?select=id,titulo,conteudo,aplicado_em&loja_id=eq.1&tipo=eq.entrada&status=eq.aplicado&aplicado_em=gte.${encodeURIComponent(a.notas_desde)}&order=id.asc&limit=50`)) || [];
  if (!filas.length) return;
  const feitos: any[] = (await rest(`estoque_unificado_nota?select=fila_id,itens,tentativas,pendente&fila_id=in.(${filas.map(f => f.id).join(",")})`)) || [];
  const mf = new Map<number, any>(feitos.map(f => [Number(f.fila_id), f]));
  for (const f of filas) {
    const ja = mf.get(Number(f.id)); if (ja && (!ja.pendente || ja.tentativas >= 5)) continue;
    const qt = new Map<string, { u: any; q: number; v: number }>(), re = /ATUALIZAR_ESTOQUE \(1, 1, 1, '([^']+)', 'S', ([\d.]+), ([\d.]+),/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.conteudo || ""))) {
      const u = porCod.get(nEan(m[1])); if (!u) continue;
      if (u.inicio_em && new Date(f.aplicado_em) <= new Date(u.inicio_em)) continue; // a 1ª vez (balanço) já contou esta nota
      const o = qt.get(u.ean) || { u, q: 0, v: 0 }; o.q += Number(m[2]); o.v += Number(m[3]); qt.set(u.ean, o);
    }
    const res: Record<string, string> = { ...((ja && ja.itens) || {}) };
    if (qt.size) {
      const tit = String(f.titulo || "entrada").slice(0, 120);
      const cnpj = (/CNPJ (\d{14}|\d{11})/.exec(f.conteudo || "") || [])[1] || ((/CHAVE (\d{44})/.exec(f.conteudo || "") || [])[1] || "").slice(6, 20);
      let forn: { id: number; criado: boolean } | null = null, fornErro = "";
      if (cnpj) { try { forn = await fornecedorBling(cnpj); } catch (e) { fornErro = String((e as Error).message).slice(0, 120); } }
      for (const [ean, o] of qt) {
        if ((res[ean] || "").startsWith("ok")) continue;
        try {
          const custo = o.q > 0 ? Math.round(o.v / o.q * 10000) / 10000 : undefined;
          await bling("/estoques", { method: "POST", body: JSON.stringify({ produto: { id: o.u.bling_id }, deposito: { id: o.u.deposito_id }, operacao: "E", quantidade: o.q, ...(custo ? { custo } : {}), observacoes: ("Entrada no Gestão da Loja 1: " + tit).slice(0, 200) }) });
          await espera(340);
          // a entrada não é "mudança feita no Bling": o saldo de referência sobe junto, senão a sincronização mandaria de volta ao Gestão
          const at = ((await rest(`estoque_unificado?select=saldo_bling&ean=eq.${ean}`)) || [])[0];
          if (at && at.saldo_bling !== null && at.saldo_bling !== undefined) await rest(`estoque_unificado?ean=eq.${ean}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ saldo_bling: Number(at.saldo_bling) + o.q, atualizado_em: new Date().toISOString() }) });
          let cst = forn ? "" : (fornErro ? "sem custo: " + fornErro : "sem custo (nota sem fornecedor)");
          if (forn && custo) { try { cst = await custoFornecedor(o.u.bling_id, forn.id, custo, undefined, "", String(o.u.descricao || "")); } catch (e) { cst = "custo não gravado: " + String((e as Error).message).slice(0, 100); } }
          res[ean] = "ok " + nBr(o.q) + (cst ? " · " + cst : "");
          await rest("estoque_unificado_mov", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ean, origem: "nota", lado: "bling", operacao: "E", quantidade: o.q, custo: custo ?? null, obs: tit + " (automático)", por }) });
          rel.notas.push({ ean, nome: o.u.descricao, q: o.q, titulo: tit });
        } catch (e) { res[ean] = "erro: " + String((e as Error).message).slice(0, 200); rel.erros.push(`${ean} (nota): ${res[ean]}`); }
        await espera(340);
      }
    }
    await rest("estoque_unificado_nota?on_conflict=fila_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({
      fila_id: f.id, titulo: f.titulo, itens: res, tentativas: ((ja && ja.tentativas) || 0) + 1, pendente: Object.values(res).some(x => x.startsWith("erro")), em: new Date().toISOString() }) });
  }
}

async function sincronizar(por: string) {
  const rel: any = { itens: 0, vendas_loja: [], online: [], notas: [], erros: [] as string[] };
  await entradasDeNotas(por, rel);
  const itens: any[] = (await rest("estoque_unificado?select=*&ativo=eq.true&loja_id=eq.1")) || [];
  rel.itens = itens.length;
  if (!itens.length) return rel;
  // 1) saldos atuais no Bling (antes de lançar as vendas da loja)
  const saldo: Record<string, number> = {};
  for (let i = 0; i < itens.length; i += 50) {
    const parte = itens.slice(i, i + 50);
    const r = await bling(`/estoques/saldos?${parte.map(x => "idsProdutos[]=" + x.bling_id).join("&")}`);
    for (const s of (r.data || [])) {
      const it = parte.find(x => String(x.bling_id) === String(s.produto?.id)); if (!it) continue;
      const d = (s.depositos || []).find((x: any) => String(x.id) === String(it.deposito_id));
      saldo[it.ean] = Number(d ? d.saldoFisico : s.saldoFisicoTotal ?? 0);
    }
    await espera(340);
  }
  // 2) vendas da loja ainda não lançadas
  const pend: any[] = (await rest("rpc/estu_vendas_pendentes", { method: "POST", body: "{}" })) || [];
  const vend: Record<string, any> = {}; for (const p of pend) vend[p.ean] = p;
  const gestao: { cod: string; q: number; ean: string; nome: string }[] = [];
  for (const it of itens) {
    const b = saldo[it.ean];
    if (b === undefined) { rel.erros.push(`${it.ean}: sem saldo no Bling`); continue; }
    const base = it.saldo_bling === null || it.saldo_bling === undefined ? null : Number(it.saldo_bling);
    let novaBase = b; const alt: any = { atualizado_em: new Date().toISOString() };
    try {
      // mudança no Bling feita fora daqui → Gestão
      if (base !== null && Math.abs(b - base) > 0.0005) {
        const q = b - base;
        gestao.push({ cod: it.cod_gestao || it.ean, q, ean: it.ean, nome: it.descricao || "" });
        rel.online.push({ ean: it.ean, nome: it.descricao, q });
        await rest("estoque_unificado_mov", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ean: it.ean, origem: "bling", lado: "gestao", operacao: q > 0 ? "E" : "S", quantidade: Math.abs(q), obs: `saldo no Bling foi de ${nBr(base)} para ${nBr(b)} (venda online, kit ou ajuste)`, por }) });
      }
      // venda (ou cancelamento) na loja → Bling
      const v = vend[it.ean];
      if (v && Number(v.dif) !== 0) {
        const q = Number(v.dif);
        await bling("/estoques", { method: "POST", body: JSON.stringify({ produto: { id: it.bling_id }, deposito: { id: it.deposito_id }, operacao: q > 0 ? "S" : "E", quantidade: Math.abs(q), observacoes: q > 0 ? "Venda na Loja 1 (estoque unificado)" : "Cupom cancelado na Loja 1 (estoque unificado)" }) });
        await espera(340);
        await rest("rpc/estu_vendas_confirmar", { method: "POST", body: JSON.stringify({ p_ean: it.ean, p_chaves: v.chaves }) });
        novaBase = b - q;
        rel.vendas_loja.push({ ean: it.ean, nome: it.descricao, q });
        await rest("estoque_unificado_mov", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ean: it.ean, origem: "loja", lado: "bling", operacao: q > 0 ? "S" : "E", quantidade: Math.abs(q), obs: `${(v.chaves || []).length} cupom(ns) da Loja 1`, por }) });
      }
      alt.ultimo_erro = null; alt.ultimo_acerto = new Date().toISOString();
    } catch (e) {
      alt.ultimo_erro = String((e as Error).message).slice(0, 300); rel.erros.push(`${it.ean}: ${alt.ultimo_erro}`);
    }
    alt.saldo_bling = novaBase;
    await rest(`estoque_unificado?ean=eq.${it.ean}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(alt) });
  }
  // 3) um pedido só para o Gestão com todas as mudanças vindas do Bling
  if (gestao.length) {
    const sql = ["/* ESTOQUE UNIFICADO: mudancas vindas do Bling (venda online, kit, ajuste) */"];
    for (const x of gestao) {
      const novo = "ESTOQUE_ATUAL + (" + nBr(x.q) + ")", onde = "CODIGO_BARRAS = " + gSql(x.cod);
      sql.push(`INSERT INTO HIST_ALT_ESTOQUE_MANUAL (ID_PRODUTO, F_ESTOQUE_ANTERIOR, F_ESTOQUE_NOVO, DH_OPERACAO, ID_USUARIO, ID_SUPERVISOR, ID_LOJA, S_ESTACAO) SELECT ID, ESTOQUE_ATUAL, ${novo}, CURRENT_TIMESTAMP, 1, 0, 0, 'ECOMMERCE-BLING' FROM PRODUTOS WHERE ${onde};`);
      sql.push(`UPDATE PRODUTOS SET ESTOQUE_ATUAL = ${novo}, ULT_ALTERACAO = CURRENT_DATE, ALT_PDV = 1 WHERE ${onde};`);
    }
    sql.push("SELECT CODIGO_BARRAS, SUBSTRING(DESCRICAO FROM 1 FOR 40) AS DESCRICAO, ESTOQUE_ATUAL FROM PRODUTOS WHERE CODIGO_BARRAS IN (" + gestao.map(x => gSql(x.cod)).join(",") + ");");
    const tit = "E-commerce: " + gestao.map(x => (x.q > 0 ? "+" : "") + nBr(x.q) + " " + (x.nome || x.ean).slice(0, 20)).join(", ");
    await rest("fila", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ loja_id: 1, tipo: "ecommerce", titulo: tit.slice(0, 110), conteudo: sql.join("\r\n") + "\r\nCOMMIT;\r\n", status: "pendente" }) });
  }
  await rest("rpc/estu_marcar_diferencas", { method: "POST", body: "{}" }).catch(() => {}); // para o aviso "diferente há mais de 20 min" da tela Hoje
  return rel;
}
const origemBling = (o: any) => { const n = Number(o); return n === 1 ? 2 : n === 6 ? 7 : (Number.isFinite(n) ? n : 0); }; // compra no mercado interno: 1→2, 6→7

function pagina(titulo: string, texto: string, ok: boolean) {
  const cor = ok ? "#1b7248" : "#b42318";
  return new Response(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title></head>
<body style="font-family:Nunito,Arial,sans-serif;background:#f5f7f9;margin:0;display:grid;place-items:center;min-height:100vh">
<div style="background:#fff;border:1px solid #dadfe4;border-radius:10px;padding:28px 32px;max-width:440px;text-align:center">
<div style="font-size:40px">${ok ? "✅" : "⚠️"}</div><h1 style="color:${cor};font-size:20px">${titulo}</h1><p style="color:#293343">${texto}</p>
<a href="https://notas.novaraphaella.com.br/#produtos" style="display:inline-block;margin-top:8px;background:#1b2d4b;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:700">Voltar ao sistema</a></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const u = new URL(req.url);

  // volta do Bling depois da autorização
  if (req.method === "GET" && (u.searchParams.get("code") || u.searchParams.get("error"))) {
    try {
      if (u.searchParams.get("error")) return pagina("Ligação não autorizada", "O Bling não autorizou o acesso. Tente de novo pelo botão no sistema.", false);
      const a = await lerAuth(), estado = u.searchParams.get("state") || "";
      if (!a.estado || a.estado !== estado || !a.estado_em || Date.now() - new Date(a.estado_em).getTime() > 30 * 60 * 1000)
        return pagina("Link vencido", "Esse link de autorização não vale mais. Gere outro pelo botão no sistema.", false);
      const t = await pedirToken({ grant_type: "authorization_code", code: u.searchParams.get("code")! });
      await gravarAuth({ ...t, conectado_em: new Date().toISOString(), conectado_por: a.estado_por, estado: null, ultimo_erro: null });
      return pagina("Sistema ligado ao Bling", "Pronto: o sistema das lojas já consegue consultar e lançar no Bling. Pode fechar esta aba.", true);
    } catch (e) { return pagina("Não deu certo", String((e as Error).message).slice(0, 300), false); }
  }
  if (req.method !== "POST") return resp({ ok: false, erro: "metodo" }, 405);

  // chamada do pg_cron (estu_sincronizar_cron): segredo próprio guardado só no banco
  const tokCron = req.headers.get("x-cron-token");
  if (tokCron) {
    const a = await lerAuth();
    if (!a.cron_token || tokCron !== a.cron_token) return resp({ ok: false, erro: "sem_permissao" }, 403);
    if (!(await travar())) return resp({ ok: true, pulou: "outra operação em andamento" });
    try {
      const rel = await sincronizar("automático");
      const m = `${rel.vendas_loja.length} venda(s) da loja → Bling; ${rel.online.length} mudança(s) do Bling → Gestão` + (rel.notas.length ? `; ${rel.notas.length} entrada(s) de nota → Bling` : "") + (rel.erros.length ? `; ${rel.erros.length} erro(s)` : "");
      await gravarAuth({ sync_em: new Date().toISOString(), sync_msg: m });
      return resp({ ok: true, ...rel });
    } catch (e) { await gravarAuth({ sync_em: new Date().toISOString(), sync_msg: "falhou: " + String((e as Error).message).slice(0, 200) }); return resp({ ok: false, msg: String((e as Error).message) }); }
    finally { await destravar(); }
  }

  try {
    const auth = req.headers.get("Authorization") || "";
    const p = await fetch(URL_SB + "/rest/v1/rpc/permitido", { method: "POST", headers: { apikey: ANON, Authorization: auth, "Content-Type": "application/json" }, body: "{}" });
    if (!p.ok || (await p.json()) !== true) return resp({ ok: false, erro: "sem_permissao", msg: "Entre no sistema de novo." }, 403);
    let email = ""; try { email = JSON.parse(atob(auth.replace(/^Bearer\s+/i, "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || ""; } catch { /* */ }

    const corpo = await req.json().catch(() => ({}));
    const acao = String(corpo?.acao || "");

    if (acao === "link") {
      const c = credenciais(); if (!c) return resp({ ok: false, erro: "sem_segredos", msg: "Cadastre os segredos BLING_CLIENT_ID e BLING_CLIENT_SECRET no Supabase primeiro." });
      const estado = crypto.randomUUID().replace(/-/g, "");
      await gravarAuth({ estado, estado_em: new Date().toISOString(), estado_por: email });
      return resp({ ok: true, url: `${AUTORIZA}?response_type=code&client_id=${encodeURIComponent(c.id)}&state=${estado}` });
    }
    if (acao === "status") {
      const a = await lerAuth();
      const base = { ok: true, segredos: !!credenciais(), ligado: !!a.refresh_token, conectado_em: a.conectado_em || null, conectado_por: a.conectado_por || null, ultimo_erro: a.ultimo_erro || null, sync_em: a.sync_em || null, sync_msg: a.sync_msg || null };
      if (!a.refresh_token) return resp(base);
      try { const d = await bling("/depositos?limite=100"); return resp({ ...base, teste: "ok", depositos: (d.data || []).map((x: any) => ({ id: x.id, nome: x.descricao, padrao: x.padrao, situacao: x.situacao })) }); }
      catch (e) { return resp({ ...base, teste: "erro", msg: String((e as Error).message) }); }
    }
    if (acao === "produto") {
      // busca por código (SKU) ou GTIN; devolve os encontrados com saldo
      const q = String(corpo?.q || "").trim(); if (!q) return resp({ ok: false, msg: "informe o código ou EAN" });
      const por = /^\d{8,14}$/.test(q) ? "gtins[]=" + encodeURIComponent(q) : "codigos[]=" + encodeURIComponent(q);
      const r = await bling(`/produtos?${por}&criterio=5&limite=20`);
      return resp({ ok: true, produtos: (r.data || []).map((x: any) => ({ id: x.id, codigo: x.codigo, nome: x.nome, preco: x.preco, precoCusto: x.precoCusto, gtin: x.gtin, formato: x.formato, situacao: x.situacao, estoque: x.estoque?.saldoVirtualTotal ?? null })) });
    }
    if (acao === "checar") {
      // para cada EAN: existe no Bling? já é unificado?
      const eans: string[] = [...new Set((corpo?.eans || []).map((e: any) => String(e || "").trim()).filter((e: string) => /^\d{8,14}$/.test(e)))].slice(0, 300) as string[];
      const out: Record<string, any> = {};
      for (let i = 0; i < eans.length; i += 50) {
        const parte = eans.slice(i, i + 50);
        const r = await bling(`/produtos?${parte.map(e => "gtins[]=" + e).join("&")}&criterio=2&limite=100`);
        for (const x of (r.data || [])) if (x.gtin && x.formato !== "E" && !out[x.gtin]) out[x.gtin] = { id: x.id, codigo: x.codigo, nome: x.nome, saldo: x.estoque?.saldoVirtualTotal ?? null };
        await espera(340);
      }
      const un = eans.length ? await rest(`estoque_unificado?select=ean,ativo,bling_id&ean=in.(${eans.join(",")})`) : [];
      const uni: Record<string, boolean> = {}; for (const u of un || []) uni[u.ean] = !!u.ativo;
      const dep = await depositoGeral().catch(() => null);
      return resp({ ok: true, deposito: dep, itens: Object.fromEntries(eans.map(e => [e, { bling: out[e] || null, unificado: !!uni[e] }])) });
    }
    if (acao === "sincronizar") {
      if (!(await esperarTrava(30))) return resp({ ok: false, msg: "Outra operação com o Bling está em andamento. Tente de novo em um minuto." });
      try {
        const rel = await sincronizar(email);
        await gravarAuth({ sync_em: new Date().toISOString(), sync_msg: `${rel.vendas_loja.length} venda(s) da loja → Bling; ${rel.online.length} mudança(s) do Bling → Gestão` + (rel.notas.length ? `; ${rel.notas.length} entrada(s) de nota → Bling` : "") + (rel.erros.length ? `; ${rel.erros.length} erro(s)` : "") });
        return resp({ ok: true, ...rel });
      } finally { await destravar(); }
    }
    if (acao === "acertar") {
      const ean = String(corpo?.ean || "").trim(), para = corpo?.para === "gestao" ? "gestao" : "bling";
      const it = ((await rest(`estoque_unificado?select=*&ean=eq.${encodeURIComponent(ean)}&ativo=eq.true`)) || [])[0];
      if (!it) return resp({ ok: false, msg: "Produto não está no estoque unificado." });
      if (!(await esperarTrava(30))) return resp({ ok: false, msg: "Outra operação com o Bling está em andamento. Tente de novo em um minuto." });
      try {
        if (para === "bling") {
          const v = Number(corpo?.valor); if (!Number.isFinite(v) || v < 0) return resp({ ok: false, msg: "saldo do Gestão inválido" });
          await bling("/estoques", { method: "POST", body: JSON.stringify({ produto: { id: it.bling_id }, deposito: { id: it.deposito_id }, operacao: "B", quantidade: v, observacoes: "Acerto pelo saldo do Gestão da Loja 1 (estoque unificado)" }) });
          await rest(`estoque_unificado?ean=eq.${encodeURIComponent(ean)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ saldo_bling: v, ultimo_acerto: new Date().toISOString(), ultimo_erro: null, atualizado_em: new Date().toISOString() }) });
          await rest("estoque_unificado_mov", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ean, origem: "acerto", lado: "bling", operacao: "B", quantidade: v, obs: `Bling acertado pelo Gestão (antes ${nBr(Number(it.saldo_bling ?? 0))})`, por: email }) });
          return resp({ ok: true, para, saldo: v });
        }
        await sincronizar(email); // leva as vendas pendentes antes de copiar o saldo
        const saldo = await saldoDeposito(it.bling_id, it.deposito_id);
        if (saldo === null) return resp({ ok: false, msg: "O Bling não devolveu o saldo." });
        await rest(`estoque_unificado?ean=eq.${encodeURIComponent(ean)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ saldo_bling: saldo, ultimo_acerto: new Date().toISOString(), atualizado_em: new Date().toISOString() }) });
        const onde = "CODIGO_BARRAS = " + gSql(it.cod_gestao || it.ean), novo = nBr(saldo);
        const sql = ["/* ESTOQUE UNIFICADO: acerto do Gestao pelo saldo do Bling */",
          `INSERT INTO HIST_ALT_ESTOQUE_MANUAL (ID_PRODUTO, F_ESTOQUE_ANTERIOR, F_ESTOQUE_NOVO, DH_OPERACAO, ID_USUARIO, ID_SUPERVISOR, ID_LOJA, S_ESTACAO) SELECT ID, ESTOQUE_ATUAL, ${novo}, CURRENT_TIMESTAMP, 1, 0, 0, 'ECOMMERCE-BLING' FROM PRODUTOS WHERE ${onde} AND ESTOQUE_ATUAL <> ${novo};`,
          `UPDATE PRODUTOS SET ESTOQUE_ATUAL = ${novo}, ULT_ALTERACAO = CURRENT_DATE, ALT_PDV = 1 WHERE ${onde};`, "COMMIT;",
          `SELECT CODIGO_BARRAS, SUBSTRING(DESCRICAO FROM 1 FOR 40) AS DESCRICAO, ESTOQUE_ATUAL FROM PRODUTOS WHERE ${onde};`, ""];
        const fl = await rest("fila", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ loja_id: 1, tipo: "ecommerce", titulo: ("E-commerce: acerto " + (it.descricao || ean) + " = " + novo).slice(0, 110), conteudo: sql.join("\r\n"), status: "pendente" }) });
        await rest("estoque_unificado_mov", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ean, origem: "acerto", lado: "gestao", operacao: "B", quantidade: saldo, obs: "Gestão acertado pelo Bling", por: email }) });
        return resp({ ok: true, para, saldo, fila: fl && fl[0] ? fl[0].id : null });
      } finally { await destravar(); }
    }
    if (acao === "unificar") {
      if (!(await esperarTrava(40, 400))) return resp({ ok: false, msg: "A sincronização com o Bling está rodando. Tente de novo em um minuto." });
      try {
      const itens = (corpo?.itens || []).slice(0, 80), origem = corpo?.origem === "avulso" ? "avulso" : "nota", obs = String(corpo?.obs || "").slice(0, 200);
      const dep = await depositoGeral(); const res: any[] = [];
      let forn: { id: number; criado: boolean } | null = null, fornErro = "";
      if (corpo?.fornecedor_cnpj) { try { forn = await fornecedorBling(String(corpo.fornecedor_cnpj)); } catch (e) { fornErro = String((e as Error).message).slice(0, 200); } }
      for (const it of itens) {
        const ean = String(it.ean || "").trim(), qtd = Number(it.qtd);
        try {
          if (!/^\d{8,14}$/.test(ean)) throw new Error("sem EAN válido");
          if (!(qtd > 0)) throw new Error("quantidade inválida");
          const ja = ((await rest(`estoque_unificado?select=*&ean=eq.${ean}`)) || [])[0];
          let prod: any = ja && ja.ativo ? { id: ja.bling_id, codigo: ja.bling_codigo } : await buscarProduto(ean, String(it.codigo || ""));
          let criado = false; await espera(340);
          if (!prod) {
            const base: any = { nome: String(it.nome || "").slice(0, 120) || ean, tipo: "P", situacao: "A", formato: "S", unidade: "UN", condicao: "1", gtin: ean,
              preco: Number(it.preco) > 0 ? Math.round(Number(it.preco) * 100) / 100 : 0,
              tributacao: { origem: origemBling(it.origem), ...(it.ncm ? { ncm: String(it.ncm).replace(/\D/g, "") } : {}), ...(it.cest ? { cest: String(it.cest).replace(/\D/g, "") } : {}) },
              observacoes: "Cadastro básico criado pelo sistema das lojas" + (obs ? " (" + obs + ")" : "") + " — completar pela skill (descrição, fotos, kits)." };
            const cods = [String(it.codigo || "").trim(), ean].filter((c, i, a) => c && a.indexOf(c) === i);
            let ult: any = null;
            for (const cod of cods) { try { const c = await bling("/produtos", { method: "POST", body: JSON.stringify({ ...base, codigo: cod }) }); prod = { id: c.data?.id, codigo: cod }; break; } catch (e) { ult = e; await espera(340); } }
            if (!prod || !prod.id) throw ult || new Error("Bling não criou o produto");
            criado = true; await espera(340);
          }
          const primeira = !(ja && ja.ativo), op = primeira ? "B" : "E", custo = Number(it.custo) > 0 ? Math.round(Number(it.custo) * 10000) / 10000 : undefined;
          await bling("/estoques", { method: "POST", body: JSON.stringify({ produto: { id: prod.id }, deposito: { id: dep.id }, operacao: op, quantidade: qtd, ...(custo ? { custo } : {}), observacoes: (primeira ? "Início do estoque unificado. " : "") + (obs || origem) }) });
          await espera(340);
          let custoSt = forn ? "" : (fornErro ? "custo não gravado: " + fornErro : "custo não gravado (sem fornecedor)");
          if (forn && custo) { try { custoSt = await custoFornecedor(prod.id, forn.id, custo, Number(it.compra) > 0 ? Math.round(Number(it.compra) * 10000) / 10000 : undefined, String(it.codigo || ""), String(it.nome || "")); } catch (e) { custoSt = "custo não gravado: " + String((e as Error).message).slice(0, 160); } }
          const saldo = await saldoDeposito(prod.id, dep.id).catch(() => null);
          await rest("estoque_unificado?on_conflict=ean", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({
            ean, loja_id: 1, id_gestao: it.id_gestao ?? ja?.id_gestao ?? null, descricao: it.nome || ja?.descricao || null, bling_id: prod.id, bling_codigo: prod.codigo || null, deposito_id: dep.id, ativo: true,
            ...(primeira ? { inicio_em: new Date().toISOString(), criado_por: email, criado_bling: criado } : {}), saldo_bling: (!primeira && ja?.saldo_bling !== null && ja?.saldo_bling !== undefined) ? Number(ja.saldo_bling) + qtd : saldo, ultimo_erro: null, atualizado_em: new Date().toISOString() }) });
          await rest("estoque_unificado_mov", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ean, origem, lado: "bling", operacao: op, quantidade: qtd, custo: custo ?? null, obs, por: email }) });
          res.push({ ean, ok: true, primeira, criado, bling_id: prod.id, codigo: prod.codigo || null, saldo, custo: custoSt });
        } catch (e) {
          res.push({ ean, ok: false, msg: String((e as Error).message).slice(0, 300) });
          await rest("estoque_unificado_mov", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ean: ean || "?", origem, lado: "bling", operacao: "?", quantidade: qtd || 0, obs, por: email, ok: false, erro: String((e as Error).message).slice(0, 300) }) }).catch(() => {});
        }
        await espera(340);
      }
      return resp({ ok: true, deposito: dep, fornecedor: forn ? { id: forn.id, criado: forn.criado } : null, fornecedor_erro: fornErro || null, itens: res });
      } finally { await destravar(); }
    }
    return resp({ ok: false, erro: "acao", msg: "ação desconhecida: " + acao }, 400);
  } catch (e) {
    return resp({ ok: false, erro: "falha", msg: String((e as Error).message).slice(0, 500) });
  }
});
