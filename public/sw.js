self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    return;
  }

  const destination = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")
    ? data.url
    : "/notices";
  const options = {
    body: typeof data.body === "string" ? data.body : "새 알림이 도착했습니다. 앱에서 확인하세요.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: typeof data.tag === "string" ? data.tag : "science-inquiry-notice",
    renotify: Boolean(data.renotify),
    data: { url: destination },
  };

  event.waitUntil(self.registration.showNotification("과탐실 알림", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = event.notification.data?.url || "/notices";
  const targetUrl = new URL(destination, self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("navigate" in client) await client.navigate(targetUrl);
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
