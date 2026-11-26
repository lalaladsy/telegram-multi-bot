// One-time activation for the manager bot:
// GET /api/setupmanager?key=<SETUP_SECRET>
// Points MANAGER_BOT_TOKEN's webhook at /api/manager on this deployment.

export const config = { runtime: "edge" };

// Telegram calls here must never hang the function: hard 8s timeout each.
async function tgFetch(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(request) {
  const url = new URL(request.url);
  const secret = process.env.SETUP_SECRET;
  if (!secret || url.searchParams.get("key") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }
  const token = process.env.MANAGER_BOT_TOKEN;
  if (!token) return new Response("MANAGER_BOT_TOKEN not set", { status: 500 });

  const webhookUrl = `${url.origin}/api/manager`;
  const res = await tgFetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  const data = await res.json();
  const meRes = await tgFetch(`https://api.telegram.org/bot${token}/getMe`);
  const me = await meRes.json();
  return new Response(
    JSON.stringify({ webhook: webhookUrl, manager_bot: me.result?.username || null, telegram: data }, null, 2),
    { headers: { "Content-Type": "application/json" } }
  );
}
