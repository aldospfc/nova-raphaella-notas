import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument } from "npm:pdf-lib@1.17.1";

// Le um romaneio / pedido / DANFE em PDF ou foto e devolve os itens em JSON, para o site abrir como entrada sem XML.
// A chave da Anthropic fica so aqui, no segredo ANTHROPIC_API_KEY. Quem chama precisa estar logado e na lista de usuarios permitidos.
// Modelo: Opus por escolha do Aldo (18/11/2026); para trocar sem publicar de novo, crie o segredo ROMANEIO_MODELO.
// v4 (19/11/2026): PDF com varias paginas e dividido em partes de 1 pagina, lidas em paralelo e juntadas aqui,
// porque um romaneio de 150 itens nao cabia numa resposta so (estourava max_tokens).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const INSTRUCOES = `Voce le documentos de compra de uma papelaria brasileira (romaneio, pedido de fornecedor, DANFE, orcamento), em PDF ou foto, e devolve os dados em JSON.

Regras:
- Copie exatamente o que esta impresso. Nunca invente, complete ou estime item, quantidade ou valor. Se um campo nao aparece ou esta ilegivel, use null.
- Uma entrada em "itens" por linha de produto do documento, na ordem em que aparecem. Nao junte linhas e nao repita a mesma linha (fotos de paginas vizinhas podem se sobrepor).
- Numeros no JSON com ponto decimal e sem separador de milhar (1.234,56 vira 1234.56).
- "qtd" e a quantidade da linha na unidade em que foi vendida (caixa, display, pacote, unidade), como impresso. "vun" e o valor unitario dessa mesma unidade e "vtotal" o total da linha.
- "emb" e quantas unidades de prateleira vem dentro de UMA unidade vendida, quando o documento diz: coluna de embalagem (CX/24, DP/15, FD/10) ou a descricao (CX 50UN, DP12UN, PT 24UN, C/50, DP 18X3UN = 54, 12pctX600g = 12). Se a unidade vendida ja e o item de prateleira, ou se nao da para saber, use null.
- "ipi" e "st" sao os VALORES em reais de IPI e de ICMS-ST daquela linha, quando o documento mostra por linha; se mostra so a aliquota, calcule o valor (aliquota x total da linha) e avise em "obs"; se nao mostra, null.
- "ean" so quando o codigo de barras esta impresso na linha (8, 12, 13 ou 14 digitos). "cod" e o codigo ou referencia do fornecedor.
- "boletos": duplicatas / parcelas com vencimento (AAAA-MM-DD) e valor, exatamente como impressas. Sem duplicatas no documento, lista vazia. Um arquivo ou pagina que seja um BOLETO BANCARIO (ficha de compensacao, linha digitavel, "vencimento", "valor do documento") entra aqui com o vencimento e o valor do documento e NUNCA vira item; use o numero do documento como "n".
- Totais impressos no rodape vao em "totais" (null quando nao aparecem). Nao calcule os totais: so copie.
- Em "obs" liste, em portugues e em frases curtas, tudo o que merece atencao de quem vai conferir: trecho ilegivel, pagina cortada, linha em duvida, desconto geral, frete, diferenca que voce notou.
- Voce pode estar recebendo so UMA parte (uma pagina) de um documento maior: leia apenas os itens que aparecem nela; cabecalho, totais e boletos so se estiverem impressos nela (senao null / lista vazia). Nao comente que faltam paginas.

Responda SOMENTE com um objeto JSON, sem texto antes ou depois, neste formato:
{"fornecedor": string|null, "cnpj": string|null, "numero": string|null, "data": "AAAA-MM-DD"|null, "tipo": "romaneio"|"pedido"|"danfe"|"orcamento"|"outro",
 "itens": [{"cod": string|null, "ean": string|null, "desc": string, "qtd": number, "un": string|null, "emb": number|null, "vun": number|null, "vtotal": number|null, "ipi": number|null, "st": number|null}],
 "totais": {"produtos": number|null, "ipi": number|null, "st": number|null, "desconto": number|null, "frete": number|null, "total": number|null, "quantidade": number|null},
 "boletos": [{"n": string|null, "venc": "AAAA-MM-DD"|null, "valor": number}],
 "obs": [string]}`;

type Bloco = { type: string; source: { type: string; media_type: string; data: string } };

function b64ParaBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesParaB64(b: Uint8Array): string {
  let s = ""; const passo = 0x8000;
  for (let i = 0; i < b.length; i += passo) s += String.fromCharCode(...b.subarray(i, i + passo));
  return btoa(s);
}
// divide um PDF em partes de 1 pagina; se nao conseguir abrir, devolve o original inteiro
async function partesDoPdf(b64: string): Promise<string[]> {
  try {
    const src = await PDFDocument.load(b64ParaBytes(b64), { ignoreEncryption: true });
    const n = src.getPageCount();
    if (n <= 1) return [b64];
    const partes: string[] = [];
    for (let i = 0; i < n; i++) {
      const d = await PDFDocument.create();
      const [p] = await d.copyPages(src, [i]); d.addPage(p);
      partes.push(bytesParaB64(await d.save()));
    }
    return partes;
  } catch (_e) { return [b64]; }
}

async function lerParte(chave: string, modelo: string, blocos: Bloco[], nota: string) {
  const conteudo: unknown[] = [...blocos, { type: "text", text: "Leia o documento acima" + nota + " e devolva o JSON." }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: modelo, max_tokens: 32000, system: INSTRUCOES, messages: [{ role: "user", content: conteudo }] }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error("A API da Anthropic recusou o pedido: " + (j?.error?.message || ("erro " + r.status)) + " [" + r.status + "]");
  const texto = (j?.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  const i = texto.indexOf("{"), f = texto.lastIndexOf("}");
  let dados = null;
  try { dados = JSON.parse(texto.slice(i, f + 1)); } catch (_e) { dados = null; }
  return { dados, uso: j?.usage || null, cortado: j?.stop_reason === "max_tokens" };
}

const num = (x: unknown) => (typeof x === "number" && isFinite(x) ? x : null);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const p = await fetch(url + "/rest/v1/rpc/permitido", { method: "POST", headers: { apikey: anon, Authorization: auth, "Content-Type": "application/json" }, body: "{}" });
    if (!p.ok || (await p.json()) !== true) return resp({ ok: false, erro: "sem_permissao", msg: "Entre no sistema de novo para usar a leitura de romaneio." }, 403);

    const chave = Deno.env.get("ANTHROPIC_API_KEY");
    if (!chave) return resp({ ok: false, erro: "sem_chave", msg: "A chave da API ainda nao foi cadastrada no Supabase (segredo ANTHROPIC_API_KEY)." });

    const corpo = await req.json();
    const arquivos = Array.isArray(corpo?.arquivos) ? corpo.arquivos : [];
    if (!arquivos.length || arquivos.length > 10) return resp({ ok: false, erro: "arquivos", msg: "Envie de 1 a 10 arquivos." });

    // cada "parte" vira uma chamada a API: um PDF de varias paginas gera uma parte por pagina; imagens ficam juntas em uma parte so
    const partes: Bloco[][] = [];
    const imagens: Bloco[] = [];
    let tam = 0;
    for (const a of arquivos) {
      const tipo = String(a?.tipo || ""), dados = String(a?.dados || "");
      tam += dados.length;
      if (tam > 24_000_000) return resp({ ok: false, erro: "tamanho", msg: "Arquivos grandes demais. Envie menos paginas por vez." });
      if (tipo === "application/pdf") {
        for (const pg of await partesDoPdf(dados)) partes.push([{ type: "document", source: { type: "base64", media_type: tipo, data: pg } }]);
      } else if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(tipo)) {
        imagens.push({ type: "image", source: { type: "base64", media_type: tipo, data: dados } });
      } else return resp({ ok: false, erro: "tipo", msg: "Tipo de arquivo nao aceito: " + tipo });
    }
    if (imagens.length) partes.push(imagens);
    if (partes.length > 12) return resp({ ok: false, erro: "paginas", msg: "Documento com " + partes.length + " paginas: envie no maximo 12 por vez." });

    const modelo = Deno.env.get("ROMANEIO_MODELO") || "claude-opus-5-5";
    const varias = partes.length > 1;
    const resultados = await Promise.all(partes.map((bl, i) => lerParte(chave, modelo, bl,
      (bl.length > 1 ? " (as imagens sao paginas ou partes do mesmo documento, na ordem)" : "") + (varias ? ` (esta e a parte ${i + 1} de ${partes.length} do documento)` : ""))
      .catch((e) => ({ dados: null, uso: null, cortado: false, erro: String((e as Error)?.message || e) }))));
    const falhas = resultados.map((r) => (r as { erro?: string }).erro).filter(Boolean) as string[];

    const validos = resultados.filter((r) => r.dados && Array.isArray(r.dados.itens));
    if (!validos.length) {
      if (falhas.length) return resp({ ok: false, erro: "api", msg: falhas[0], modelo });
      return resp({ ok: false, erro: "leitura", msg: resultados.some((r) => r.cortado) ? "O documento e grande demais para ler de uma vez. Envie em partes (menos paginas por vez)." : "A IA nao devolveu os itens em formato valido. Tente de novo ou envie uma imagem mais nitida." });
    }
    // junta as partes: cabecalho da primeira que tiver, itens na ordem, totais/boletos de quem os trouxe
    const dados: Record<string, unknown> = { fornecedor: null, cnpj: null, numero: null, data: null, tipo: "outro", itens: [], totais: { produtos: null, ipi: null, st: null, desconto: null, frete: null, total: null, quantidade: null }, boletos: [], obs: [] };
    const itens: unknown[] = [], boletos: unknown[] = [], obs: string[] = [];
    const tot = dados.totais as Record<string, number | null>;
    resultados.forEach((r, i) => {
      if (!r.dados || !Array.isArray(r.dados.itens)) { obs.push(`Parte ${i + 1}: nao consegui ler (${(r as { erro?: string }).erro || "resposta invalida"}); confira essa pagina a mao.`); return; }
      const d = r.dados;
      for (const k of ["fornecedor", "cnpj", "numero", "data"]) if (dados[k] == null && d[k] != null) dados[k] = d[k];
      if (dados.tipo === "outro" && d.tipo && d.tipo !== "outro") dados.tipo = d.tipo;
      itens.push(...d.itens);
      if (Array.isArray(d.boletos)) boletos.push(...d.boletos);
      if (d.totais && typeof d.totais === "object") for (const k of Object.keys(tot)) { const v = num(d.totais[k]); if (v != null && (tot[k] == null || i > 0)) tot[k] = v; }
      if (Array.isArray(d.obs)) for (const o of d.obs) if (typeof o === "string" && o.trim()) obs.push(varias ? `Pág. ${i + 1}: ${o}` : o);
      if (r.cortado) obs.push(`Parte ${i + 1}: a leitura foi cortada; podem faltar itens no fim dessa pagina.`);
    });
    dados.itens = itens; dados.boletos = boletos; dados.obs = obs;
    const uso = resultados.reduce((a, r) => ({ input_tokens: a.input_tokens + (r.uso?.input_tokens || 0), output_tokens: a.output_tokens + (r.uso?.output_tokens || 0) }), { input_tokens: 0, output_tokens: 0 });
    return resp({ ok: true, dados, modelo, uso, partes: partes.length, cortado: resultados.some((r) => r.cortado) });
  } catch (e) {
    return resp({ ok: false, erro: "interno", msg: String((e as Error)?.message || e) }, 500);
  }
});
