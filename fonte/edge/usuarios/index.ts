// Função "usuarios": o administrador cria a conta de um funcionário já com senha (sem depender de e-mail de confirmação)
// e troca a senha de quem esqueceu. Só administrador com a verificação em duas etapas (rpc eh_admin com o token de quem chama).
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const URL_SB = Deno.env.get("SUPABASE_URL")!, SERVICO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const adm = (caminho: string, init: RequestInit = {}) => fetch(URL_SB + "/auth/v1/admin/" + caminho, { ...init, headers: { apikey: SERVICO, Authorization: "Bearer " + SERVICO, "Content-Type": "application/json", ...(init.headers || {}) } });
const rpcComo = (auth: string, fn: string, corpo: unknown) => fetch(URL_SB + "/rest/v1/rpc/" + fn, { method: "POST", headers: { apikey: ANON, Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(corpo) });

async function contaPorEmail(email: string) {
  for (let pg = 1; pg <= 10; pg++) {
    const r = await adm(`users?page=${pg}&per_page=200`); if (!r.ok) throw new Error("não consegui ler as contas (" + r.status + ")");
    const j = await r.json(), l = j.users || [];
    const u = l.find((x: { email?: string }) => String(x.email || "").toLowerCase() === email); if (u) return u;
    if (l.length < 200) return null;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return resp({ ok: false, msg: "método" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    const p = await rpcComo(auth, "eh_admin", {});
    if (!p.ok || (await p.json()) !== true) return resp({ ok: false, msg: "Só administrador (com a verificação em duas etapas) faz isso. Entre no sistema de novo." }, 403);
    const c = await req.json().catch(() => ({}));
    const acao = String(c?.acao || ""), email = String(c?.email || "").trim().toLowerCase(), senha = String(c?.senha || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return resp({ ok: false, msg: "E-mail inválido." });
    if (senha.length < 8) return resp({ ok: false, msg: "A senha precisa ter pelo menos 8 caracteres." });

    if (acao === "criar") {
      // grava/atualiza a permissão com as mesmas regras da tela (como o administrador que chamou)
      if (c?.salvar !== false) {
        const s = await rpcComo(auth, "usuario_salvar", { p_email: email, p_nome: String(c?.nome || ""), p_perfil: String(c?.perfil || "separacao"), p_exige_2fa: c?.exige_2fa !== false, p_admin: !!c?.admin });
        if (!s.ok) { const e = await s.json().catch(() => ({})); return resp({ ok: false, msg: e?.message || "não deu para gravar a permissão" }); }
      }
      const r = await adm("users", { method: "POST", body: JSON.stringify({ email, password: senha, email_confirm: true }) });
      if (r.ok) return resp({ ok: true, msg: "Conta criada." });
      const e = await r.json().catch(() => ({}));
      if (r.status === 422 || /already|exist/i.test(JSON.stringify(e))) return resp({ ok: false, existe: true, msg: "Já existe uma conta com esse e-mail — use \"trocar senha\"." });
      return resp({ ok: false, msg: "Não deu para criar a conta: " + (e?.msg || e?.message || r.status) });
    }

    if (acao === "senha") {
      // só para quem está na lista de usuários do sistema
      const l = await fetch(URL_SB + `/rest/v1/usuarios_permitidos?select=email&email=eq.${encodeURIComponent(email)}`, { headers: { apikey: SERVICO, Authorization: "Bearer " + SERVICO } }).then(r => r.json());
      if (!Array.isArray(l) || !l.length) return resp({ ok: false, msg: "Esse e-mail não está na lista de usuários." });
      const u = await contaPorEmail(email);
      if (!u) return resp({ ok: false, msg: "Essa pessoa ainda não tem conta — use \"criar conta\"." });
      const r = await adm("users/" + u.id, { method: "PUT", body: JSON.stringify({ password: senha, email_confirm: true }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); return resp({ ok: false, msg: "Não deu para trocar a senha: " + (e?.msg || e?.message || r.status) }); }
      return resp({ ok: true, msg: "Senha trocada." });
    }
    return resp({ ok: false, msg: "ação desconhecida" });
  } catch (e) { return resp({ ok: false, msg: String((e as Error).message).slice(0, 300) }); }
});
