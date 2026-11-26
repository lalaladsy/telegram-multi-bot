// Multi-bot Vercel Edge entry: one deployment serves many bots.
// Telegram webhook URL per bot: https://<project>.vercel.app/api/webhook?b=<botId>
// Bot registry lives in Redis under multi:bot:<botId> = { token, owner, secret }.
// Each bot's data is namespaced with prefix b<botId>: inside the same Redis.

import { waitUntil } from "@vercel/functions";
import bot from "../lib/bot.js";
import { createKV } from "../lib/kv.js";
import { setBotMenus, MENU_VERSION } from "../lib/menus.js";

export const config = { runtime: "edge" };

function redisCreds() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const botId = url.searchParams.get("b");
  const { url: rUrl, token: rToken } = redisCreds();

  if (!botId) {
    return new Response("OK multi (add ?b=<botId>)", { status: 200 });
  }

  const registry = createKV(rUrl, rToken);
  if (!registry) return new Response("Redis not configured", { status: 500 });

  let reg = null;
  try {
    reg = await registry.get(`multi:bot:${botId}`, { type: "json" });
  } catch {
    reg = null;
  }
  if (!reg || !reg.token || !reg.owner) {
    return new Response("Bot not registered", { status: 404 });
  }

  // Verify Telegram webhook secret token when one is registered.
  if (reg.secret) {
    const got = request.headers.get("x-telegram-bot-api-secret-token");
    if (got !== reg.secret) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  // Lazy command-menu setup: (re)set when the stored menu version is stale.
  if (reg.menuSet !== MENU_VERSION) {
    try {
      const ok = await setBotMenus(reg.token, reg.owner);
      if (ok) {
        reg.menuSet = MENU_VERSION;
        await registry.put(`multi:bot:${botId}`, JSON.stringify(reg));
      }
    } catch {}
  }

  const env = {
    TOPIC_MAP: createKV(rUrl, rToken, `b${botId}:`),
    BOT_TOKEN: reg.token,
    OWNER_ID: String(reg.owner),
    SUPERGROUP_ID: "",
    ADMIN_IDS: "",
    API_BASE: process.env.API_BASE || "",
    BOT_ID: botId,
    WEBHOOK_SECRET: reg.secret || "",
    APP_ORIGIN: url.origin,
    TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY || "",
  };
  const ctx = {
    waitUntil: (p) => {
      try {
        waitUntil(p);
      } catch {
        Promise.resolve(p).catch(() => {});
      }
    },
  };
  return bot.fetch(request, env, ctx);
}
