import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Le uma lista de material escolar (fotos, PDF ou texto) e devolve os itens ja casados com o catalogo de itens genericos da loja.
// Portado do app Streamlit "orcamento-listas" (lib/ia.py). Chave da Anthropic no segredo ANTHROPIC_API_KEY; modelo em ROMANEIO_MODELO (padrao Opus).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const FERRAMENTA = {
  name: "registrar_lista",
  description: "Registra os itens encontrados na lista de material escolar.",
  input_schema: {
    type: "object",
    properties: {
      escola: { type: "string", description: "Nome da escola, se aparecer na lista. Senao, vazio." },
      serie: { type: "string", description: "Serie/ano/turma, se aparecer. Senao, vazio." },
      itens: {
        type: "array",
        items: {
          type: "object",
          properties: {
            descricao: { type: "string", description: "Item como esta na lista, limpo e sem a quantidade na frente. Ex.: 'Caderno brochura capa dura 96 folhas'." },
            quantidade: { type: "number", description: "Quantidade pedida. Se nao houver, 1." },
            item_generico_id: { type: ["string", "null"], description: "ID do item generico do catalogo que corresponde a este item, ou null se nao tiver certeza." },
            vendemos: { type: "boolean", description: "false para coisas que uma papelaria nao vende: livros didaticos, uniforme, itens de higiene, alimentos, remedios." },
            novo_item_generico: {
              type: ["object", "null"],
              description: "So quando item_generico_id e null E vendemos e true: proposta de item generico novo para o catalogo. Caso contrario, null.",
              properties: {
                nome: { type: "string", description: "Nome padronizado, no estilo do catalogo. Ex.: 'Caderno de receitas', 'Papel celofane (folha)'. Sem marca." },
                categoria: { type: "string", description: "Uma das categorias ja usadas no catalogo (Cadernos, Escrita, Cor e desenho, Acessorios, Colas e fitas, Papeis, Artes, Pastas e organizacao, Mochilas e lancheiras, Outros)." },
                palavras_chave: { type: "string", description: "3 a 6 variacoes de como esse item aparece em listas, separadas por virgula." },
              },
              required: ["nome", "categoria", "palavras_chave"],
            },
          },
          required: ["descricao", "quantidade", "item_generico_id", "vendemos", "novo_item_generico"],
        },
      },
    },
    required: ["itens"],
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const p = await fetch(url + "/rest/v1/rpc/permitido", { method: "POST", headers: { apikey: anon, Authorization: auth, "Content-Type": "application/json" }, body: "{}" });
    if (!p.ok || (await p.json()) !== true) return resp({ ok: false, erro: "sem_permissao", msg: "Entre no sistema de novo para usar a leitura de listas." }, 403);
    const chave = Deno.env.get("ANTHROPIC_API_KEY");
    if (!chave) return resp({ ok: false, erro: "sem_chave", msg: "A chave da API ainda nao foi cadastrada no Supabase (segredo ANTHROPIC_API_KEY)." });

    const corpo = await req.json();
    const arquivos = Array.isArray(corpo?.arquivos) ? corpo.arquivos : [];
    const texto = String(corpo?.texto || "").trim();
    const catalogo = Array.isArray(corpo?.catalogo) ? corpo.catalogo : [];
    const naoVend: string[] = Array.isArray(corpo?.nao_vendemos) ? corpo.nao_vendemos.map(String) : [];
    if (!arquivos.length && !texto) return resp({ ok: false, erro: "vazio", msg: "Envie uma foto, PDF ou o texto da lista." });

    const conteudo: unknown[] = [];
    let tam = 0;
    for (const a of arquivos) {
      const tipo = String(a?.tipo || ""), dados = String(a?.dados || "");
      tam += dados.length; if (tam > 24_000_000) return resp({ ok: false, erro: "tamanho", msg: "Arquivos grandes demais. Envie menos fotos por vez." });
      if (tipo === "application/pdf") conteudo.push({ type: "document", source: { type: "base64", media_type: tipo, data: dados } });
      else if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(tipo)) conteudo.push({ type: "image", source: { type: "base64", media_type: tipo, data: dados } });
      else return resp({ ok: false, erro: "tipo", msg: "Tipo de arquivo nao aceito: " + tipo });
    }
    if (texto) conteudo.push({ type: "text", text: "Lista em texto:\n\n" + texto });
    conteudo.push({ type: "text", text: "Extraia os itens desta lista e registre-os chamando a ferramenta registrar_lista. Nao responda em texto." });

    const cat = catalogo.map((g: { id: string; nome: string; categoria?: string; palavras?: string }) =>
      `- id ${g.id}: ${g.nome}` + (g.categoria ? ` [${g.categoria}]` : "") + (g.palavras ? ` — palavras: ${g.palavras}` : "")).join("\n") || "(catalogo vazio — deixe item_generico_id como null)";
    const sistema = `Voce le listas de material escolar de escolas brasileiras para uma papelaria de bairro em Sao Paulo.

Tarefa: extrair TODOS os itens da lista, um por linha da lista original, com a quantidade.
Regras:
- Mantenha a descricao proxima do original, mas limpa (sem numeracao, sem a quantidade repetida).
- Se a lista separa itens por bimestre ou por materia, junte tudo numa lista so, somando quantidades do mesmo item.
- "1 pacote", "1 caixa", "1 rolo" contam como quantidade 1 daquele item (o item generico ja e o pacote/caixa).
- Se a quantidade vier por extenso ("dois cadernos"), converta.
- Marque vendemos=false em coisas que a loja nao vende. Lista da loja: ${naoVend.join(", ") || "livros didaticos, uniforme, higiene, alimentos"}. Tambem livros didaticos/paradidaticos, uniforme, higiene pessoal, alimentos, remedios, fotos 3x4 e documentos.
- Para cada item, escolha o item generico do catalogo abaixo que corresponde. Use o id exatamente como esta. Se nenhum servir ou tiver duvida real (ex.: tamanho de caderno nao bate com nenhum), use null. NAO force.
- Quando usar null num item que a loja vende, proponha em novo_item_generico um item generico novo (nome padronizado, categoria, palavras-chave). Antes de propor, confira que nao existe nenhum parecido no catalogo — se existir um parecido, use o id dele em vez de criar. Dois itens da mesma lista que sejam a mesma coisa devem receber a MESMA proposta (mesmo nome).

Catalogo de itens genericos da loja:
${cat}

Responda SEMPRE chamando a ferramenta registrar_lista, nunca em texto.`;

    const modelo = Deno.env.get("ROMANEIO_MODELO") || "claude-opus-5-5";
    const mensagens: unknown[] = [{ role: "user", content: conteudo }];
    let dados: Record<string, unknown> | null = null, uso: unknown = null;
    for (let t = 0; t < 2 && !dados; t++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: modelo, max_tokens: 12000, system: sistema, tools: [FERRAMENTA], tool_choice: { type: "tool", name: "registrar_lista" }, messages: mensagens }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) return resp({ ok: false, erro: "api", status: r.status, msg: "A API da Anthropic recusou o pedido: " + (j?.error?.message || ("erro " + r.status)), modelo });
      uso = j?.usage || null;
      const bloco = (j?.content || []).find((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "registrar_lista");
      if (bloco) dados = bloco.input;
      else { mensagens.push({ role: "assistant", content: j?.content || [] }); mensagens.push({ role: "user", content: "Registre os itens chamando a ferramenta registrar_lista agora." }); }
    }
    if (!dados) return resp({ ok: false, erro: "leitura", msg: "A IA nao devolveu a lista estruturada. Tente de novo com uma foto mais nitida." });

    const ids = new Set(catalogo.map((g: { id: string }) => String(g.id)));
    const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const nvTermos = naoVend.map(norm).filter(Boolean);
    const itens = ((dados.itens as unknown[]) || []).map((raw) => {
      const it = raw as Record<string, unknown>;
      const desc = String(it.descricao || "").trim();
      let gid: string | null = it.item_generico_id == null ? null : String(it.item_generico_id);
      if (gid && !ids.has(gid)) gid = ids.has("g" + gid) ? "g" + gid : null;
      const d = norm(desc), bateu = nvTermos.find((t) => d.includes(t));
      const naoVende = it.vendemos === false || !!bateu;
      let prop = (!naoVende && !gid && it.novo_item_generico && typeof it.novo_item_generico === "object") ? it.novo_item_generico as Record<string, unknown> : null;
      if (prop && !String(prop.nome || "").trim()) prop = null;
      return { descricao: desc, quantidade: Number(it.quantidade) > 0 ? Number(it.quantidade) : 1, gid: naoVende ? null : gid,
        status: naoVende ? "nao_vendemos" : (gid ? "ok" : "pendente"),
        proposta: prop ? { nome: String(prop.nome || "").trim(), categoria: String(prop.categoria || "").trim(), palavras: String(prop.palavras_chave || "").trim() } : null };
    }).filter((i) => i.descricao);
    return resp({ ok: true, escola: String(dados.escola || ""), serie: String(dados.serie || ""), itens, modelo, uso });
  } catch (e) {
    return resp({ ok: false, erro: "interno", msg: String((e as Error)?.message || e) }, 500);
  }
});
