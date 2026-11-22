// Sistema das Lojas — Nova Raphaella
// Roda em segundo plano no aparelho: recebe as notificações do sistema e abre a tela certa ao tocar.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: "Nova Raphaella", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Nova Raphaella", {
    body: d.body || "",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: "/icone-192.png",
    badge: "/selo-96.png",
    data: { url: d.url || "/" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin);
  e.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of abertas) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      await c.focus();
      c.postMessage({ abrir: alvo.hash.slice(1) });  // o sistema já aberto só troca de aba
      return;
    }
    await self.clients.openWindow(alvo.href);
  })());
});
