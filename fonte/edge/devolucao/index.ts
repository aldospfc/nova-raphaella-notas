import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Nota de devolução de compra: cria um RASCUNHO de NF-e no Bling (situação "pendente") para o Aldo conferir e emitir lá.
// - Só cria; NUNCA envia a nota à SEFAZ (não existe chamada de emissão aqui).
// - Força sempre: saída (tipo 1), finalidade 4 (devolução) e a natureza "Devolução de compra" do Bling da Nova Raphaella.
// - Usa o token do Bling guardado em bling_auth (renovado pela função "bling", que roda de 5 em 5 minutos).
// - Registra o rascunho em devolucoes_bling (histórico e saldo devolvível por item da nota de origem).
// v1 (27/11/2026).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const API = "https://api.bling.com.br/Api/v3";
const NATUREZA_DEVOLUCAO_COMPRA = 14220696243;
const URL_SB = Deno.env.get("SUPABASE_URL")!, SERVICO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const cabServico = { apikey: SERVICO, Authorization: "Bearer " + SERVICO, "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return resp({ ok: false, msg: "use POST" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    const p = await fetch(URL_SB + "/rest/v1/rpc/permitido", { method: "POST", headers: { apikey: ANON, Authorization: auth, "Content-Type": "application/json" }, body: "{}" });
    if (!p.ok || (await p.json()) !== true) return resp({ ok: false, erro: "sem_permissao", msg: "Entre no sistema de novo." }, 403);
    let email = ""; try { email = JSON.parse(atob(auth.replace(/^Bearer\s+/i, "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || ""; } catch { /* */ }

    const corpo = await req.json().catch(() => ({}));
    if (String(corpo?.acao || "") !== "criar") return resp({ ok: false, msg: "ação desconhecida" }, 400);
    const nfe = corpo.nfe, reg = corpo.registro || {};
    const dig = (v: unknown) => String(v ?? "").replace(/\D/g, "");
    if (!nfe || typeof nfe !== "object" || !Array.isArray(nfe.itens) || !nfe.itens.length || nfe.itens.length > 200) return resp({ ok: false, msg: "A nota precisa ter de 1 a 200 itens." });
    if (dig(nfe.contato?.numeroDocumento).length !== 14) return resp({ ok: false, msg: "CNPJ do fornecedor inválido." });
    if (dig(nfe.documentoReferenciado?.chaveAcesso).length !== 44) return resp({ ok: false, msg: "Chave da nota de origem inválida." });
    for (const i of nfe.itens) if (!(Number(i.quantidade) > 0) || !(Number(i.valor) >= 0) || !String(i.descricao || "").trim()) return resp({ ok: false, msg: "Item sem descrição, quantidade ou valor." });
    // o que não pode variar
    nfe.tipo = 1; nfe.finalidade = 4; nfe.naturezaOperacao = { id: NATUREZA_DEVOLUCAO_COMPRA };

    const a = await (await fetch(URL_SB + "/rest/v1/bling_auth?id=eq.1&select=access_token,expires_at", { headers: cabServico })).json();
    const tk = a?.[0];
    if (!tk?.access_token) return resp({ ok: false, msg: "O Bling não está ligado ao sistema (Produtos → Bling → ligar)." });
    if (tk.expires_at && new Date(tk.expires_at).getTime() < Date.now() + 30000) return resp({ ok: false, msg: "A ligação com o Bling está sendo renovada. Tente de novo em alguns minutos." });

    const r = await fetch(API + "/nfe", { method: "POST", headers: { Authorization: "Bearer " + tk.access_token, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(nfe) });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { /* */ }
    if (r.status !== 201 && r.status !== 200) {
      const e = j?.error, det = Array.isArray(e?.fields) ? e.fields.map((f: any) => `${f.element || ""}: ${f.msg || ""}`).join(" | ") : "";
      return resp({ ok: false, status: r.status, msg: "O Bling recusou a nota: " + [e?.message, e?.description, det].filter(Boolean).join(" — ").slice(0, 600) || txt.slice(0, 300) });
    }
    const d = j?.data || {};
    await fetch(URL_SB + "/rest/v1/devolucoes_bling", { method: "POST", headers: { ...cabServico, Prefer: "return=minimal" },
      body: JSON.stringify({ chave: dig(nfe.documentoReferenciado.chaveAcesso), cnpj: dig(nfe.contato.numeroDocumento), bling_id: d.id ?? null, numero: d.numero ?? null, serie: d.serie != null ? String(d.serie) : null,
        itens: Array.isArray(reg.itens) ? reg.itens.slice(0, 200) : [], total: Number(reg.total) || null, motivo: String(reg.motivo || "").slice(0, 300), criado_por: email }) });
    return resp({ ok: true, id: d.id, numero: d.numero, serie: d.serie, alertas: d.alertas || [], link: "https://www.bling.com.br/notas.fiscais.php#edit/" + d.id });
  } catch (e) {
    return resp({ ok: false, msg: String((e as Error).message || e) }, 500);
  }
});
