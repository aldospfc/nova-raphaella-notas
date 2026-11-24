import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Mercado Livre na tela E-commerce: perguntas dos anúncios, reclamações, mensagens das vendas e anúncios.
// Usa o token que a função "envios" mantém renovado (tabela ml_auth). Esta função NUNCA renova o token
// (o refresh token do ML só vale uma vez; se as duas renovassem juntas, a ligação cairia).
// Sugestão de resposta: IA (segredo ANTHROPIC_API_KEY; modelo no segredo SUGESTAO_MODELO, padrão Sonnet).
// Nada é enviado ao comprador sem o clique de quem está logado (ações responder / mensagem).
// v1 (24/11/2026).
// v2 (24/11/2026): anuncio (detalhe + ficha técnica da categoria + vínculo do Bling), anuncio_salvar (título, descrição, ficha, pausar/ativar no ML)
//     e preco (pelo Bling: produtos/lojas da loja Mercado Livre; o Bling leva ao ML). Regra do Aldo: preço e estoque só pelo Bling.
// v3 (24/11/2026): promoções (seller-promotions v2): campanhas da loja e seus anúncios, promoções de um anúncio, entrar/sair, desconto próprio com período.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const URL_SB = Deno.env.get("SUPABASE_URL")!, SERVICO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ML = "https://api.mercadolibre.com";
const espera = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rest(caminho: string, init: RequestInit = {}) {
  const r = await fetch(URL_SB + "/rest/v1/" + caminho, { ...init, headers: { apikey: SERVICO, Authorization: "Bearer " + SERVICO, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text(); if (!r.ok) throw new Error("banco: " + t.slice(0, 200)); return t ? JSON.parse(t) : null;
}
async function auth(): Promise<{ token: string; user: number }> {
  for (let i = 0; i < 3; i++) {
    const a = ((await rest("ml_auth?id=eq.1&select=access_token,expires_at,user_id")) || [])[0] || {};
    if (a.access_token && new Date(a.expires_at).getTime() - Date.now() > 90 * 1000) return { token: a.access_token, user: Number(a.user_id) };
    await espera(2500);
  }
  throw new Error("o acesso ao Mercado Livre está sendo renovado — tente de novo em 1 minuto");
}
async function ml(caminho: string, init: RequestInit = {}): Promise<any> {
  const { token } = await auth();
  const chama = () => fetch(ML + caminho, { ...init, headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) } });
  let r = await chama(); if (r.status === 429) { await espera(1500); r = await chama(); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e: any = new Error(`Mercado Livre ${r.status}: ${j?.message || j?.error || JSON.stringify(j).slice(0, 200)}`); e.status = r.status; throw e; }
  return j;
}
// anúncios em lote (até 20 por chamada)
async function itens(ids: string[], campos = "id,title,price,available_quantity,sold_quantity,status,permalink,thumbnail,listing_type_id,seller_custom_field") {
  const out: Record<string, any> = {}; const u = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < u.length; i += 20) {
    const l = await ml(`/items?ids=${u.slice(i, i + 20).join(",")}&attributes=${campos}`);
    for (const x of l || []) if (x?.body?.id) out[x.body.id] = x.body;
  }
  return out;
}

async function perguntas() {
  const { user } = await auth();
  const q = await ml(`/questions/search?seller_id=${user}&status=UNANSWERED&api_version=4&sort_fields=date_created&sort_types=DESC&limit=50`);
  const l = q.questions || [];
  const it = await itens(l.map((x: any) => x.item_id));
  return l.map((x: any) => ({ id: x.id, texto: x.text, data: x.date_created, item_id: x.item_id, de: x.from?.id || null, item: it[x.item_id] || null }));
}
async function responder(id: number, texto: string) {
  if (!id || !texto.trim()) throw new Error("falta a pergunta ou a resposta");
  if (texto.length > 2000) throw new Error("resposta passa de 2000 caracteres");
  return await ml("/answers", { method: "POST", body: JSON.stringify({ question_id: id, text: texto.trim() }) });
}
async function sugerir(id: number) {
  const chave = Deno.env.get("ANTHROPIC_API_KEY"); if (!chave) throw new Error("falta o segredo ANTHROPIC_API_KEY no Supabase");
  const q = await ml(`/questions/${id}?api_version=4`);
  const it = await ml(`/items/${q.item_id}?attributes=title,price,available_quantity,attributes,shipping`).catch(() => ({}));
  const desc = await ml(`/items/${q.item_id}/description`).catch(() => ({}));
  const atr = (it.attributes || []).filter((a: any) => a.value_name).map((a: any) => `${a.name}: ${a.value_name}`).slice(0, 40).join("\n");
  const ctx = `Anúncio: ${it.title || ""}\nPreço: R$ ${it.price ?? "?"}\nEstoque disponível: ${it.available_quantity ?? "?"}\nFicha técnica:\n${atr}\nDescrição:\n${String(desc.plain_text || "").slice(0, 3500)}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("SUGESTAO_MODELO") || "claude-sonnet-5-5", max_tokens: 600,
      system: "Você é o atendimento da Nova Raphaella (papelaria e utilidades) no Mercado Livre. Escreva UMA resposta curta (até 4 frases), cordial e direta, em português do Brasil, para a pergunta do comprador, usando só as informações do anúncio. Se a informação não estiver no anúncio, diga que vai verificar e não invente. Não peça contato fora do Mercado Livre, não passe telefone, e-mail, links ou redes sociais (regra do ML). Comece com 'Olá!' e termine com 'Att, Nova Raphaella'. Responda só com o texto da resposta.",
      messages: [{ role: "user", content: `${ctx}\n\nPergunta do comprador: ${q.text}` }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("IA: " + (j?.error?.message || r.status));
  return String((j.content || []).map((c: any) => c.text || "").join("")).trim();
}

async function reclamacoes() {
  const l = await ml(`/post-purchase/v1/claims/search?status=opened&limit=50&sort=last_updated:desc`);
  const out: any[] = [];
  for (const c of (l.data || []).slice(0, 30)) {
    let det: any = c; try { det = await ml(`/post-purchase/v1/claims/${c.id}`); } catch { /* usa o resumo */ }
    const eu = (det.players || []).find((p: any) => p.role === "respondent") || {};
    const acoes = (eu.available_actions || []).map((a: any) => ({ acao: a.action, prazo: a.due_date || null, obrigatoria: !!a.mandatory }));
    out.push({ id: c.id, pedido: String(c.resource_id || ""), tipo: c.type, etapa: c.stage, motivo: det.reason_id || c.reason_id || null, criada: c.date_created, atualizada: c.last_updated, acoes,
      link: `https://www.mercadolivre.com.br/vendas/reclamacoes/${c.id}/detalhe` });
  }
  const nums = out.map(x => x.pedido).filter(Boolean);
  if (nums.length) { const ps: any[] = (await rest(`pedidos_online?select=numero_loja,cliente,itens,numero&numero_loja=in.(${nums.join(",")})`)) || [];
    const m = new Map(ps.map(p => [String(p.numero_loja), p]));
    for (const x of out) { const p = m.get(x.pedido); if (p) { x.cliente = p.cliente; x.numero = p.numero; x.itens = (p.itens || []).map((i: any) => `${i.quantidade}× ${i.descricao}`).join(" · "); } } }
  return out;
}

// mensagens pós-venda: lista das conversas com mensagem não lida e conversa de um pedido
async function naoLidas() {
  const r = await ml(`/messages/unread?role=seller&tag=post_sale`).catch(() => ({ results: [] }));
  const l = (r.results || []).map((x: any) => ({ recurso: String(x.resource || ""), qtd: Number(x.count) || 0 }));
  const packs = l.map((x: any) => (/(\d{10,})/.exec(x.recurso) || [])[1]).filter(Boolean);
  if (packs.length) { const ps: any[] = (await rest(`pedidos_online?select=numero_loja,cliente,numero&numero_loja=in.(${packs.join(",")})`)) || [];
    const m = new Map(ps.map(p => [String(p.numero_loja), p]));
    for (const x of l) { const n = (/(\d{10,})/.exec(x.recurso) || [])[1]; x.pack = n || null; const p = n ? m.get(n) : null; if (p) { x.cliente = p.cliente; x.numero = p.numero; } } }
  return l;
}
async function conversa(pack: string) {
  const { user } = await auth();
  const r = await ml(`/messages/packs/${pack}/sellers/${user}?tag=post_sale&mark_as_read=false&limit=50`);
  return { user, mensagens: (r.messages || []).map((m: any) => ({ id: m.id, de: m.from?.user_id, eu: Number(m.from?.user_id) === user, texto: m.text, data: m.message_date?.created || m.date_created || null })).reverse(),
    bloqueada: r.conversation_status?.status === "blocked" ? (r.conversation_status?.substatus || "bloqueada") : null };
}
async function mandarMensagem(pack: string, texto: string) {
  const { user } = await auth();
  if (!texto.trim()) throw new Error("mensagem vazia");
  if (texto.length > 350) throw new Error("mensagem passa de 350 caracteres (limite do ML)");
  // comprador: pelo pacote ou pelo pedido
  let comprador = 0;
  try { const p = await ml(`/packs/${pack}`); const o = (p.orders || [])[0]; if (o?.id) comprador = Number((await ml(`/orders/${o.id}`)).buyer?.id) || 0; } catch { /* não é pacote */ }
  if (!comprador) comprador = Number((await ml(`/orders/${pack}`)).buyer?.id) || 0;
  if (!comprador) throw new Error("não achei o comprador desse pedido");
  return await ml(`/messages/packs/${pack}/sellers/${user}?tag=post_sale`, { method: "POST", body: JSON.stringify({ from: { user_id: user }, to: { user_id: comprador }, text: texto.trim() }) });
}

// ---- edição do anúncio ----
async function blingTok(): Promise<string> {
  const a = ((await rest("bling_auth?id=eq.1&select=access_token,expires_at")) || [])[0] || {};
  if (!a.access_token || new Date(a.expires_at).getTime() < Date.now() + 60000) throw new Error("o acesso ao Bling está sendo renovado — tente de novo em 1 minuto");
  return a.access_token;
}
async function bling(caminho: string, init: RequestInit = {}): Promise<any> {
  const t = await blingTok();
  const r = await fetch("https://api.bling.com.br/Api/v3" + caminho, { ...init, headers: { Authorization: "Bearer " + t, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) } });
  const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = {}; }
  if (!r.ok) { const f = (j?.error?.fields || []).map((x: any) => x.msg).filter(Boolean).join("; "); throw new Error(`Bling ${r.status}: ${f || j?.error?.description || j?.error?.message || txt.slice(0, 200)}`); }
  return j;
}
async function anuncio(id: string) {
  const it = await ml(`/items/${id}?include_attributes=all`);
  const desc = await ml(`/items/${id}/description`).catch(() => ({}));
  const cat = await ml(`/categories/${it.category_id}/attributes`).catch(() => []);
  const atuais = new Map((it.attributes || []).map((a: any) => [a.id, a]));
  const ficha = (cat || []).filter((a: any) => !a.tags?.hidden && !a.tags?.read_only && !a.tags?.fixed && !a.tags?.variation_attribute && !["SELLER_SKU", "GTIN", "ITEM_CONDITION"].includes(a.id) || atuais.has(a.id) && ["GTIN", "SELLER_SKU"].includes(a.id))
    .map((a: any) => { const v: any = atuais.get(a.id) || {};
      return { id: a.id, nome: a.name, tipo: a.value_type, obrigatorio: !!(a.tags?.required || a.tags?.catalog_required), conditional: !!a.tags?.conditional_required,
        valores: (a.values || []).slice(0, 80).map((x: any) => ({ id: x.id, nome: x.name })), unidades: (a.allowed_units || []).map((u: any) => u.name),
        valor: v.value_name || "", valor_id: v.value_id || null, max: a.value_max_length || null }; });
  const vin = ((await rest(`ml_vinculo?select=vinculo_id,produto_id,preco,preco_promo,em&mlb=eq.${encodeURIComponent(id)}`)) || [])[0] || null;
  return { item: { id: it.id, title: it.title, price: it.price, available_quantity: it.available_quantity, sold_quantity: it.sold_quantity, status: it.status, permalink: it.permalink,
    thumbnail: it.thumbnail, pictures: (it.pictures || []).map((p: any) => p.secure_url || p.url).slice(0, 12), listing_type_id: it.listing_type_id, category_id: it.category_id,
    catalog_listing: !!it.catalog_listing, variacoes: (it.variations || []).length, health: it.health ?? null, tags: it.tags || [] },
    descricao: desc.plain_text || "", ficha, vinculo: vin };
}
async function anuncioSalvar(id: string, c: any) {
  const feito: string[] = [];
  const corpo: any = {};
  if (typeof c.title === "string" && c.title.trim()) corpo.title = c.title.trim().slice(0, 60);
  if (Array.isArray(c.atributos) && c.atributos.length) corpo.attributes = c.atributos.slice(0, 100).map((a: any) => a.value_id ? { id: String(a.id), value_id: String(a.value_id) } : { id: String(a.id), value_name: String(a.value_name ?? "") });
  if (c.status === "paused" || c.status === "active") corpo.status = c.status;
  if (Object.keys(corpo).length) { await ml(`/items/${id}`, { method: "PUT", body: JSON.stringify(corpo) }); feito.push(...Object.keys(corpo).map(k => ({ title: "título", attributes: "ficha técnica", status: "situação" } as any)[k])); }
  if (typeof c.descricao === "string") { await ml(`/items/${id}/description?api_version=2`, { method: "PUT", body: JSON.stringify({ plain_text: c.descricao.slice(0, 50000) }) }); feito.push("descrição"); }
  return feito;
}
// preço do anúncio pelo Bling (vínculo produtos/lojas); o Bling sincroniza com o ML
async function precoBling(mlb: string, preco: number) {
  if (!(preco > 0)) throw new Error("preço inválido");
  const v = ((await rest(`ml_vinculo?select=vinculo_id&mlb=eq.${encodeURIComponent(mlb)}`)) || [])[0];
  if (!v) throw new Error("este anúncio não está vinculado a um produto no Bling (Produtos → aba Lojas)");
  const atual = (await bling(`/produtos/lojas/${v.vinculo_id}`)).data || {};
  const corpo = { codigo: atual.codigo || mlb, preco: Math.round(preco * 100) / 100, precoPromocional: Math.round(preco * 100) / 100, produto: { id: atual.produto?.id }, loja: { id: atual.loja?.id },
    fornecedorLoja: atual.fornecedorLoja || { id: 0 }, marcaLoja: atual.marcaLoja || { id: 0 }, categoriasProdutos: atual.categoriasProdutos || [] };
  await bling(`/produtos/lojas/${v.vinculo_id}`, { method: "PUT", body: JSON.stringify(corpo) });
  await rest(`ml_vinculo?mlb=eq.${encodeURIComponent(mlb)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ preco: corpo.preco, preco_promo: corpo.precoPromocional, em: new Date().toISOString() }) });
  return corpo.preco;
}

// ---- promoções ----
const PV = "app_version=v2";
async function promosLoja() {
  const { user } = await auth();
  const r = await ml(`/seller-promotions/users/${user}?${PV}`);
  return (r.results || []).map((p: any) => ({ id: p.id, tipo: p.type, sub: p.sub_type || null, status: p.status, nome: p.name || "", inicio: p.start_date || null, fim: p.finish_date || null, prazo: p.deadline_date || null,
    valor: p.fixed_amount ?? null, pct: p.fixed_percentage ?? null, minimo: p.min_purchase_amount ?? null }));
}
async function promoItens(id: string, tipo: string, status: string, depois: string) {
  const q = `promotion_type=${encodeURIComponent(tipo)}${status ? "&status=" + encodeURIComponent(status) : ""}${depois ? "&search_after=" + encodeURIComponent(depois) : ""}&limit=50&${PV}`;
  const r = await ml(`/seller-promotions/promotions/${encodeURIComponent(id)}/items?${q}`);
  const l = r.results || []; const it = await itens(l.map((x: any) => x.id), "id,title,price,available_quantity,thumbnail,permalink,status");
  return { proximo: r.paging?.searchAfter || null, total: r.paging?.total ?? null,
    itens: l.map((x: any) => ({ id: x.id, status: x.status, preco: x.price ?? null, original: x.original_price ?? null, sugerido: x.suggested_discounted_price ?? null, min: x.min_discounted_price ?? null, max: x.max_discounted_price ?? null,
      oferta: x.offer_id || null, meli_pct: x.meli_percentage ?? null, item: it[x.id] || null })) };
}
async function promosItem(item: string) {
  const l = await ml(`/seller-promotions/items/${item}?${PV}`);
  return (Array.isArray(l) ? l : []).map((p: any) => ({ id: p.id || null, tipo: p.type, sub: p.sub_type || null, status: p.status, nome: p.name || "", preco: p.price || null, original: p.original_price ?? null,
    min: p.min_discounted_price ?? null, max: p.max_discounted_price ?? null, sugerido: p.suggested_discounted_price ?? null, inicio: p.start_date || null, fim: p.finish_date || null, oferta: p.offer_id || null,
    valor: p.fixed_amount ?? null, pct: p.fixed_percentage ?? null, meli_pct: p.meli_percentage ?? null }));
}
async function promoEntrar(item: string, c: any) {
  const corpo: any = { promotion_type: String(c.tipo) };
  if (c.promotion_id) corpo.promotion_id = String(c.promotion_id);
  if (c.offer_id) corpo.offer_id = String(c.offer_id);
  if (c.preco != null && c.preco !== "") corpo.deal_price = Math.round(Number(c.preco) * 100) / 100;
  if (c.tipo === "PRICE_DISCOUNT") { if (!c.inicio || !c.fim) throw new Error("informe início e fim do desconto"); corpo.start_date = String(c.inicio); corpo.finish_date = String(c.fim); }
  return await ml(`/seller-promotions/items/${item}?${PV}`, { method: "POST", body: JSON.stringify(corpo) });
}
async function promoSair(item: string, c: any) {
  const q = `promotion_type=${encodeURIComponent(String(c.tipo))}${c.promotion_id ? "&promotion_id=" + encodeURIComponent(String(c.promotion_id)) : ""}${c.offer_id ? "&offer_id=" + encodeURIComponent(String(c.offer_id)) : ""}&${PV}`;
  return await ml(`/seller-promotions/items/${item}?${q}`, { method: "DELETE" });
}

async function anuncios(q: string, status: string, offset: number) {
  const { user } = await auth();
  const st = ["active", "paused", "closed"].includes(status) ? `&status=${status}` : "";
  const r = await ml(`/users/${user}/items/search?limit=50&offset=${Math.max(0, offset | 0)}${st}${q ? "&q=" + encodeURIComponent(q) : ""}`);
  const it = await itens(r.results || []);
  return { total: r.paging?.total || 0, itens: (r.results || []).map((id: string) => it[id]).filter(Boolean) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return resp({ ok: false, erro: "metodo" }, 405);
  try {
    const authz = req.headers.get("Authorization") || "";
    const corpo = await req.json().catch(() => ({}));
    const acao = String(corpo?.acao || "");
    // ler: quem pode separar; responder/mandar mensagem: só perfil completo
    const fn = ["responder", "mensagem", "sugerir", "anuncio_salvar", "preco", "promo_entrar", "promo_sair"].includes(acao) ? "permitido" : "pode_separar";
    const p = await fetch(URL_SB + "/rest/v1/rpc/" + fn, { method: "POST", headers: { apikey: ANON, Authorization: authz, "Content-Type": "application/json" }, body: "{}" });
    if (!p.ok || (await p.json()) !== true) return resp({ ok: false, erro: "sem_permissao", msg: "Sem permissão para isso." }, 403);

    if (acao === "resumo") {
      const [pg, rc, ms] = await Promise.all([perguntas().catch(() => null), reclamacoes().catch(() => null), naoLidas().catch(() => null)]);
      return resp({ ok: true, perguntas: pg ? pg.length : null, reclamacoes: rc ? rc.length : null, mensagens: ms ? ms.reduce((a: number, x: any) => a + (x.qtd || 0), 0) : null });
    }
    if (acao === "perguntas") return resp({ ok: true, itens: await perguntas() });
    if (acao === "sugerir") return resp({ ok: true, texto: await sugerir(Number(corpo.id)) });
    if (acao === "responder") return resp({ ok: true, r: await responder(Number(corpo.id), String(corpo.texto || "")) });
    if (acao === "reclamacoes") return resp({ ok: true, itens: await reclamacoes() });
    if (acao === "naolidas") return resp({ ok: true, itens: await naoLidas() });
    if (acao === "conversa") return resp({ ok: true, ...(await conversa(String(corpo.pack || "").replace(/\D/g, ""))) });
    if (acao === "mensagem") return resp({ ok: true, r: await mandarMensagem(String(corpo.pack || "").replace(/\D/g, ""), String(corpo.texto || "")) });
    if (acao === "anuncio") return resp({ ok: true, ...(await anuncio(String(corpo.id || "").toUpperCase())) });
    if (acao === "anuncio_salvar") return resp({ ok: true, feito: await anuncioSalvar(String(corpo.id || "").toUpperCase(), corpo) });
    if (acao === "preco") return resp({ ok: true, preco: await precoBling(String(corpo.id || "").toUpperCase(), Number(corpo.preco)) });
    if (acao === "promos_loja") return resp({ ok: true, itens: await promosLoja() });
    if (acao === "promo_itens") return resp({ ok: true, ...(await promoItens(String(corpo.id || ""), String(corpo.tipo || ""), String(corpo.status || ""), String(corpo.depois || ""))) });
    if (acao === "promos_item") return resp({ ok: true, itens: await promosItem(String(corpo.id || "").toUpperCase()) });
    if (acao === "promo_entrar") return resp({ ok: true, r: await promoEntrar(String(corpo.item || "").toUpperCase(), corpo) });
    if (acao === "promo_sair") return resp({ ok: true, r: await promoSair(String(corpo.item || "").toUpperCase(), corpo) });
    if (acao === "anuncios") return resp({ ok: true, ...(await anuncios(String(corpo.q || "").trim(), String(corpo.status || "active"), Number(corpo.offset) || 0)) });
    return resp({ ok: false, erro: "acao", msg: "ação desconhecida: " + acao }, 400);
  } catch (e) {
    return resp({ ok: false, erro: "falha", msg: String((e as Error).message).slice(0, 400) });
  }
});
