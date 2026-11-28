import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Envia ao site (Sanity) um produto que so existe no cadastro das lojas (Mobility Gestao), com previa e aprovacao na tela.
//   acao "preparar": le o cadastro, procura fotos (Serper) e pede a IA um nome limpo, marca, categoria e descricao curta. Nao grava nada.
//   acao "publicar": recebe o que o usuario aprovou (texto e a foto escolhida), sobe a foto para o Sanity e cria o produto.
// Segredos: SANITY_TOKEN (Editor no projeto l2j20ikp), SERPER_API_KEY (busca de imagens), ANTHROPIC_API_KEY (texto; modelo em ROMANEIO_MODELO).
// So usuario de perfil completo (rpc permitido). v1 (28/11/2026).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const URL_SB = Deno.env.get("SUPABASE_URL")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SANITY_API = "https://l2j20ikp.api.sanity.io/v2024-01-01", DATASET = "production";
const DISP = ["Ambas as lojas", "Loja 1 - Jardim Soraia", "Loja 2 - Limoeiro"];
const semZeros = (e: string) => String(e || "").replace(/\D/g, "").replace(/^0+/, "");
const limpa = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

async function sanity(groq: string, params: Record<string, unknown> = {}) {
  const u = new URL(`${SANITY_API}/data/query/${DATASET}`);
  u.searchParams.set("query", groq);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(`$${k}`, JSON.stringify(v));
  const r = await fetch(u, { headers: { Authorization: `Bearer ${Deno.env.get("SANITY_TOKEN")}` } });
  if (!r.ok) throw new Error(`Sanity ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).result;
}
function slugify(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}
async function serper(tipo: "images" | "search", q: string, num: number) {
  const chave = Deno.env.get("SERPER_API_KEY");
  if (!chave) throw new Error("SEM_SERPER");
  const r = await fetch("https://google.serper.dev/" + tipo, { method: "POST", headers: { "X-API-KEY": chave, "Content-Type": "application/json" }, body: JSON.stringify({ q, gl: "br", hl: "pt-br", num }) });
  if (!r.ok) throw new Error(`Serper ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return await r.json();
}
async function cadastro(ean: string) {
  const k = semZeros(ean); if (!k) return [];
  const cands = [...new Set([k, k.padStart(13, "0"), k.padStart(14, "0"), String(ean).replace(/\D/g, "")])];
  const { data, error } = await supabase.from("produtos").select("loja_id,ean,descricao,preco_venda,estoque,ativo").in("ean", cands);
  if (error) throw new Error("banco: " + error.message);
  return (data || []).filter((p) => p.ativo !== false).sort((a, b) => a.loja_id - b.loja_id);
}
async function noSite(ean: string) {
  const k = semZeros(ean);
  return await sanity(`*[_type == "produto" && (_id == $id || ean in $eans)][0]{_id, nome, "slug": slug.current}`, { id: "produto-" + k.padStart(13, "0"), eans: [k, k.padStart(13, "0"), k.padStart(14, "0")] });
}

async function preparar(ean: string) {
  const prods = await cadastro(ean);
  if (!prods.length) return { ok: false, erro: "cadastro", msg: "Não achei este código de barras no cadastro das lojas (ou está inativo)." };
  const eanCad = String(prods[0].ean), lojas = [...new Set(prods.map((p) => p.loja_id))];
  const disponibilidade = lojas.includes(1) && lojas.includes(2) ? DISP[0] : lojas.includes(1) ? DISP[1] : DISP[2];
  const nomes = [...new Set(prods.map((p) => limpa(p.descricao, 120)))];
  const avisos: string[] = [];

  const ja = await noSite(eanCad);
  if (ja) return { ok: true, ja_no_site: ja, ean: eanCad, cadastro: prods };

  const categorias: { _id: string; nome: string }[] = await sanity(`*[_type == "categoria"] | order(nome asc){_id, nome}`);
  const palavras = nomes[0].normalize("NFD").replace(/\p{M}/gu, "").split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 4 && !/^\d+$/.test(w)).sort((a, b) => b.length - a.length).slice(0, 2);
  const parecidos = palavras.length ? await sanity(`*[_type == "produto" && nome match $q][0...6]{nome, ean, "slug": slug.current}`, { q: palavras.map((w) => w + "*").join(" ") }).catch(() => []) : [];

  // fotos e resultados de busca: pelo codigo de barras (mais certeiro) e pelo nome do cadastro
  const k = semZeros(eanCad);
  type Img = { url: string; thumb: string; titulo: string; dominio: string; w: number; h: number; origem: string };
  const imagens: Img[] = []; const titulos: string[] = []; let semSerper = false;
  const juntar = (j: { images?: Record<string, unknown>[] }, origem: string) => {
    for (const i of j?.images || []) {
      const url = String(i.imageUrl || ""); if (!/^https:\/\//.test(url) || imagens.some((x) => x.url === url)) continue;
      const w = Number(i.imageWidth) || 0, h = Number(i.imageHeight) || 0; if (w && h && Math.min(w, h) < 300) continue;
      imagens.push({ url, thumb: String(i.thumbnailUrl || url), titulo: limpa(i.title, 120), dominio: limpa(i.domain || i.source, 60), w, h, origem });
      if (i.title) titulos.push(limpa(i.title, 120));
    }
  };
  const buscas = await Promise.allSettled([serper("images", k.padStart(13, "0"), 10), serper("images", nomes[0], 10), serper("search", k.padStart(13, "0"), 8)]);
  if (buscas.some((b) => b.status === "rejected" && String((b as PromiseRejectedResult).reason?.message).includes("SEM_SERPER"))) { semSerper = true; avisos.push("A busca de fotos ainda não está ligada: falta cadastrar o segredo SERPER_API_KEY no Supabase. Você pode colar o endereço de uma foto."); }
  else for (const b of buscas) if (b.status === "rejected") avisos.push("Uma das buscas falhou: " + limpa((b as PromiseRejectedResult).reason?.message, 120));
  if (buscas[0].status === "fulfilled") juntar(buscas[0].value, "código de barras");
  if (buscas[1].status === "fulfilled") juntar(buscas[1].value, "nome");
  if (buscas[2].status === "fulfilled") for (const o of (buscas[2].value?.organic || []).slice(0, 8)) titulos.unshift(limpa(o.title, 120) + (o.snippet ? " — " + limpa(o.snippet, 160) : ""));

  // texto: IA (se nao der, cai num rascunho simples com o nome do cadastro)
  const titulo = (s: string) => s.toLowerCase().replace(/(^|[\s/(-])([a-zà-ú])/g, (_m, a, b) => a + b.toUpperCase());
  let sugestao = { nome: titulo(nomes[0]), marca: "", categoria_id: "categoria-papelaria", descricao: "", confianca: "baixa", observacao: "" };
  const chave = Deno.env.get("ANTHROPIC_API_KEY");
  if (!chave) avisos.push("Sem a chave da IA (ANTHROPIC_API_KEY): preencha o texto à mão.");
  else try {
    const modelo = Deno.env.get("ROMANEIO_MODELO") || "claude-opus-5-5";
    const sistema = `Voce prepara a pagina de um produto para o site de uma papelaria e loja de utilidades de bairro em Sao Paulo (Nova Raphaella).
Recebe o nome abreviado do cadastro interno, o codigo de barras e titulos encontrados na internet para esse codigo/nome (podem ter ruido ou ser de outro produto).
Devolva SOMENTE um JSON, sem texto antes ou depois, com as chaves:
- "nome": nome para o cliente, ate 100 caracteres, sem abreviacoes, so iniciais maiusculas. Formato: tipo do produto + caracteristica principal + marca + tamanho/quantidade. Ex.: "Pote Quadrado Plastico Sanremo 800ml", "Caderno Universitario Capa Dura 10 Materias Foroni 200 Folhas".
- "marca": o FABRICANTE do produto (nunca distribuidora nem loja). Se nao der para saber com seguranca, "".
- "categoria_id": um dos ids da lista de categorias, o que melhor encaixa.
- "descricao": 2 a 3 frases em portugues do Brasil, ate 420 caracteres, dizendo para que serve e o principal diferencial, terminando com "Disponível na Nova Raphaella!".
- "confianca": "alta" se o nome do cadastro e os titulos da internet concordam sobre qual e o produto; "media" se so o cadastro sustenta; "baixa" se ha duvida sobre qual e o produto.
- "observacao": uma frase curta sobre o que conferir (cor, tamanho, quantidade na embalagem), ou "".
Regras: nao invente medida, quantidade, cor, material ou personagem que nao esteja no nome do cadastro nem nos titulos. Em duvida entre o cadastro e a internet, vale o cadastro. Nao cite preco. Use acentuacao correta no nome e na descricao.`;
    const usuario = `Codigo de barras: ${eanCad}\nNome no cadastro: ${nomes.join(" | ")}\n\nCategorias do site:\n${categorias.map((c) => `- ${c._id}: ${c.nome}`).join("\n")}\n\nTitulos encontrados na internet:\n${[...new Set(titulos)].slice(0, 18).map((t) => "- " + t).join("\n") || "(nenhum)"}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: modelo, max_tokens: 1500, system: sistema, messages: [{ role: "user", content: usuario }] }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error?.message || "erro " + r.status);
    const txt = (j?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    const d = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    sugestao = { nome: limpa(d.nome, 120) || sugestao.nome, marca: limpa(d.marca, 60), categoria_id: categorias.some((c) => c._id === d.categoria_id) ? d.categoria_id : sugestao.categoria_id,
      descricao: limpa(d.descricao, 500), confianca: ["alta", "media", "baixa"].includes(d.confianca) ? d.confianca : "media", observacao: limpa(d.observacao, 200) };
  } catch (e) { avisos.push("A IA não conseguiu escrever o texto (" + limpa((e as Error).message, 120) + "): preencha à mão."); }

  return { ok: true, ean: eanCad, cadastro: prods, disponibilidade, sugestao, categorias, imagens: imagens.slice(0, 16), parecidos, avisos, sem_serper: semSerper };
}

async function publicar(b: Record<string, unknown>) {
  const prods = await cadastro(String(b.ean || ""));
  if (!prods.length) return { ok: false, msg: "Este código de barras não está no cadastro das lojas." };
  const ean = semZeros(String(prods[0].ean)).padStart(13, "0"), nome = limpa(b.nome, 120), marca = limpa(b.marca, 60), descricao = limpa(b.descricao, 500), categoria = String(b.categoria_id || ""), disp = String(b.disponibilidade || ""), img = String(b.imagem_url || "").trim();
  if (nome.length < 5) return { ok: false, msg: "Escreva o nome do produto." };
  if (!marca) return { ok: false, msg: "Preencha a marca (o site exige)." };
  if (!DISP.includes(disp)) return { ok: false, msg: "Escolha em qual loja o produto está disponível." };
  if (!/^https:\/\/\S+$/.test(img)) return { ok: false, msg: "Escolha uma foto (ou cole um endereço que comece com https://)." };
  if (!(await sanity(`count(*[_type == "categoria" && _id == $id])`, { id: categoria }))) return { ok: false, msg: "Categoria inválida." };
  const ja = await noSite(ean);
  if (ja) return { ok: true, ja_no_site: ja };

  // foto: baixa aqui e sobe para o Sanity (o site passa a servir a copia dele)
  let assetId = "";
  try {
    const r = await fetch(img, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NovaRaphaellaSync/1.0", Accept: "image/avif,image/webp,image/*,*/*;q=0.8" }, redirect: "follow" });
    if (!r.ok) throw new Error("o site da foto respondeu " + r.status);
    const ct = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!ct.startsWith("image/")) throw new Error("o endereço não é de uma imagem");
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.byteLength < 5000) throw new Error("a imagem é pequena demais");
    if (bytes.byteLength > 12_000_000) throw new Error("a imagem é grande demais");
    const up = await fetch(`${SANITY_API}/assets/images/${DATASET}?filename=${encodeURIComponent(slugify(nome) + ".jpg")}`, { method: "POST", headers: { Authorization: `Bearer ${Deno.env.get("SANITY_TOKEN")}`, "Content-Type": ct }, body: bytes });
    if (!up.ok) throw new Error("o Sanity recusou a imagem (" + up.status + ")");
    assetId = (await up.json()).document._id;
  } catch (e) { return { ok: false, foto: true, msg: "Não consegui usar essa foto: " + limpa((e as Error).message, 140) + ". Escolha outra." }; }

  let slug = slugify(nome);
  if (await sanity(`count(*[_type == "produto" && slug.current == $slug])`, { slug })) slug = `${slug}-${ean.slice(-4)}`;
  const docId = "produto-" + semZeros(ean).padStart(13, "0");
  const doc = { _id: docId, _type: "produto", nome, slug: { _type: "slug", current: slug }, ean, marca, categoria: { _type: "reference", _ref: categoria }, descricao: descricao || undefined,
    disponibilidade: disp, destaque: false, ativo: true, imagem: { _type: "image", alt: nome, asset: { _type: "reference", _ref: assetId } } };
  const m = await fetch(`${SANITY_API}/data/mutate/${DATASET}?returnIds=true`, { method: "POST", headers: { Authorization: `Bearer ${Deno.env.get("SANITY_TOKEN")}`, "Content-Type": "application/json" }, body: JSON.stringify({ mutations: [{ createIfNotExists: doc }] }) });
  if (!m.ok) return { ok: false, msg: "O Sanity recusou o produto: " + (await m.text()).slice(0, 200) };
  // historico na fila (evita reenvio e mostra o que ja foi)
  await supabase.from("site_import_queue").upsert({ ean, nome, marca, categoria_id: categoria, descricao, imagem_url: img, disponibilidade: disp, status: "ok", sanity_id: docId, erro: null, tentativas: 0, processed_at: new Date().toISOString() }, { onConflict: "ean" });
  return { ok: true, publicado: true, slug, id: docId };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return resp({ ok: false, msg: "use POST" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    const p = await fetch(URL_SB + "/rest/v1/rpc/permitido", { method: "POST", headers: { apikey: ANON, Authorization: auth, "Content-Type": "application/json" }, body: "{}" });
    if (!p.ok || (await p.json()) !== true) return resp({ ok: false, erro: "sem_permissao", msg: "Entre no sistema de novo." }, 403);
    if (!Deno.env.get("SANITY_TOKEN")) return resp({ ok: false, msg: "Falta o segredo SANITY_TOKEN no Supabase." });
    const b = await req.json().catch(() => ({}));
    if (b?.acao === "preparar") return resp(await preparar(String(b.ean || "")));
    if (b?.acao === "publicar") return resp(await publicar(b));
    return resp({ ok: false, msg: "ação desconhecida" }, 400);
  } catch (e) {
    return resp({ ok: false, erro: "interno", msg: limpa((e as Error)?.message || e, 300) });
  }
});
