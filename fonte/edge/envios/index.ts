import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { unzipSync, strFromU8 } from "https://esm.sh/fflate@0.8.2";

// Envios dos pedidos online (tela Separação).
// - Mercado Livre (API oficial, OAuth do aplicativo do Aldo): forma de envio (Flex, Agência, Coleta, Full), situação do envio
//   (pronto, enviado, entregue, cancelado) e prazo para o pacote sair. App id e secret SÓ nos segredos do Supabase: ML_CLIENT_ID e ML_CLIENT_SECRET.
//   O ML redireciona para esta mesma URL com ?code=...&state=... depois que o Aldo autoriza (link gerado pela ação "link").
// - Bling (token da função "bling", tabela bling_auth): nome do frete do pedido; na Shopee ele diz Entrega Direta / Shopee Xpress.
// - sync (pg_cron de 3 em 3 min, ou botão): atualiza os pedidos pendentes da tela. Pedido que o ML diz que já saiu (enviado/entregue)
//   vira "despachado" sozinho (a função "bling" passa para Atendido no Bling, regra do Aldo). Cancelado no ML fica marcado "Cancelada. Não enviar".
// v1 (22/11/2026).
// v2 (22/11/2026): nfe — gera a NF-e do pedido no Bling e transmite (o Bling manda a nota ao ML); etiqueta — etiqueta do ML em ZPL
//     (impressora Zebra pelo Browser Print) ou PDF; Shopee pelo Bling (logísticas/etiquetas).
// v3 (22/11/2026): nfe acha a nota gerada pelo próprio pedido quando o Bling não devolve o id.
// v4 (22/11/2026): sync com ids confere só esses pedidos (rápido, usado logo depois de emitir NF ou imprimir etiqueta).
// v5 (24/11/2026): sync também acompanha despachados de até 30 dias ainda não entregues no ML (a caminho → entregue; despachado sem ter saído).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const resp = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const URL_SB = Deno.env.get("SUPABASE_URL")!, SERVICO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ML = "https://api.mercadolibre.com", ML_AUTH = "https://auth.mercadolivre.com.br/authorization";
const REDIRECT = URL_SB + "/functions/v1/envios";
const LOJA_ML = 203783765;
const espera = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rest(caminho: string, init: RequestInit = {}) {
  const r = await fetch(URL_SB + "/rest/v1/" + caminho, { ...init, headers: { apikey: SERVICO, Authorization: "Bearer " + SERVICO, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text(); if (!r.ok) throw new Error("banco: " + t.slice(0, 200)); return t ? JSON.parse(t) : null;
}
const lerMl = async () => ((await rest("ml_auth?id=eq.1&select=*")) || [])[0] || {};
const gravarMl = (p: Record<string, unknown>) => rest("ml_auth?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...p, atualizado_em: new Date().toISOString() }) });
function credenciais() { const id = Deno.env.get("ML_CLIENT_ID"), sec = Deno.env.get("ML_CLIENT_SECRET"); return id && sec ? { id, sec } : null; }

async function pedirToken(corpo: Record<string, string>) {
  const c = credenciais(); if (!c) throw new Error("faltam os segredos ML_CLIENT_ID / ML_CLIENT_SECRET no Supabase");
  const r = await fetch(ML + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...corpo, client_id: c.id, client_secret: c.sec }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Mercado Livre recusou o token: " + JSON.stringify(j).slice(0, 300));
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: new Date(Date.now() + (Number(j.expires_in) || 21600) * 1000).toISOString(), user_id: j.user_id || null };
}
async function tokenMl(): Promise<string> {
  const a = await lerMl();
  if (!a.refresh_token) throw new Error("o sistema ainda não está ligado ao Mercado Livre");
  if (a.access_token && a.expires_at && new Date(a.expires_at).getTime() - Date.now() > 10 * 60 * 1000) return a.access_token;
  try { const t = await pedirToken({ grant_type: "refresh_token", refresh_token: a.refresh_token }); await gravarMl({ ...t, ultimo_erro: null }); return t.access_token; }
  catch (e) { await gravarMl({ ultimo_erro: String((e as Error).message).slice(0, 300) }); throw e; }
}
async function ml(caminho: string, extra: Record<string, string> = {}): Promise<any> {
  const t = await tokenMl();
  let r = await fetch(ML + caminho, { headers: { Authorization: "Bearer " + t, Accept: "application/json", ...extra } });
  if (r.status === 429) { await espera(1500); r = await fetch(ML + caminho, { headers: { Authorization: "Bearer " + t, Accept: "application/json", ...extra } }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e: any = new Error(`ML ${r.status}: ${JSON.stringify(j).slice(0, 200)}`); e.status = r.status; throw e; }
  return j;
}
// Bling: só leitura do pedido, com o token que a função "bling" mantém renovado
async function blingPedido(id: number): Promise<any> {
  const a = ((await rest("bling_auth?id=eq.1&select=access_token,expires_at")) || [])[0] || {};
  if (!a.access_token || new Date(a.expires_at).getTime() < Date.now() + 60000) return null;
  const r = await fetch(`https://api.bling.com.br/Api/v3/pedidos/vendas/${id}`, { headers: { Authorization: "Bearer " + a.access_token, Accept: "application/json" } });
  if (!r.ok) return null; return ((await r.json().catch(() => ({}))) || {}).data || null;
}

async function blingTok(): Promise<string> {
  const a = ((await rest("bling_auth?id=eq.1&select=access_token,expires_at")) || [])[0] || {};
  if (!a.access_token || new Date(a.expires_at).getTime() < Date.now() + 60000) throw new Error("o acesso ao Bling está sendo renovado — tente de novo em 1 minuto");
  return a.access_token;
}
async function bling(caminho: string, init: RequestInit = {}): Promise<any> {
  const t = await blingTok();
  let r = await fetch("https://api.bling.com.br/Api/v3" + caminho, { ...init, headers: { Authorization: "Bearer " + t, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) } });
  if (r.status === 429) { await espera(1200); r = await fetch("https://api.bling.com.br/Api/v3" + caminho, { ...init, headers: { Authorization: "Bearer " + t, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) } }); }
  const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = { texto: txt }; }
  if (!r.ok) { const f = (j?.error?.fields || []).map((x: any) => x.msg).filter(Boolean).join("; "); throw new Error(`Bling ${r.status}: ${f || j?.error?.description || j?.error?.message || JSON.stringify(j).slice(0, 200)}`); }
  return j;
}
const NFE_SIT: Record<number, string> = { 1: "pendente", 2: "cancelada", 3: "aguardando recibo", 4: "rejeitada", 5: "autorizada", 6: "emitida (DANFE)", 7: "registrada", 8: "aguardando protocolo", 9: "denegada", 10: "consultando situação", 11: "bloqueada" };
// gera (se faltar) e transmite a NF-e do pedido pelo Bling
async function emitirNfe(id: number): Promise<{ ok: boolean; msg: string; nf?: number }> {
  const ped = (await bling(`/pedidos/vendas/${id}`)).data || {}; await espera(350);
  let nf = Number(ped?.notaFiscal?.id) || 0;
  if (nf) { const n = (await bling(`/nfe/${nf}`)).data || {}; await espera(350); const st = Number(n.situacao);
    if ([5, 6, 7].includes(st)) return { ok: true, msg: "já tinha NF autorizada (nº " + (n.numero || "?") + ")", nf };
    if (st === 2 || st === 9) nf = 0; }
  if (!nf) {
    // 1º passo (como "Gerar nota fiscal" no pedido): cria a NF pendente no Bling
    const g = await bling(`/pedidos/vendas/${id}/gerar-nfe`, { method: "POST", body: "{}" }); await espera(800);
    nf = Number(g?.data?.id || g?.data?.idNotaFiscal || g?.data?.notaFiscal?.id || g?.id) || 0;
    if (!nf) { const p2 = (await bling(`/pedidos/vendas/${id}`)).data || {}; nf = Number(p2?.notaFiscal?.id) || 0; await espera(350); } // o pedido passa a apontar para a nota
    if (!nf) throw new Error("o Bling gerou a nota mas não informou qual — veja em Notas fiscais (pendentes) e clique de novo em Emitir NF");
  }
  // 2º passo (como selecionar a nota pendente e "Enviar"): transmite à SEFAZ
  await bling(`/nfe/${nf}/enviar`, { method: "POST", body: "{}" }); await espera(1500);
  const n = (await bling(`/nfe/${nf}`)).data || {}; const st = Number(n.situacao);
  await rest(`pedidos_online?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ nf_id: nf }) });
  return { ok: [5, 6, 7, 3, 8, 10].includes(st), msg: (NFE_SIT[st] || "situação " + st) + (n.numero ? " · NF nº " + n.numero : ""), nf };
}
// etiqueta: ML (ZPL ou PDF) pelos envios; Shopee pelo Bling
async function etiquetas(ids: number[], formato: string) {
  const ps: any[] = ids.length ? (await rest(`pedidos_online?select=id,loja_bling,ml_envio,numero_loja,cliente&id=in.(${ids.join(",")})`)) || [] : [];
  const mlEnv = ps.filter(p => Number(p.loja_bling) === LOJA_ML && p.ml_envio).map(p => p.ml_envio);
  const out: { zpl: string[]; pdf: string[]; erros: string[] } = { zpl: [], pdf: [], erros: [] };
  if (mlEnv.length) {
    const t = await tokenMl();
    const r = await fetch(`${ML}/shipment_labels?shipment_ids=${mlEnv.join(",")}&response_type=${formato === "pdf" ? "pdf" : "zpl2"}`, { headers: { Authorization: "Bearer " + t } });
    const b = new Uint8Array(await r.arrayBuffer());
    if (!r.ok) out.erros.push("Mercado Livre: " + new TextDecoder().decode(b).slice(0, 250));
    else if (formato === "pdf") { let bin = ""; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000)); out.pdf.push(btoa(bin)); }
    else if (b[0] === 0x50 && b[1] === 0x4b) { const z = unzipSync(b); for (const [nome, c] of Object.entries(z)) if (/\.(txt|zpl)$/i.test(nome) || !/\./.test(nome)) out.zpl.push(strFromU8(c)); }
    else out.zpl.push(new TextDecoder().decode(b));
  }
  for (const p of ps.filter(p => Number(p.loja_bling) !== LOJA_ML)) {
    try {
      const j = await bling(`/logisticas/etiquetas?formato=${formato === "pdf" ? "PDF" : "ZPL"}&idsVendas[]=${p.id}`); await espera(350);
      for (const e of (j?.data || [])) { if (!e?.link) continue; const r = await fetch(e.link); if (!r.ok) continue;
        if (formato === "pdf") { const b = new Uint8Array(await r.arrayBuffer()); let bin = ""; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000)); out.pdf.push(btoa(bin)); }
        else out.zpl.push(await r.text()); }
      if (!(j?.data || []).length) out.erros.push(`${p.cliente || p.numero_loja}: o Bling não devolveu etiqueta (a Shopee já liberou o envio?)`);
    } catch (e) { out.erros.push(`${p.cliente || p.numero_loja}: ${String((e as Error).message).slice(0, 160)}`); }
  }
  for (const p of ps.filter(p => Number(p.loja_bling) === LOJA_ML && !p.ml_envio)) out.erros.push(`${p.cliente || p.numero_loja}: envio do ML ainda não identificado`);
  return out;
}

const TIPO: Record<string, string> = { self_service: "flex", drop_off: "agencia", xd_drop_off: "agencia", cross_docking: "coleta", fulfillment: "full" };
const freteShopee = (s: string) => /entrega direta/i.test(s) ? "shopee_direta" : /xpress|expresso/i.test(s) ? "shopee_xpress" : /retirada/i.test(s) ? "shopee_retirada" : s ? "outro" : null;

// envio do ML a partir do número do pedido (o Bling guarda o id do pedido ou do pacote/carrinho)
async function envioDoPedido(num: string): Promise<number | null> {
  try { const o = await ml(`/orders/${num}`); if (o?.shipping?.id) return Number(o.shipping.id); } catch (e) { if ((e as any).status !== 404) throw e; }
  try { const p = await ml(`/packs/${num}`); if (p?.shipment?.id) return Number(p.shipment.id); const o = (p?.orders || [])[0]; if (o?.id) { const d = await ml(`/orders/${o.id}`); if (d?.shipping?.id) return Number(d.shipping.id); } } catch (e) { if ((e as any).status !== 404) throw e; }
  return null;
}

async function sincronizar(ids: number[] = []) {
  const a = await lerMl(), mlOk = !!a.refresh_token && !!credenciais();
  // pendentes da tela + despachados de 2 dias para cá (para pegar mudanças tardias)
  // + despachados de até 30 dias que o ML ainda não deu como entregues (a caminho, ou marcados como despachados sem ter saído)
  const desde = new Date(Date.now() - 2 * 864e5).toISOString(), desde30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const filtro = ids.length ? `id=in.(${ids.join(",")})` : `or=(despachado_em.is.null,despachado_em.gte.${encodeURIComponent(desde)},and(despachado_em.gte.${encodeURIComponent(desde30)},ml_status.in.(shipped,ready_to_ship,pending,handling)))&ignorado_em=is.null`;
  const ps: any[] = (await rest(`pedidos_online?select=id,canal,loja_bling,numero_loja,frete,logistica,ml_envio,ml_status,despachado_em,ignorado_em,situacao_id&${filtro}&order=data.asc&limit=250`)) || [];
  const rel = { pedidos: ps.length, ml: 0, frete: 0, enviados: 0, cancelados: 0, erros: [] as string[] };
  for (const p of ps) {
    const alt: Record<string, unknown> = {};
    try {
      // nome do frete no Bling (uma vez)
      if (!p.frete) {
        const b = await blingPedido(p.id); await espera(350);
        const s = String(((b?.transporte?.volumes || [])[0] || {}).servico || "");
        if (b) { alt.frete = s || "—"; rel.frete++; if (Number(p.loja_bling) !== LOJA_ML && !p.logistica) alt.logistica = freteShopee(s); }
      }
      // Mercado Livre
      if (mlOk && Number(p.loja_bling) === LOJA_ML && p.numero_loja && !(p.despachado_em && /delivered|not_delivered|cancelled/.test(p.ml_status || ""))) {
        let sid = p.ml_envio ? Number(p.ml_envio) : null;
        if (!sid) { sid = await envioDoPedido(String(p.numero_loja)); if (sid) alt.ml_envio = sid; }
        if (sid) {
          const s = await ml(`/shipments/${sid}`, { "x-format-new": "true" });
          const sla = await ml(`/shipments/${sid}/sla`).catch(() => null);
          const tipo = s?.logistic?.type || s?.logistic_type || "";
          alt.logistica = TIPO[tipo] || (tipo ? "outro" : null);
          alt.ml_status = s?.status || null; alt.ml_substatus = s?.substatus || null;
          alt.envio_limite = sla?.expected_date || s?.lead_time?.estimated_handling_limit?.date || null;
          alt.envio_info = { tipo, modo: s?.logistic?.mode || null, sla: sla?.status || null, entrega: s?.lead_time?.estimated_delivery_time?.date || null,
            servico: s?.lead_time?.shipping_method?.name || null, rastreio: s?.tracking_number || null };
          rel.ml++;
          if (!p.despachado_em && /^(shipped|delivered)$/.test(s?.status || "")) {
            // já saiu segundo o ML → despachado (a função "bling" passa para Atendido no Bling)
            alt.despachado_em = new Date().toISOString(); alt.despachado_por = "Mercado Livre (" + (s.status === "delivered" ? "entregue" : "enviado") + ")";
            alt.separado_em = new Date().toISOString(); rel.enviados++;
          }
          if (s?.status === "cancelled" && p.ml_status !== "cancelled") rel.cancelados++;
        }
        await espera(200);
      }
    } catch (e) { rel.erros.push(`${p.numero_loja || p.id}: ${String((e as Error).message).slice(0, 160)}`); }
    alt.envio_sync_em = new Date().toISOString();
    if (alt.despachado_em) { // não sobrescreve quem separou
      const at = ((await rest(`pedidos_online?select=separado_em&id=eq.${p.id}`)) || [])[0]; if (at?.separado_em) delete alt.separado_em;
    }
    await rest(`pedidos_online?id=eq.${p.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(alt) });
  }
  return { ...rel, ml_ligado: mlOk };
}

function pagina(titulo: string, texto: string, ok: boolean) {
  const cor = ok ? "#1b7248" : "#b42318";
  return new Response(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title></head>
<body style="font-family:Nunito,Arial,sans-serif;background:#f5f7f9;margin:0;display:grid;place-items:center;min-height:100vh">
<div style="background:#fff;border:1px solid #dadfe4;border-radius:10px;padding:28px 32px;max-width:440px;text-align:center">
<div style="font-size:40px">${ok ? "✅" : "⚠️"}</div><h1 style="color:${cor};font-size:20px">${titulo}</h1><p style="color:#293343">${texto}</p>
<a href="https://notas.novaraphaella.com.br/#separacao" style="display:inline-block;margin-top:8px;background:#1b2d4b;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:700">Voltar ao sistema</a></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const u = new URL(req.url);

  // volta do Mercado Livre depois da autorização
  if (req.method === "GET" && (u.searchParams.get("code") || u.searchParams.get("error"))) {
    try {
      if (u.searchParams.get("error")) return pagina("Ligação não autorizada", "O Mercado Livre não autorizou o acesso. Tente de novo pelo botão no sistema.", false);
      const a = await lerMl(), estado = u.searchParams.get("state") || "";
      if (!a.estado || a.estado !== estado || !a.estado_em || Date.now() - new Date(a.estado_em).getTime() > 30 * 60 * 1000)
        return pagina("Link vencido", "Esse link de autorização não vale mais. Gere outro pelo botão no sistema.", false);
      const t = await pedirToken({ grant_type: "authorization_code", code: u.searchParams.get("code")!, redirect_uri: REDIRECT });
      let apelido = ""; try { const me = await fetch(ML + "/users/me", { headers: { Authorization: "Bearer " + t.access_token } }).then(r => r.json()); apelido = me?.nickname || ""; } catch { /* */ }
      await gravarMl({ ...t, apelido, conectado_em: new Date().toISOString(), conectado_por: a.estado_por, estado: null, ultimo_erro: null });
      return pagina("Sistema ligado ao Mercado Livre", `Pronto${apelido ? " (" + apelido + ")" : ""}: a tela de Separação já mostra Flex, Agência, Coleta e Full com os prazos. Pode fechar esta aba.`, true);
    } catch (e) { return pagina("Não deu certo", String((e as Error).message).slice(0, 300), false); }
  }
  if (req.method !== "POST") return resp({ ok: false, erro: "metodo" }, 405);

  // pg_cron (envios_cron): mesmo segredo da função "bling"
  const tokCron = req.headers.get("x-cron-token");
  if (tokCron) {
    const b = ((await rest("bling_auth?id=eq.1&select=cron_token")) || [])[0] || {};
    if (!b.cron_token || tokCron !== b.cron_token) return resp({ ok: false, erro: "sem_permissao" }, 403);
    try { const r = await sincronizar(); await gravarMl({ sync_em: new Date().toISOString(), sync_msg: `${r.pedidos} pedido(s); ML ${r.ml}; ${r.enviados} já enviado(s); ${r.cancelados} cancelado(s)` + (r.erros.length ? `; ${r.erros.length} erro(s): ${r.erros[0]}` : "") }); return resp({ ok: true, ...r }); }
    catch (e) { await gravarMl({ sync_em: new Date().toISOString(), sync_msg: "falhou: " + String((e as Error).message).slice(0, 200) }); return resp({ ok: false, msg: String((e as Error).message) }); }
  }

  try {
    const auth = req.headers.get("Authorization") || "";
    const corpo = await req.json().catch(() => ({}));
    const acao = String(corpo?.acao || "");
    // status: quem pode separar vê; ligar: só perfil completo
    const fn = acao === "status" || acao === "etiqueta" || (acao === "sync" && (corpo?.ids || []).length) ? "pode_separar" : "permitido";
    const p = await fetch(URL_SB + "/rest/v1/rpc/" + fn, { method: "POST", headers: { apikey: ANON, Authorization: auth, "Content-Type": "application/json" }, body: "{}" });
    if (!p.ok || (await p.json()) !== true) return resp({ ok: false, erro: "sem_permissao", msg: "Entre no sistema de novo." }, 403);
    let email = ""; try { email = JSON.parse(atob(auth.replace(/^Bearer\s+/i, "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || ""; } catch { /* */ }

    if (acao === "status") {
      const a = await lerMl();
      return resp({ ok: true, segredos: !!credenciais(), ligado: !!a.refresh_token, apelido: a.apelido || null, conectado_em: a.conectado_em || null, ultimo_erro: a.ultimo_erro || null, sync_em: a.sync_em || null, sync_msg: a.sync_msg || null });
    }
    if (acao === "link") {
      const c = credenciais(); if (!c) return resp({ ok: false, erro: "sem_segredos", msg: "Cadastre os segredos ML_CLIENT_ID e ML_CLIENT_SECRET no Supabase primeiro." });
      const estado = crypto.randomUUID().replace(/-/g, "");
      await gravarMl({ estado, estado_em: new Date().toISOString(), estado_por: email });
      return resp({ ok: true, url: `${ML_AUTH}?response_type=code&client_id=${encodeURIComponent(c.id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${estado}` });
    }
    if (acao === "nfe") {
      const ids: number[] = (corpo?.ids || []).map(Number).filter(Boolean).slice(0, 20); const res: any[] = [];
      for (const id of ids) { try { res.push({ id, ...(await emitirNfe(id)) }); } catch (e) { res.push({ id, ok: false, msg: String((e as Error).message).slice(0, 300) }); } }
      return resp({ ok: true, itens: res });
    }
    if (acao === "etiqueta") {
      const ids: number[] = (corpo?.ids || []).map(Number).filter(Boolean).slice(0, 50);
      return resp({ ok: true, ...(await etiquetas(ids, String(corpo?.formato || "zpl"))) });
    }
    if (acao === "sync") {
      const so: number[] = (corpo?.ids || []).map(Number).filter(Boolean).slice(0, 30);
      if (so.length) return resp({ ok: true, ...(await sincronizar(so)) }); // conferência rápida de poucos pedidos
      const r = await sincronizar();
      await gravarMl({ sync_em: new Date().toISOString(), sync_msg: `${r.pedidos} pedido(s); ML ${r.ml}; ${r.enviados} já enviado(s); ${r.cancelados} cancelado(s)` + (r.erros.length ? `; ${r.erros.length} erro(s)` : "") });
      return resp({ ok: true, ...r });
    }
    return resp({ ok: false, erro: "acao", msg: "ação desconhecida: " + acao }, 400);
  } catch (e) {
    return resp({ ok: false, erro: "falha", msg: String((e as Error).message).slice(0, 500) });
  }
});
