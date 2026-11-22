// Envia as notificações do sistema para os celulares/computadores inscritos (Web Push).
// Chamada a cada minuto pelo pg_cron (avisos_cron) quando há evento novo em avisos_eventos.
// Chaves VAPID: tabela avisos_config (sem acesso pelo site; só esta função lê). Autorização: cabeçalho x-cron-token = bling_auth.cron_token.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });

type Evento = { id: number; tipo: string; email: string | null; titulo: string; corpo: string | null; url: string | null; tag: string | null };
type Destino = { id: number; email: string; endpoint: string; p256dh: string; auth: string };

const brl = (v: number) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// muitas vendas de uma vez (ex.: Bling reconectado) viram um aviso só
function agrupar(evs: Evento[]): Evento[] {
  const vendas = evs.filter(e => e.tipo === "venda_mkt" && !e.email);
  if (vendas.length <= 4) return evs;
  let total = 0; const porCanal: Record<string, number> = {};
  for (const v of vendas) {
    const m = /R\$\s*([\d.]+,\d{2})/.exec(v.corpo || ""); if (m) total += Number(m[1].replace(/\./g, "").replace(",", "."));
    const c = (v.titulo || "").replace(/^Venda nova · /, ""); porCanal[c] = (porCanal[c] || 0) + 1;
  }
  const resumo: Evento = { id: vendas[0].id, tipo: "venda_mkt", email: null, titulo: `${vendas.length} vendas novas · ${brl(total)}`,
    corpo: Object.entries(porCanal).map(([c, n]) => `${c}: ${n}`).join(" · "), url: "/#separacao", tag: "vendas-lote" };
  return [...evs.filter(e => !(e.tipo === "venda_mkt" && !e.email)), resumo];
}

Deno.serve(async (req: Request) => {
  try {
    const tok = req.headers.get("x-cron-token") || "";
    const { data: a } = await sb.from("bling_auth").select("cron_token").eq("id", 1).maybeSingle();
    if (!a?.cron_token || tok !== a.cron_token) return json({ ok: false, erro: "sem_permissao" }, 403);

    const { data: cfg } = await sb.from("avisos_config").select("vapid_public, vapid_private, subject").eq("id", 1).maybeSingle();
    if (!cfg?.vapid_public || !cfg?.vapid_private) return json({ ok: false, erro: "faltam as chaves VAPID" }, 500);
    webpush.setVapidDetails(cfg.subject || "mailto:novaraphaella@gmail.com", cfg.vapid_public, cfg.vapid_private);

    const body = await req.json().catch(() => ({}));
    if (body?.acao === "diagnostico") {
      // monta uma mensagem cifrada sem enviar, para conferir que a biblioteca funciona aqui
      const k = webpush.generateVAPIDKeys();
      const fake = { endpoint: "https://fcm.googleapis.com/fcm/send/teste", keys: { p256dh: "BNKpBrhFwdaSH5YIBZPxF_7LcZYvITCz-HWOQn53YDGv-aK-qGmqRx1tSp95fSYRcAgdCsLuoks38QYNgbrNlnI", auth: "mM6zIAGZ6LbyS_WRcATzyA" } };
      const d = webpush.generateRequestDetails(fake, "oi", {});
      return json({ ok: true, vapid_ok: !!k.publicKey, cifrado: d.body?.length ?? 0 });
    }

    const { data: evs, error } = await sb.rpc("avisos_pegar");
    if (error) return json({ ok: false, erro: error.message }, 500);
    const lista = agrupar((evs || []) as Evento[]);
    let enviados = 0, falhas = 0, removidos = 0;
    for (const ev of lista) {
      const { data: dest } = await sb.rpc("avisos_destinos", { p_tipo: ev.tipo, p_email: ev.email });
      const payload = JSON.stringify({ title: ev.titulo, body: ev.corpo || "", url: ev.url || "/", tag: ev.tag || ev.tipo });
      const res = await Promise.all(((dest || []) as Destino[]).map(async d => {
        try {
          await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload, { TTL: 6 * 3600, urgency: ev.tipo === "trava" ? "high" : "normal" });
          await sb.from("avisos_aparelhos").update({ ultimo_ok: new Date().toISOString(), falhas: 0 }).eq("id", d.id);
          return "ok";
        } catch (e) {
          const st = (e as { statusCode?: number })?.statusCode;
          if (st === 404 || st === 410) { await sb.from("avisos_aparelhos").delete().eq("id", d.id); return "removido"; }
          await sb.rpc("avisos_falhou", { p_id: d.id }).then(() => {}, () => {});
          return "falha " + (st || String((e as Error)?.message || e).slice(0, 80));
        }
      }));
      enviados += res.filter(r => r === "ok").length; removidos += res.filter(r => r === "removido").length; falhas += res.filter(r => r.startsWith("falha")).length;
      await sb.from("avisos_eventos").update({ resultado: `${res.length} aparelho(s): ` + (res.join(", ") || "ninguém inscrito") }).eq("id", ev.id);
    }
    return json({ ok: true, eventos: (evs || []).length, enviados, falhas, removidos });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
