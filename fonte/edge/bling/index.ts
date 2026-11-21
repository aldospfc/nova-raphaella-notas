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
      const base = { ok: true, segredos: !!credenciais(), ligado: !!a.refresh_token, conectado_em: a.conectado_em || null, conectado_por: a.conectado_por || null, ultimo_erro: a.ultimo_erro || null };
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
    if (acao === "unificar") {
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
            ...(primeira ? { inicio_em: new Date().toISOString(), criado_por: email, criado_bling: criado } : {}), saldo_bling: saldo, ultimo_erro: null, atualizado_em: new Date().toISOString() }) });
          await rest("estoque_unificado_mov", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ean, origem, lado: "bling", operacao: op, quantidade: qtd, custo: custo ?? null, obs, por: email }) });
          res.push({ ean, ok: true, primeira, criado, bling_id: prod.id, codigo: prod.codigo || null, saldo, custo: custoSt });
        } catch (e) {
          res.push({ ean, ok: false, msg: String((e as Error).message).slice(0, 300) });
          await rest("estoque_unificado_mov", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ean: ean || "?", origem, lado: "bling", operacao: "?", quantidade: qtd || 0, obs, por: email, ok: false, erro: String((e as Error).message).slice(0, 300) }) }).catch(() => {});
        }
        await espera(340);
      }
      return resp({ ok: true, deposito: dep, fornecedor: forn ? { id: forn.id, criado: forn.criado } : null, fornecedor_erro: fornErro || null, itens: res });
    }
    return resp({ ok: false, erro: "acao", msg: "ação desconhecida: " + acao }, 400);
  } catch (e) {
    return resp({ ok: false, erro: "falha", msg: String((e as Error).message).slice(0, 500) });
  }
});
