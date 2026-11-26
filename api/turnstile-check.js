// Turnstile server-side check: POST { b, s, token }
// Validates the one-time session (tsess:<s> in the bot's KV namespace),
// verifies the token with Cloudflare siteverify, and on success writes the
// same state bot.js writes when a user passes the quiz verification:
//   verified:<userId> = "1" (30d), probation:<userId> = strong snapshot,
//   needs_verify / challenge cleared. Then notifies the user via the bot.

import { createKV } from "../lib/kv.js";

export const config = { runtime: "edge" };

// 与 lib/bot.js 的 CONFIG 对齐（答题通过时的写入参数）
const VERIFIED_EXPIRE_SECONDS = 2592000; // 30 天
const PROBATION_STRONG_HOURS = 48;
const PROBATION_STRONG_MSG_LIMIT = 2;

function redisCreds() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ ok: false }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }
  const b = body && body.b ? String(body.b) : "";
  const s = body && body.s ? String(body.s) : "";
  const token = body && body.token ? String(body.token) : "";
  if (!b || !s || !token) return json({ ok: false }, 400);

  const { url: rUrl, token: rToken } = redisCreds();
  const registry = createKV(rUrl, rToken);
  if (!registry) return json({ ok: false }, 500);

  let reg = null;
  try {
    reg = await registry.get(`multi:bot:${b}`, { type: "json" });
  } catch {
    reg = null;
  }
  if (!reg || !reg.token) return json({ ok: false }, 404);

  const kv = createKV(rUrl, rToken, `b${b}:`);
  let sess = null;
  try {
    sess = await kv.get(`tsess:${s}`, { type: "json" });
  } catch {
    sess = null;
  }
  if (!sess || sess.userId === undefined || sess.userId === null) return json({ ok: false }, 400);
  if (sess.exp && sess.exp <= Date.now()) return json({ ok: false }, 400);
  const userId = sess.userId;

  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  if (!secret) return json({ ok: false }, 500);

  let verifyData = null;
  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    verifyData = await res.json();
  } catch {
    verifyData = null;
  }
  if (!verifyData || verifyData.success !== true) {
    return json({ ok: false });
  }

  // 验证通过：写入与答题通过一致的状态（strong 档 probation 快照）
  await kv.delete(`tsess:${s}`);
  await kv.delete(`tsess_by_user:${userId}`);
  await kv.put(`verified:${userId}`, "1", { expirationTtl: VERIFIED_EXPIRE_SECONDS });
  await kv.put(
    `probation:${userId}`,
    JSON.stringify({ ts: Date.now(), hours: PROBATION_STRONG_HOURS, limit: PROBATION_STRONG_MSG_LIMIT, ban: 2 }),
    { expirationTtl: PROBATION_STRONG_HOURS * 3600 }
  );
  await kv.delete(`probation_count:${userId}`);
  await kv.delete(`needs_verify:${userId}`);
  await kv.delete(`verify_fails:${userId}`);
  await kv.delete(`challenge:${userId}`);
  await kv.delete(`user_challenge:${userId}`);

  // 通知用户回到对话重新发送消息
  try {
    await fetch(`https://api.telegram.org/bot${reg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        text: "✅ 真人验证通过！请重新发送您刚才的消息。\n\n⚠️ 温馨提示：\n您正处于 48 小时观察期，期间系统会按行为计分：发送链接、广告词、手机号等都会加分，累计 2 分将被直接拉黑。\n解除观察期有两种方式：① 等满 48 小时且期间未达到拉黑分数；② 您发送的前两条消息都是正常干净的消息，即可提前解除。\n解除观察期后仍实行月度计分：以 30 天为一个周期累计计分，累计 20 分机主将收到提醒并决定是否拉黑，请持续规范言行。",
      }),
    });
  } catch {
    // 通知失败不影响验证结果
  }

  return json({ ok: true });
}
