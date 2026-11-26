// Manager bot endpoint: open self-service bot factory inside Telegram.
// Webhook for the manager bot: https://<project>.vercel.app/api/manager
// ANY Telegram user can create their own forwarding bot: they just send
// their bot token as a plain message; the forwarding target (owner) is
// their own chat id. Each user only sees and manages their own bots.
//
// Interactions:
//   /start                     欢迎页（功能介绍 + 如何开始）
//   直接发送 Bot Token          自动验证并部署（也支持 /add <Token>）
//   /list                      查看我注册的 bot
//   /del <bot数字ID或@用户名>    注销我自己的一个 bot
//   /help                      用法

import { waitUntil } from "@vercel/functions";
import { createKV } from "../lib/kv.js";
import { setManagerMenus, setBotMenus, MENU_VERSION } from "../lib/menus.js";
import { escapeHtml } from "../lib/util.js";
import {
  getAiConfig as getMgrAiConfig,
  saveAiConfig as saveMgrAiConfig,
  maskAiKey as maskMgrAiKey,
  getAiBroken as getMgrAiBroken,
  fmtAiBrokenTime as fmtMgrBrokenTime,
  markAiAuthFailure,
  callAiChat,
  fetchAiModels as mgrFetchAiModels,
  testAiConnection,
  AI_DEFAULT_MODEL as MGR_AI_DEFAULT_MODEL,
  AI_SUMMARY_SYSTEM_PROMPT as MGR_AI_SUMMARY_SYSTEM_PROMPT,
  AI_SUMMARY_MATERIAL_MAX as MGR_AI_SUMMARY_MATERIAL_MAX,
  assembleSummaryMaterial,
  chunkSummaryText as mgrChunkText,
} from "../lib/ai.js";

export const config = { runtime: "edge" };

function redis() {
  return createKV(
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  );
}

function normalizeToken(raw) {
  return (raw || "").replace(/：/g, ":").trim();
}

// 从任意文本里提取 Bot Token（允许全角冒号）
function extractToken(text) {
  const m = (text || "").match(/(\d{6,})[:：]([A-Za-z0-9_-]{30,})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

async function tg(token, method, body) {
  // Hard 8s timeout: a hung Telegram call must never stall the function.
  // Callers all branch on .ok, so failures resolve as { ok: false } instead
  // of throwing; timeouts report error: "timeout".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json();
  } catch (e) {
    if (e && e.name === "AbortError") {
      return { ok: false, error: "timeout", description: "Request timeout" };
    }
    return { ok: false, error: "network", description: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function randomSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// escapeHtml 在 lib/util.js（顶部已 import）

// 统一排版：标题分隔线 / 块间轻分隔
const SEP = "━━━━━━━━━━━━";
const SUBSEP = "┄┄┄┄┄┄┄┄";

// 等级速览：WELCOME 与 HELP 共用同一段文案（验证二选一 + 答题三档 + 广告三档 + AI 辅助），口径与转发 bot /level、/ad 面板一致
const LEVEL_OVERVIEW = [
  "<b>等级速览</b>",
  "▸ 方式二选一：🧩答题（图片题）/ 🌐网页（真人验证）",
  "▸ 答题：🟢简易 1 轮答题｜观察期 24h 累计 8 分拉黑 · 🟡中等 2 轮答题（高风险 3 轮）+蜜罐｜观察期 24h 累计 5 分拉黑 · 🔴强力 3 轮答题+蜜罐（或网页真人验证）｜观察期 48h 累计 2 分拉黑",
  "▸ 观察期：验证通过后的考察期（简易 / 中等 24h、强力 48h），期间对方发的链接类消息会被拦下并通知您处理，干净消息发满 2 条自动解除；观察期内累计风险分达到本档拉黑线（简易 8 / 中等 5 / 强力 2 分）直接拉黑，并推送通知由您决定解封 / 加白 / 保持黑名单；也可发 /list 在观察期管理里提前解除",
  "▸ 广告：🟢宽松 5 分拦 / 🟡标准 3 分拦（链接+广告词）/ 🔴严格 2 分拦（单链接即拦）；计分：链接 +2 · 广告词 +2/个（上限 +4）· 手机号 +2；计分会累计：观察期内按档位累计 8 / 5 / 2 分直接拉黑并通知您处理；观察期结束后以 30 天为一个计分周期，累计 20 分会提醒您决定是否拉黑",
  "▸ 🤖AI 辅助（可选）：通过验证后，AI 结合头像 / 昵称 / 简介 / 首条发言识别广告号，疑似弹窗提醒您是否拉黑",
];

const WELCOME = [
  "🤖 <b>PM 机器人托管平台</b>",
  SEP,
  "在这里，您可以免费创建一个功能强大的私聊转发机器人。",
  "它能帮您接收陌生人的消息，隐藏您的真实身份，并自动拦截垃圾广告。",
  "",
  "🌟 <b>核心功能</b>",
  "▸ 智能验证：动态人机验证，自动拦截机器人和广告骚扰",
  "▸ 隐私回复：直接回复消息，对方看不到您的账号",
  "▸ 一键管理：消息下方自带屏蔽 / 加白按钮",
  "▸ 数据统计：查看有多少人联系过您",
  "▸ 命令菜单：注册后机器人自带命令菜单（点输入框旁的菜单按钮即可）",
  "▸ 验证三档可切换：简易 / 中等 / 强力，强力档含 Cloudflare 真人验证",
  "▸ 广告过滤三档可切换：宽松 / 标准 / 严格，自动拦截广告消息",
  "▸ AI 辅助（可选）：通过验证后，AI 结合头像 / 昵称 / 简介 / 首条发言识别广告号，疑似弹窗提醒您处置",
  "▸ <code>/tongji</code> 统计：查看今日与累计联系人数、消息数",
  "",
  ...LEVEL_OVERVIEW,
  "",
  "🚀 <b>如何开始</b>",
  "只需将您的 Bot Token 发送给我即可。",
  "<i>还没有 Token？请先找 @BotFather 申请一个</i>",
].join("\n");

const HELP = [
  "🛠 <b>使用说明</b>",
  SEP,
  "▸ 直接把 Bot Token 发给我，就能部署一个私聊转发机器人",
  "▸ <code>/list</code> 查看我注册的 bot",
  "▸ <code>/list</code> 里每个 bot 有「🤖 AI 辅助设置」按钮：在管理端直接配 AI 辅助（接口 / Token / 模型）；验证方式在「⚙️ 设置」里切换",
  "▸ <code>/del</code> 注销我的 bot（带 bot 数字ID 或 @用户名）",
  "",
  "<b>转发机器人里</b>",
  "回复转发消息点按钮或发指令管理：",
  "<code>/bai</code> 加白 · <code>/hei</code> 拉黑 · <code>/jiehei</code> 解黑 · <code>/cd</code> 查状态 · <code>/tongji</code> 看统计",
  "",
  "<b>转发机器人自带功能</b>（在您自己的机器人里使用）",
  "▸ 输入框旁有命令菜单按钮，所有功能点菜单就能用",
  "▸ <code>/level</code> 验证等级三档：简易 / 中等 / 强力（强力档含 Cloudflare 真人验证）",
  "▸ <code>/ad</code> 广告过滤三档：宽松 / 标准 / 严格",
  "▸ <code>/tongji</code> 查看今日与累计统计",
  "▸ <code>/zongjie</code> AI 今日消息总结：在机器人 /ai 里开启「总结模式」后，汇总今天谁联系了您、都说了什么事",
  "▸ 每条转发消息上方有按钮，可一键屏蔽 / 加白对方",
  "",
  ...LEVEL_OVERVIEW,
  "",
  "<i>点下方按钮操作，或发 /help 查看全部功能</i>",
].join("\n");

const MAX_BOTS_PER_USER = 10;

function botNamespaceKV(botId) {
  return createKV(
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
    `b${botId}:`
  );
}

// 构建某 bot 的联系人管理视图：联系人来自该 bot 命名空间的 seen:<uid> 键（最多 10 个），
// 每人一行（名字/@/ID + 状态）并配操作按钮（拉黑/解封、加白/取消加白一行 + 清除验证一行）
async function buildContactsView(botId, reg) {
  const kv = botNamespaceKV(botId);
  const uids = [];
  let cursor;
  let complete = false;
  while (!complete && uids.length < 10) {
    const page = await kv.list({ prefix: "seen:", cursor });
    for (const k of page.keys) {
      const uid = k.name.replace("seen:", "");
      if (/^\d+$/.test(uid)) uids.push(uid); // 排除 seen:daily:<日期>:<uid>
      if (uids.length >= 10) break;
    }
    complete = page.list_complete;
    cursor = page.cursor;
  }
  const lines = [`📇 <b>@${escapeHtml(reg.username || "?")} 的联系人</b>（共 <b>${uids.length}</b> 人）`, SEP];
  const keyboard = [];
  for (const uid of uids) {
    const rec = await kv.get(`user:${uid}`, { type: "json" }).catch(() => null);
    const uinfo = await kv.get(`uinfo:${uid}`, { type: "json" }).catch(() => null);
    const verified = await kv.get(`verified:${uid}`);
    const banned = await kv.get(`banned:${uid}`);
    const name = rec?.title || "未知";
    const uname = uinfo?.username ? `@${uinfo.username}` : "无";
    const status = banned ? "🚫已封禁" : verified === "trusted" ? "⭐信任" : verified ? "✅已验证" : "未验证";
    const tag = userTag(rec, uinfo, uid);
    if (lines.length > 2) lines.push(SUBSEP);
    lines.push(`▸ <b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）`, `　 ID：<code>${uid}</code>｜状态：${status}`);
    keyboard.push([
      banned
        ? { text: `🔓解封 ${tag}`, callback_data: `mgr:unban:${botId}:${uid}` }
        : { text: `🚫拉黑 ${tag}`, callback_data: `mgr:ban:${botId}:${uid}` },
      verified === "trusted"
        ? { text: `取消加白 ${tag}`, callback_data: `mgr:untrust:${botId}:${uid}` }
        : { text: `⭐加白 ${tag}`, callback_data: `mgr:trust:${botId}:${uid}` },
    ]);
    // 清除验证单独一行，紧跟该用户自己的操作行，不与下一人的按钮串行
    keyboard.push([{ text: `🧹清除 ${tag}`, callback_data: `mgr:revoke:${botId}:${uid}` }]);
  }
  if (!uids.length) lines.push("▸ 还没有联系人");
  else lines.push("", "<i>点下方带名字的按钮，操作对应联系人</i>");
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

// 枚举某前缀下的用户 ID（逻辑键形如 <prefix><uid>），valueEquals 给定时只取 value 相等的，最多 limit 个
async function listPrefixedUids(kv, prefix, limit = 10, valueEquals) {
  const uids = [];
  let cursor;
  let complete = false;
  while (!complete && uids.length < limit) {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const uid = k.name.slice(prefix.length);
      if (!/^\d+$/.test(uid)) continue; // 只认 <prefix><数字uid>，顺带排除 probation_count: 等杂键
      if (valueEquals !== undefined && (await kv.get(k.name)) !== valueEquals) continue;
      uids.push(uid);
      if (uids.length >= limit) break;
    }
    complete = page.list_complete;
    cursor = page.cursor;
  }
  return uids;
}

// 统计某前缀下的用户总数（同上过滤规则，不设上限）
async function countPrefixedUids(kv, prefix, valueEquals) {
  let n = 0;
  let cursor;
  let complete = false;
  while (!complete) {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const uid = k.name.slice(prefix.length);
      if (!/^\d+$/.test(uid)) continue;
      if (valueEquals !== undefined && (await kv.get(k.name)) !== valueEquals) continue;
      n++;
    }
    complete = page.list_complete;
    cursor = page.cursor;
  }
  return n;
}

// 按钮上的用户标识：优先 @username，没有用昵称（截断 8 字），再没有用 ID 后 4 位。
// 名单里多人时靠它区分每一行按钮属于谁，如「🚫拉黑 @WuY_X」「⭐加白 雾雨」
function userTag(rec, uinfo, uid) {
  if (uinfo?.username) return `@${uinfo.username}`;
  const nick = (rec?.title || "").trim();
  if (nick) return [...nick].slice(0, 8).join("");
  return `ID…${String(uid).slice(-4)}`;
}

// 用户展示信息：名字取 user:<uid>.title，@ 取 uinfo:<uid>.username（与联系人视图一致），tag 供按钮标识
async function describeUser(kv, uid) {
  const rec = await kv.get(`user:${uid}`, { type: "json" }).catch(() => null);
  const uinfo = await kv.get(`uinfo:${uid}`, { type: "json" }).catch(() => null);
  return { name: rec?.title || "未知", uname: uinfo?.username ? `@${uinfo.username}` : "无", tag: userTag(rec, uinfo, uid) };
}

// 名单/设置各视图之间的跳转行（当前视图不出现）
function listNavRow(botId, current) {
  const items = [
    ["contacts", "📇联系人", `mgr:contacts:${botId}`],
    ["whitelist", "⭐白名单", `mgr:wlist:${botId}`],
    ["blacklist", "🚫黑名单", `mgr:blist:${botId}`],
    ["probation", "👀观察期", `mgr:plist:${botId}`],
    ["settings", "⚙️设置", `mgr:settings:${botId}`],
    ["ai", "🤖AI", `mgr:ai:${botId}`],
  ];
  return items.filter(([k]) => k !== current).map(([, text, callback_data]) => ({ text, callback_data }));
}

// 白名单视图：verified: 里 value == "trusted" 的用户（最多 10），每人「取消加白」+「🧹 清除验证」
// 按钮用 mgrw: 前缀，操作后按来源刷新回本视图（见 handleManagerCallback 的 scope 机制）
async function buildWhitelistView(botId, reg) {
  const kv = botNamespaceKV(botId);
  const uids = await listPrefixedUids(kv, "verified:", 10, "trusted");
  const lines = [`⭐ <b>@${escapeHtml(reg.username || "?")} 的白名单</b>（共 <b>${uids.length}</b> 人）`, SEP];
  const keyboard = [];
  for (const uid of uids) {
    const { name, uname, tag } = await describeUser(kv, uid);
    if (lines.length > 2) lines.push(SUBSEP);
    lines.push(`▸ <b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）`, `　 ID：<code>${uid}</code>`);
    keyboard.push([
      { text: `取消加白 ${tag}`, callback_data: `mgrw:untrust:${botId}:${uid}` },
      { text: `🧹清除 ${tag}`, callback_data: `mgrw:revoke:${botId}:${uid}` },
    ]);
  }
  if (!uids.length) lines.push("▸ 白名单是空的");
  keyboard.push(listNavRow(botId, "whitelist"));
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

// 黑名单视图：banned: 下的用户（最多 10），每人一个「🔓 解封」（mgrb: 前缀，刷新回本视图）
async function buildBlacklistView(botId, reg) {
  const kv = botNamespaceKV(botId);
  const uids = await listPrefixedUids(kv, "banned:", 10);
  const lines = [`🚫 <b>@${escapeHtml(reg.username || "?")} 的黑名单</b>（共 <b>${uids.length}</b> 人）`, SEP];
  const keyboard = [];
  for (const uid of uids) {
    const { name, uname, tag } = await describeUser(kv, uid);
    if (lines.length > 2) lines.push(SUBSEP);
    lines.push(`▸ <b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）`, `　 ID：<code>${uid}</code>`);
    keyboard.push([{ text: `🔓解封 ${tag}`, callback_data: `mgrb:unban:${botId}:${uid}` }]);
  }
  if (!uids.length) lines.push("▸ 黑名单是空的");
  keyboard.push(listNavRow(botId, "blacklist"));
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

// 解析 risk:<uid> 的当前周期累计分（与 lib/bot.js 同格式）：JSON {s,t,r} 取 s，
// 30 天计分周期已满视为 0；旧纯数字值直接取数。
function mgrRiskScore(raw) {
  if (!raw) return 0;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && typeof obj.s === "number") {
      if (typeof obj.t === "number" && obj.t > 0 && Date.now() - obj.t >= 30 * 86400 * 1000) return 0;
      return obj.s;
    }
  } catch { /* 非 JSON：按旧纯数字格式走下面 */ }
  return parseInt(raw) || 0;
}

// 观察期视图：probation: 下的用户（probation_count: 不匹配 "probation:" 前缀，天然排除；
// 再用数字 uid 过滤兜底），解析 JSON {ts,hours,limit} 或旧版纯时间戳（按 24h/2 条），
// 显示剩余小时（向上取整）与已通过消息数。每人「🔓 解除观察期」+「🚫 拉黑」（mgrp: 前缀，刷新回本视图）
async function buildProbationView(botId, reg) {
  const kv = botNamespaceKV(botId);
  const uids = await listPrefixedUids(kv, "probation:", 10);
  const lines = [`👀 <b>@${escapeHtml(reg.username || "?")} 的观察期用户</b>（共 <b>${uids.length}</b> 人）`, SEP];
  const keyboard = [];
  for (const uid of uids) {
    const { name, uname, tag } = await describeUser(kv, uid);
    const raw = await kv.get(`probation:${uid}`);
    let ts = 0;
    let hours = 24;
    let limit = 2;
    let ban = 5; // 旧快照无 ban 字段时按中等 5 分兜底（与 bot.js getProbationMeta 一致）
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.ts === "number" && obj.ts > 0) {
        ts = obj.ts;
        hours = obj.hours || 24;
        limit = obj.limit || 2;
        if (typeof obj.ban === "number" && obj.ban > 0) ban = obj.ban;
      }
    } catch { /* 旧格式：纯时间戳，下面兼容 */ }
    if (!ts) ts = parseInt(raw) || 0;
    const remain = ts ? Math.max(0, Math.ceil((ts + hours * 3600 * 1000 - Date.now()) / 3600000)) : 0;
    const count = parseInt((await kv.get(`probation_count:${uid}`)) || "0") || 0;
    const risk = mgrRiskScore(await kv.get(`risk:${uid}`));
    if (lines.length > 2) lines.push(SUBSEP);
    lines.push(`▸ <b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）`, `　 ID：<code>${uid}</code>｜剩余约 <b>${remain}</b> 小时｜已通过 <b>${count}/${limit}</b> 条｜风险分 <b>${risk}/${ban}</b>`);
    keyboard.push([
      { text: `🔓解除观察期 ${tag}`, callback_data: `mgr:release:${botId}:${uid}` },
      { text: `🚫拉黑 ${tag}`, callback_data: `mgrp:ban:${botId}:${uid}` },
    ]);
  }
  if (!uids.length) lines.push("当前没有观察期用户（观察期在验证通过后产生）");
  keyboard.push(listNavRow(botId, "probation"));
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

// 构建某 bot 的设置视图：切换验证方式（cfg:vmode，二选一）、验证等级（cfg:level）与广告过滤档位（cfg:adlevel），
// 键名与 lib/bot.js 完全一致，管理端改完转发 bot 立即生效。验证方式只在这里（与转发 bot 的 /level）切换。
const VERIFY_LEVEL_LABEL = { light: "🟢简易", medium: "🟡中等", strong: "🔴强力" };
const AD_LEVEL_LABEL = { light: "🟢宽松", standard: "🟡标准", strict: "🔴严格" };
const VERIFY_LEVEL_RULE = { light: "1 轮答题，观察期 24h，累计 8 分拉黑", medium: "2 轮答题（高风险 3 轮）+蜜罐，观察期 24h，累计 5 分拉黑", strong: "3 轮答题+蜜罐（或网页真人验证），观察期 48h，累计 2 分拉黑" };
const AD_LEVEL_RULE = { light: "5 分才拦，只拦明显广告", standard: "3 分拦，链接+广告词即拦", strict: "2 分拦，单发链接即拦" };
async function buildSettingsView(botId, reg) {
  const kv = botNamespaceKV(botId);
  const vmode = (await kv.get("cfg:vmode")) || "quiz";
  const vl = (await kv.get("cfg:level")) || "medium";
  const al = (await kv.get("cfg:adlevel")) || "standard";
  const mark = (cur, key) => (cur === key ? "✅" : "");
  const text = [
    `⚙️ <b>@${escapeHtml(reg.username || "?")} 设置</b>`,
    SEP,
    `验证方式：<b>${VMODE_LABEL[vmode] || VMODE_LABEL.quiz}</b>（当前）`,
    "<i>🧩答题 图片题 · 🌐网页 真人验证</i>",
    "",
    `验证等级：<b>${VERIFY_LEVEL_LABEL[vl] || escapeHtml(vl)}</b>（当前）`,
    `<i>${VERIFY_LEVEL_RULE[vl] || ""}</i>`,
    "▸ 🟢简易 1 轮答题",
    "▸ 🟡中等 2 轮 + 隔离",
    "▸ 🔴强力 真人验证 / 3 轮 + 隔离",
    "",
    `广告过滤：<b>${AD_LEVEL_LABEL[al] || escapeHtml(al)}</b>（当前）`,
    `<i>${AD_LEVEL_RULE[al] || ""}</i>`,
    "▸ 🟢宽松 严广告才拦",
    "▸ 🟡标准 链接 + 广告词拦",
    "▸ 🔴严格 有链接就拦",
    "",
    "<i>点下方按钮即可切换，立即生效</i>",
  ].join("\n");
  const keyboard = [
    ["quiz", "web"].map((m) => ({
      text: `${mark(vmode, m)}${VMODE_LABEL[m]}`,
      callback_data: `mgr:vmode:${botId}:${m}`,
    })),
    ["light", "medium", "strong"].map((k) => ({
      text: `${mark(vl, k)}${VERIFY_LEVEL_LABEL[k]}`,
      callback_data: `mgr:vlvl:${botId}:${k}`,
    })),
    ["light", "standard", "strict"].map((k) => ({
      text: `${mark(al, k)}${AD_LEVEL_LABEL[k]}`,
      callback_data: `mgr:alvl:${botId}:${k}`,
    })),
    [{ text: "📇 联系人管理", callback_data: `mgr:contacts:${botId}` }],
  ];
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

// ---- 管理端 AI 设置：读写该 bot 命名空间里与 lib/bot.js 完全相同的一组键，两边互通 ----
// cfg:ai = { enabled, base, key, model, summary, ua }（enabled = 辅助观察开关、summary = 总结模式开关，两者独立；ua = 自定义客户端标识，空 = 不改默认）、
// cfg:ai_broken = { ts, status }
// 基础能力（配置读写 / 打码 / 失效标记 / 模型列表 / 连接测试 / chat 调用）已抽到 lib/ai.js 与转发 bot 共用，
// 顶部以原名别名 import（getMgrAiConfig / saveMgrAiConfig / maskMgrAiKey / getMgrAiBroken / fmtMgrBrokenTime /
// mgrFetchAiModels / MGR_AI_DEFAULT_MODEL），本文件调用点不变。
const VMODE_LABEL = { quiz: "🧩答题验证", web: "🌐网页验证" };

// 通用 chat/completions 调用（总结生成用）：共享 callAiChat 之上的薄适配，返回口径与原实现一致
// （成功提取 choices[0] 的文本内容回 { ok, status, content }；无内容回「接口返回无内容」）
async function mgrAiChatCompletion(cfg, messages, maxTokens = 1500, temperature = 0.3) {
  const r = await callAiChat(cfg, messages, maxTokens, { temperature });
  if (!r.ok) {
    // 共享 callAiChat 对「HTTP 200 但返回体不可解析」回「返回格式异常」，管理端原文案是「接口返回无内容」
    if (r.error === "返回格式异常") return { ok: false, status: r.status, error: "接口返回无内容" };
    return r;
  }
  const content = r.data?.choices?.[0]?.message?.content?.trim();
  if (!content) return { ok: false, status: r.status, error: "接口返回无内容" };
  return { ok: true, status: r.status, content };
}

// ---- 管理端今日总结：材料读目标 bot 命名空间的 sum:<日期>:*（由转发 bot 在总结模式下暂存），----
// 聚合/截断/提示词口径与 lib/bot.js 的 collectTodaySummaryMaterial / generateTodaySummary 一致；
// 管理端没有该 bot 的机主私聊上下文，生成结果发回管理 bot 当前聊天。
// MGR_AI_SUMMARY_SYSTEM_PROMPT / MGR_AI_SUMMARY_MATERIAL_MAX 为 lib/ai.js 共享常量的别名（顶部 import）

function mgrShanghaiDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

async function collectMgrSummaryMaterial(kv) {
  const day = mgrShanghaiDay();
  const prefix = `sum:${day}:`;
  const uids = [];
  let cursor;
  let complete = false;
  while (!complete) {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const uid = k.name.slice(prefix.length);
      if (/^\d+$/.test(uid)) uids.push(uid);
    }
    complete = page.list_complete;
    cursor = page.cursor;
  }
  const perUser = [];
  for (const uid of uids) {
    const list = await kv.get(`${prefix}${uid}`, { type: "json" }).catch(() => null);
    if (!Array.isArray(list) || !list.length) continue;
    const { name, uname } = await describeUser(kv, uid);
    perUser.push({ uid, name, uname, items: list });
  }
  const { userCount, msgCount, material } = assembleSummaryMaterial(perUser);
  return { day, userCount, msgCount, material };
}

// 生成今日总结并发回管理 bot 当前聊天：未配置/无记录直接提示；401/403 置失效标记并关两个开关；超时/5xx 只提示重试
async function generateMgrTodaySummary(mToken, chatId, botId, reg) {
  const send = (text) => tg(mToken, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  const kv = botNamespaceKV(botId);
  const cfg = await getMgrAiConfig(kv);
  if (!cfg.base || !cfg.key) {
    await send(`⚠️ @${escapeHtml(reg.username || botId)} 的 AI 接口或 Token 还没配置，请先在本页设置接口与 Token 后再生成总结。`);
    return;
  }
  const { day, userCount, msgCount, material } = await collectMgrSummaryMaterial(kv);
  if (!userCount) {
    await send("今天还没有已记录的消息（总结模式开启后转发的消息才会被记录）。");
    return;
  }
  await send(`📝 正在生成 @${escapeHtml(reg.username || botId)} 的今日总结（共 ${userCount} 人、${msgCount} 条记录），请稍候…`);
  const r = await mgrAiChatCompletion(cfg, [
    { role: "system", content: MGR_AI_SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: `以下是今天（${day}）收到的访客消息记录，请按要求汇总：\n\n${material}` },
  ], 1500, 0.3);
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      await markAiAuthFailure(kv, r.status);
      await send(`❌ AI 已失效（接口返回 ${r.status}），辅助观察与总结模式暂停，请更新 Token 后重新开启。`);
      return;
    }
    if (r.error === "请求超时" || (typeof r.status === "number" && r.status >= 500)) {
      await send("❌ AI 响应超时，稍后再试。");
      return;
    }
    await send(`❌ 生成总结失败：${escapeHtml(r.error || "未知错误")}`);
    return;
  }
  await kv.delete("cfg:ai_broken");
  const chunks = mgrChunkText(r.content, 3000);
  for (let i = 0; i < chunks.length; i++) {
    const head = i === 0 ? `📋 <b>今日消息总结</b>（@${escapeHtml(reg.username || botId)} · ${day}）\n${SEP}\n` : "";
    await send(head + escapeHtml(chunks[i]));
  }
}
// AI 辅助与验证方式无关：新用户通过验证后异步分析一次，疑似广告时提醒机主处置。
async function buildAiView(botId, reg) {
  const kv = botNamespaceKV(botId);
  const cfg = await getMgrAiConfig(kv);
  const broken = await getMgrAiBroken(kv);
  const modelShown = cfg.model || `${MGR_AI_DEFAULT_MODEL}（默认）`;
  const lines = [
    `🤖 <b>@${escapeHtml(reg.username || "?")} 的 AI 辅助设置</b>`,
    SEP,
    `辅助观察：<b>${cfg.enabled ? "🟢 已开启" : "⚪ 未开启"}</b>`,
    `总结模式：<b>${cfg.summary ? "🟢 已开启" : "⚪ 未开启"}</b>`,
  ];
  if (broken) lines.push(`🔴 Token 疑似失效（最近失败 ${fmtMgrBrokenTime(broken.ts)}）`);
  lines.push(
    `接口：${cfg.base ? `<code>${escapeHtml(cfg.base)}</code>` : "未设置"}`,
    `模型：<code>${escapeHtml(modelShown)}</code>`,
    `Token：${cfg.key ? `<code>${escapeHtml(maskMgrAiKey(cfg.key))}</code>` : "未设置"}`,
    ...(cfg.ua ? [`自定义 UA：<code>${escapeHtml(cfg.ua)}</code>`] : []),
    "",
    "<i>辅助观察：新用户通过验证时 AI 结合其头像、昵称、简介与首条发言识别广告号，疑似时弹窗提醒机主是否拉黑；只提醒、不拦截。</i>",
    "<i>总结模式：把当天收到的消息按人记录下来，点「📋 生成今日总结」让 AI 汇总今天谁联系了机主、都说了什么事。</i>",
    "<i>自定义 UA：有些中转站的 Key 只认特定客户端（如 claude-cli），设了之后每次 AI 请求都会带上这个标识；不设则按默认发送。</i>",
    "<i>隐私：总结模式开启后会暂存访客消息文本 48 小时用于生成总结，关闭即不再记录。开关点按钮即时生效；设置接口 / Token / 模型后，按提示直接发送新值即可</i>"
  );
  const keyboard = [
    [{ text: cfg.enabled ? "⏯ 辅助观察（当前：开）" : "⏯ 辅助观察（当前：关）", callback_data: `mgr:aitoggle:${botId}` }],
    [{ text: cfg.summary ? "📝 总结模式（当前：开）" : "📝 总结模式（当前：关）", callback_data: `mgr:aisumtoggle:${botId}` }],
    [{ text: "📋 生成今日总结", callback_data: `mgr:aisumgen:${botId}` }],
    [
      { text: "🌐 设置接口", callback_data: `mgr:aiset:${botId}:base` },
      { text: "🔑 设置Token", callback_data: `mgr:aiset:${botId}:key` },
    ],
    [
      { text: "🤖 手填模型", callback_data: `mgr:aiset:${botId}:model` },
      { text: "📋 选择模型", callback_data: `mgr:aimodels:${botId}` },
    ],
    [{ text: "🆔 设置自定义 UA", callback_data: `mgr:aiset:${botId}:ua` }],
    [{ text: "🧪 测试连接", callback_data: `mgr:aitest:${botId}` }],
    listNavRow(botId, "ai"),
  ];
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

// 清除某用户的全部验证状态：与 lib/bot.js 的 clearUserVerification（/reset 与 own:revoke 共用）
// 清同一组键——已验证标记、观察期及计数、待验证标记、进行中的挑战与 Turnstile 会话、失败计数与冷却，
// 对方下次给该 bot 发消息必须从头重新走验证（机主反复测试验证流程用）
async function clearUserVerificationKeys(kv, uid) {
  await kv.delete(`verified:${uid}`);
  await kv.delete(`probation:${uid}`);
  await kv.delete(`probation_count:${uid}`);
  await kv.delete(`risk:${uid}`);
  await kv.delete(`needs_verify:${uid}`);
  await kv.delete(`challenge:${uid}`);
  await kv.delete(`user_challenge:${uid}`);
  await kv.delete(`verify_fails:${uid}`);
  await kv.delete(`verify_cooldown:${uid}`);
  const sess = await kv.get(`tsess_by_user:${uid}`);
  if (sess) await kv.delete(`tsess:${sess}`);
  await kv.delete(`tsess_by_user:${uid}`);
}

// 管理 bot 的按钮回调：联系人/名单/设置管理，仅 bot 主人或平台管理员可操作。
// 封禁/信任直接写该 bot 命名空间里与 lib/bot.js 相同的一组键（banned:<uid>、verified:<uid>），两边互通。
//
// 刷新来源视图的实现：回调前缀带 scope —— mgr:（联系人视图）、mgrw:（白名单视图）、
// mgrb:（黑名单视图）、mgrp:（观察期视图）。ban/unban/trust/untrust/revoke 执行后按 scope
// 刷新回来源视图；release 只出现在观察期视图，固定刷新观察期视图；打开视图的动作
// （contacts/settings/wlist/blist/plist）与档位切换（vlvl/alvl）各自刷新目标视图。
const MGR_VIEWS = {
  contacts: buildContactsView,
  settings: buildSettingsView,
  whitelist: buildWhitelistView,
  blacklist: buildBlacklistView,
  probation: buildProbationView,
  ai: buildAiView,
};
const MGR_SCOPE_VIEW = { mgr: "contacts", mgrw: "whitelist", mgrb: "blacklist", mgrp: "probation" };

async function handleManagerCallback(query, mToken, registry) {
  const answer = (text, showAlert = false) =>
    tg(mToken, "answerCallbackQuery", {
      callback_query_id: query.id,
      ...(text ? { text } : {}),
      ...(showAlert ? { show_alert: true } : {}),
    });
  const data = query.data || "";
  const scopeMatch = data.match(/^(mgrw|mgrb|mgrp|mgr):/);
  if (!scopeMatch) return;
  const scope = scopeMatch[1];
  const parts = data.slice(scope.length + 1).split(":");
  const action = parts[0];
  const botId = parts[1];
  const uid = parts[2];
  if (!botId) {
    await answer("❌ 无效操作", true);
    return;
  }
  const reg = await registry.get(`multi:bot:${botId}`, { type: "json" });
  if (!reg) {
    await answer("❌ bot 不存在", true);
    return;
  }
  const admins = (process.env.PLATFORM_ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const clicker = String(query.from.id);
  if (String(reg.owner) !== clicker && !admins.includes(clicker)) {
    await answer("⛔ 只能管理自己托管的 bot", true);
    return;
  }
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const refreshView = async (view) => {
    if (!chatId || !messageId || !MGR_VIEWS[view]) return;
    const v = await MGR_VIEWS[view](botId, reg);
    await tg(mToken, "editMessageText", { chat_id: chatId, message_id: messageId, text: v.text, parse_mode: "HTML", reply_markup: v.reply_markup });
  };

  // 打开视图类动作
  const OPEN_VIEWS = { contacts: "contacts", settings: "settings", wlist: "whitelist", blist: "blacklist", plist: "probation", ai: "ai" };
  if (OPEN_VIEWS[action]) {
    await refreshView(OPEN_VIEWS[action]);
    await answer();
    return;
  }

  if (action === "vlvl" || action === "alvl") {
    const level = parts[2];
    const kv2 = botNamespaceKV(botId);
    if (action === "vlvl" && VERIFY_LEVEL_LABEL[level]) {
      await kv2.put("cfg:level", level);
      await answer(`验证等级已切换为 ${VERIFY_LEVEL_LABEL[level]}`);
    } else if (action === "alvl" && AD_LEVEL_LABEL[level]) {
      await kv2.put("cfg:adlevel", level);
      await answer(`广告过滤已切换为 ${AD_LEVEL_LABEL[level]}`);
    } else {
      await answer("❌ 无效档位", true);
      return;
    }
    await refreshView("settings");
    return;
  }

  // ---- AI 辅助设置类动作（读写 bot.js 同一组键：cfg:ai / cfg:ai_broken，两边互通）----
  if (action === "aitoggle") {
    const kvA = botNamespaceKV(botId);
    const cfg = await getMgrAiConfig(kvA);
    cfg.enabled = !cfg.enabled;
    await saveMgrAiConfig(kvA, cfg);
    await answer(cfg.enabled ? "🟢 AI 辅助已开启" : "⚪ AI 辅助已关闭");
    await refreshView("ai");
    return;
  }

  if (action === "aisumtoggle") {
    const kvA = botNamespaceKV(botId);
    const cfg = await getMgrAiConfig(kvA);
    cfg.summary = !cfg.summary;
    await saveMgrAiConfig(kvA, cfg);
    await answer(cfg.summary ? "📝 总结模式已开启（将暂存转发消息 48 小时）" : "⚪ 总结模式已关闭（不再记录）");
    await refreshView("ai");
    return;
  }

  if (action === "aisumgen") {
    await answer("📝 正在生成今日总结…");
    if (chatId) await generateMgrTodaySummary(mToken, chatId, botId, reg);
    await refreshView("ai");
    return;
  }

  if (action === "vmode") {
    const mode = parts[2];
    if (!VMODE_LABEL[mode]) {
      await answer("❌ 无效方式", true);
      return;
    }
    const kvA = botNamespaceKV(botId);
    await kvA.put("cfg:vmode", mode);
    await answer(`验证方式已切换为 ${VMODE_LABEL[mode]}`);
    await refreshView("settings");
    return;
  }

  if (action === "aiset") {
    const field = parts[2];
    const PROMPTS = {
      base: `🌐 请直接发送 @${reg.username || botId} 的接口地址（OpenAI 兼容基地址，如 https://api.openai.com/v1）。\n下一条消息即保存，发 /cancel 取消。`,
      key: `🔑 请直接发送 @${reg.username || botId} 的 API Token。\n保存后会自动删除您这条消息，发 /cancel 取消。`,
      model: `🤖 请直接发送 @${reg.username || botId} 的模型名（如 gpt-4o-mini）。\n下一条消息即保存，发 /cancel 取消。`,
      ua: `🆔 请直接发送 @${reg.username || botId} 的自定义 User-Agent（客户端标识），如 claude-cli/2.0.14 (external, cli)。\n之后每次 AI 请求都会带上这个标识；发送「清空」可清除。下一条消息即保存，发 /cancel 取消。`,
    };
    if (!PROMPTS[field]) {
      await answer("❌ 无效操作", true);
      return;
    }
    // 输入等待态存全局 KV（按点击者隔离，5 分钟过期）；值由 handler 的消息路由消费
    await registry.put(`multi:aiinput:${clicker}`, JSON.stringify({ botId, field }), { expirationTtl: 300 });
    await answer("请按下方提示发送新值");
    if (chatId) await tg(mToken, "sendMessage", { chat_id: chatId, text: PROMPTS[field] });
    return;
  }

  if (action === "aimodels") {
    const kvA = botNamespaceKV(botId);
    const cfg = await getMgrAiConfig(kvA);
    const r = await mgrFetchAiModels(cfg);
    if (!r.ok) {
      await answer(`❌ 自动获取模型失败：${r.error}，可点「🤖 手填模型」`, true);
      return;
    }
    const shown = r.ids.slice(0, 12);
    await registry.put(`multi:aimodels:${clicker}`, JSON.stringify({ botId, models: shown }), { expirationTtl: 600 });
    await answer();
    if (chatId && messageId) {
      const rows = [];
      for (let i = 0; i < shown.length; i += 2) {
        const row = [{ text: shown[i].slice(0, 34), callback_data: `mgr:aimodel:${botId}:${i}` }];
        if (shown[i + 1]) row.push({ text: shown[i + 1].slice(0, 34), callback_data: `mgr:aimodel:${botId}:${i + 1}` });
        rows.push(row);
      }
      rows.push([{ text: "↩️ 返回 AI 设置", callback_data: `mgr:ai:${botId}` }]);
      let text = `📋 <b>选择模型</b>（@${escapeHtml(reg.username || "?")}）\n${SEP}\n共获取到 <b>${r.ids.length}</b> 个模型，点下方按钮即可设为当前模型：`;
      if (r.ids.length > shown.length) text += `\n\n<i>仅列出前 ${shown.length} 个，其余模型可点「🤖 手填模型」</i>`;
      await tg(mToken, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      });
    }
    return;
  }

  if (action === "aimodel") {
    const idx = parseInt(parts[2]);
    const saved = await registry.get(`multi:aimodels:${clicker}`, { type: "json" }).catch(() => null);
    const model = saved && String(saved.botId) === String(botId) && Array.isArray(saved.models) ? saved.models[idx] : null;
    if (!model) {
      await answer("❌ 模型列表已过期，请重新点「📋 选择模型」", true);
      return;
    }
    const kvA = botNamespaceKV(botId);
    const cfg = await getMgrAiConfig(kvA);
    cfg.model = model;
    await saveMgrAiConfig(kvA, cfg);
    await answer(`✅ 模型已设为 ${model}`);
    await refreshView("ai");
    return;
  }

  if (action === "aitest") {
    const kvA = botNamespaceKV(botId);
    const cfg = await getMgrAiConfig(kvA);
    if (!cfg.base || !cfg.key) {
      await answer("⚠️ 接口或 Token 未设置", true);
      return;
    }
    const hadBroken = await getMgrAiBroken(kvA);
    const r = await testAiConnection(kvA, cfg, { noDataError: "接口返回无 choices" });
    if (r.ok) {
      await answer(hadBroken ? "✅ 测试成功，Token 已恢复（需要时可在本页重新开启 AI 辅助）" : "✅ 测试连接成功");
    } else if (r.authFailed) {
      // 与 bot.js 失效处置同口径：共享 testAiConnection 已置失效标记并自动关闭两个开关（辅助观察 + 总结模式）
      await answer(`❌ 测试失败：${r.error}，AI 已失效，辅助观察与总结模式暂停`, true);
    } else {
      await answer(`❌ 测试失败：${r.error}`, true);
    }
    await refreshView("ai");
    return;
  }

  if (!uid) {
    await answer("❌ 无效操作", true);
    return;
  }
  const kv = botNamespaceKV(botId);
  let note = "";
  let backView = MGR_SCOPE_VIEW[scope];
  if (action === "ban") {
    await kv.put(`banned:${uid}`, "1");
    // 从观察期视图拉黑时一并清掉观察期（与 bot.js iso:ban 语义一致，人也随之离开观察期列表）
    if (scope === "mgrp") {
      await kv.delete(`probation:${uid}`);
      await kv.delete(`probation_count:${uid}`);
    }
    note = "🚫 已拉黑";
  } else if (action === "unban") {
    await kv.delete(`banned:${uid}`);
    await kv.delete(`bannotice:${uid}`);
    await kv.delete(`risk:${uid}`);
    note = "🔓 已解封";
  } else if (action === "trust") {
    await kv.put(`verified:${uid}`, "trusted");
    await kv.delete(`needs_verify:${uid}`);
    await kv.delete(`probation:${uid}`);
    await kv.delete(`probation_count:${uid}`);
    await kv.delete(`risk:${uid}`);
    note = "⭐ 已加白";
  } else if (action === "untrust") {
    // 取消加白：由永久信任降为普通已验证（仍用 verified:<uid> 同一键）
    if ((await kv.get(`verified:${uid}`)) === "trusted") await kv.put(`verified:${uid}`, "1");
    note = "已取消加白";
  } else if (action === "revoke") {
    // 清除验证：清掉整组验证状态键（与 bot.js /reset 一致），按 scope 刷新回来源视图
    await clearUserVerificationKeys(kv, uid);
    note = "🧹 已清除验证，对方下次发消息需重新验证";
  } else if (action === "release") {
    // 解除观察期：删 probation 快照与计数（与 bot.js iso:release 语义一致）
    await kv.delete(`probation:${uid}`);
    await kv.delete(`probation_count:${uid}`);
    note = "🔓 已解除观察期";
    backView = "probation"; // release 只出现在观察期视图，固定刷新回该视图
  } else {
    await answer("❌ 未知操作", true);
    return;
  }
  await answer(note);
  await refreshView(backView);
}

export default async function handler(request) {
  if (request.method !== "POST") return new Response("OK manager", { status: 200 });
  const mToken = process.env.MANAGER_BOT_TOKEN;
  if (!mToken) return new Response("MANAGER_BOT_TOKEN not set", { status: 500 });

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  // 按钮回调（联系人管理 mgr:...）：在 message 检查之前路由
  if (update.callback_query) {
    const registry0 = redis();
    if (registry0) {
      try {
        await handleManagerCallback(update.callback_query, mToken, registry0);
      } catch {}
    }
    return new Response("OK");
  }

  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== "private") return new Response("OK");

  const chatId = msg.chat.id;
  const reply = (text) => tg(mToken, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });

  const registry = redis();
  if (!registry) {
    await reply("❌ 存储未连接（Redis）。");
    return new Response("OK");
  }

  // One-time command-menu setup for the manager bot itself.
  // Non-blocking: the lazy setup runs in the background via waitUntil so a
  // hung Telegram call here can never stall message handling.
  const mgrMenuSetup = (async () => {
    try {
      if ((await registry.get("multi:mgrmenu")) !== String(MENU_VERSION)) {
        const admins = (process.env.PLATFORM_ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (await setManagerMenus(mToken, admins)) await registry.put("multi:mgrmenu", String(MENU_VERSION));
      }
    } catch {}
  })();
  try {
    waitUntil(mgrMenuSetup);
  } catch {
    // Outside a Vercel request context (e.g. local tests) waitUntil is
    // unavailable; the setup promise still runs detached and self-handles
    // its errors, so there is nothing else to do here.
  }

  const text = (msg.text || "").trim();
  const origin = new URL(request.url).origin;

  const platformAdmins = (process.env.PLATFORM_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // AI 设置输入等待态：在 AI 视图点「设置接口/Token/模型」后置 multi:aiinput:<userId>（5 分钟）。
  // 下一条普通消息即该项新值并写入目标 bot 的 cfg:ai；发任意 / 命令（含 /cancel）则取消等待、按原逻辑处理。
  let aiInput = null;
  try {
    aiInput = await registry.get(`multi:aiinput:${chatId}`, { type: "json" });
  } catch {}
  if (aiInput && aiInput.botId && aiInput.field) {
    if (text.startsWith("/")) {
      await registry.delete(`multi:aiinput:${chatId}`);
    } else if (text) {
      const targetReg = await registry.get(`multi:bot:${aiInput.botId}`, { type: "json" });
      if (targetReg && (String(targetReg.owner) === String(chatId) || platformAdmins.includes(String(chatId)))) {
        const kvA = botNamespaceKV(aiInput.botId);
        const cfg = await getMgrAiConfig(kvA);
        if (aiInput.field === "base") cfg.base = text.replace(/\/+$/, ""); // 与 bot.js 同口径：去尾部斜杠
        else if (aiInput.field === "key") cfg.key = text;
        else if (aiInput.field === "model") cfg.model = text;
        else if (aiInput.field === "ua") cfg.ua = ["清空", "清除", "clear", "-"].includes(text.toLowerCase()) ? "" : text.slice(0, 200);
        await saveMgrAiConfig(kvA, cfg);
        await registry.delete(`multi:aiinput:${chatId}`);
        if (aiInput.field === "key") {
          // 删除机主这条含 Token 的消息，降低泄露面（失败不影响保存结果）
          try {
            await tg(mToken, "deleteMessage", { chat_id: chatId, message_id: msg.message_id });
          } catch {}
        }
        await reply("✅ 已保存");
        const view = await buildAiView(aiInput.botId, targetReg);
        await tg(mToken, "sendMessage", { chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
        return new Response("OK");
      }
      // 目标 bot 已不归本人（或已注销）：清掉等待态防串写，继续原逻辑
      await registry.delete(`multi:aiinput:${chatId}`);
    }
  }

  if (text === "/start") {
    await reply(WELCOME);
    return new Response("OK");
  }
  if (text === "/help") {
    await reply(HELP);
    return new Response("OK");
  }

  // 自检修复（仅平台管理员）：查管理 bot 的 webhook 状态 → 重新绑定 → 重推菜单并发报告。
  // 覆盖 webhook 失效型「没反应」；若 Telegram 按 bot ID 挂起本 bot，各调用会超时失败、
  // 报告如实写明——那不是本地卡死，指令清不掉，只能换新 bot。
  if (text === "/fix") {
    if (!platformAdmins.includes(String(chatId))) {
      await reply("❌ /fix 仅平台管理员可用。");
      return new Response("OK");
    }
    const lines = ["🛠 <b>管理 bot 自检修复</b>", SEP];
    const info = await tg(mToken, "getWebhookInfo", {});
    if (info && info.ok && info.result) {
      const r = info.result;
      lines.push(`当前 webhook：<code>${escapeHtml(r.url || "(未设置)")}</code>`);
      lines.push(`待处理消息：<b>${r.pending_update_count || 0}</b> 条`);
      if (r.last_error_message) lines.push(`最近错误：${escapeHtml(String(r.last_error_message))}`);
    } else {
      lines.push("⚠️ 查不到 webhook 状态（Telegram 未正常响应，可能被挂起）");
    }
    const wh = await tg(mToken, "setWebhook", {
      url: `${origin}/api/manager`,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    lines.push(wh && wh.ok ? "✅ webhook 已重新绑定" : "❌ webhook 重新绑定失败（Telegram 可能已挂起本 bot，只能换新 bot）");
    const menuOk = await setManagerMenus(mToken, platformAdmins);
    if (menuOk) {
      try { await registry.put("multi:mgrmenu", String(MENU_VERSION)); } catch {}
    }
    lines.push(menuOk ? "✅ 命令菜单已重推" : "⚠️ 命令菜单重推失败");
    await reply(lines.join("\n"));
    return new Response("OK");
  }

  // 注册流程：/add <Token>，或直接发送 Token 本身
  let tokenToRegister = null;
  if (text.startsWith("/add")) {
    tokenToRegister = extractToken(text) || normalizeToken(text.split(/\s+/)[1]);
  } else {
    tokenToRegister = extractToken(text);
  }

  if (tokenToRegister) {
    const token = tokenToRegister;
    const owner = String(chatId);
    await reply("⏳ 正在验证 Token 并部署环境，请稍候…");
    const me = await tg(token, "getMe", {});
    if (!me.ok) {
      await reply("❌ 部署失败：Token 无效，请在 @BotFather 里核对后重新发送。");
      return new Response("OK");
    }
    const botId = String(me.result.id);
    const existing = await registry.get(`multi:bot:${botId}`, { type: "json" });
    if (existing && String(existing.owner) !== String(chatId)) {
      await reply("❌ 部署失败：这个 bot 已经被其他人注册了。");
      return new Response("OK");
    }
    if (!existing) {
      let mine = 0;
      let c2;
      let done2 = false;
      while (!done2) {
        const page = await registry.list({ prefix: "multi:bot:", cursor: c2 });
        for (const k of page.keys) {
          const r = await registry.get(k.name, { type: "json" });
          if (r && String(r.owner) === String(chatId)) mine++;
        }
        done2 = page.list_complete;
        c2 = page.cursor;
      }
      if (mine >= MAX_BOTS_PER_USER) {
        await reply(`❌ 每个账号最多注册 ${MAX_BOTS_PER_USER} 个 bot，先用 /del 注销不用的吧。`);
        return new Response("OK");
      }
    }
    const secret = randomSecret();
    await registry.put(
      `multi:bot:${botId}`,
      JSON.stringify({ token, owner, secret, username: me.result.username || "" })
    );
    const webhookUrl = `${origin}/api/webhook?b=${botId}`;
    const wh = await tg(token, "setWebhook", {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    if (wh.ok) {
      const menuOk = await setBotMenus(token, owner);
      await registry.put(
        `multi:bot:${botId}`,
        JSON.stringify({ token, owner, secret, username: me.result.username || "", menuSet: menuOk ? MENU_VERSION : false })
      );
      await reply(
        [
          "✅ <b>部署成功！</b>",
          SEP,
          `您的私聊机器人已就绪：<b>@${escapeHtml(me.result.username || "")}</b>`,
          "",
          "👉 <b>下一步</b>",
          "▸ 把这个机器人的用户名分享出去（主页、名片、群公告都可以）",
          "▸ 别人私聊它时会先过人机验证，通过后消息转发到您这里",
          "▸ 您回复引用那条消息，就能直接回信，对方看不到您的账号",
          "",
          "<i>随时发 /list 查看您托管的机器人和数据</i>",
        ].join("\n")
      );
    } else {
      await reply(`⚠️ 已登记，但设置 Webhook 失败：${escapeHtml(wh.description || "未知错误")}`);
    }
    return new Response("OK");
  }

  // 平台管理员视图：仅 PLATFORM_ADMIN_IDS 里的账号可用（platformAdmins 已在上方计算）
  if (text === "/admin" || text.startsWith("/admin ")) {
    if (!platformAdmins.includes(String(chatId))) {
      await reply("⛔ 这是平台管理员功能。");
      return new Response("OK");
    }
    const rUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const rToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    const targetBot = (text.split(/\s+/)[1] || "").replace(/^@/, "");
    const all = [];
    let cursor;
    let complete = false;
    while (!complete) {
      const page = await registry.list({ prefix: "multi:bot:", cursor });
      for (const k of page.keys) {
        const reg = await registry.get(k.name, { type: "json" });
        if (reg) all.push({ id: k.name.replace("multi:bot:", ""), ...reg });
      }
      complete = page.list_complete;
      cursor = page.cursor;
    }
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    if (!targetBot) {
      let tUsers = 0;
      let tMsgs = 0;
      let dUsers = 0;
      let dMsgs = 0;
      const lines = [];
      for (const b of all) {
        const kv = createKV(rUrl, rToken, `b${b.id}:`);
        const users = parseInt((await kv.get("stat:users")) || "0") || 0;
        const msgs = parseInt((await kv.get("stat:msgs")) || "0") || 0;
        const du = parseInt((await kv.get(`stat:daily:${day}:users`)) || "0") || 0;
        const dm = parseInt((await kv.get(`stat:daily:${day}:msgs`)) || "0") || 0;
        tUsers += users;
        tMsgs += msgs;
        dUsers += du;
        dMsgs += dm;
        if (lines.length) lines.push(SUBSEP);
        lines.push(
          `🤖 <b>@${escapeHtml(b.username || "?")}</b>`,
          `　 机主：<code>${escapeHtml(b.owner)}</code>`,
          `　 累计：联系人 <b>${users}</b>｜消息 <b>${msgs}</b>`,
          `　 今日：联系人 <b>${du}</b>｜消息 <b>${dm}</b>`
        );
      }
      const head = [
        `📊 <b>平台数据</b>（共 <b>${all.length}</b> 个 bot）`,
        SEP,
        `今日（<code>${day}</code>）：联系人 <b>${dUsers}</b>｜转发消息 <b>${dMsgs}</b>`,
        `累计：联系人 <b>${tUsers}</b>｜转发消息 <b>${tMsgs}</b>`,
        "",
      ];
      await reply([...head, ...lines, "", "<i>看某个 bot 的明细：/admin &lt;bot数字ID&gt;</i>"].join("\n"));
      return new Response("OK");
    }
    const bot = all.find((b) => b.id === targetBot || b.username === targetBot);
    if (!bot) {
      await reply("没找到这个 bot。");
      return new Response("OK");
    }
    const kv = createKV(rUrl, rToken, `b${bot.id}:`);
    const lines = [`📋 <b>@${escapeHtml(bot.username || "?")}</b>`, SEP, `机主：<code>${escapeHtml(bot.owner)}</code>`, ""];
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
    const week = [`📈 <b>近 7 日转发</b>`];
    for (let i = 0; i < 7; i++) {
      const d = fmt.format(new Date(Date.now() - i * 86400000));
      const dm = (await kv.get(`stat:daily:${d}:msgs`)) || "0";
      const du = (await kv.get(`stat:daily:${d}:users`)) || "0";
      week.push(`▸ <code>${d}</code>：消息 <b>${dm}</b>｜联系人 <b>${du}</b>`);
    }
    lines.push(...week, "", "👥 <b>联系人明细</b>");
    let shown = 0;
    let c3;
    let done3 = false;
    while (!done3 && shown < 30) {
      const page = await kv.list({ prefix: "user:", cursor: c3 });
      for (const k of page.keys) {
        if (shown >= 30) break;
        const uid = k.name.replace("user:", "");
        const rec = await kv.get(k.name, { type: "json" }).catch(() => null);
        const v = await kv.get(`verified:${uid}`);
        const banned = await kv.get(`banned:${uid}`);
        const status = banned ? "🚫已封禁" : v === "trusted" ? "⭐永久信任" : v ? "✅已验证" : "未验证";
        lines.push(`▸ <b>${escapeHtml(rec?.title || uid)}</b>（<code>${uid}</code>）｜${status}`);
        shown++;
      }
      done3 = page.list_complete;
      c3 = page.cursor;
    }
    if (!shown) lines.push("▸ 还没有联系人");
    await reply(lines.join("\n"));
    return new Response("OK");
  }

  if (text === "/list") {
    const mine = [];
    let cursor;
    let complete = false;
    while (!complete) {
      const page = await registry.list({ prefix: "multi:bot:", cursor });
      for (const k of page.keys) {
        const reg = await registry.get(k.name, { type: "json" });
        if (reg && String(reg.owner) === String(chatId)) {
          mine.push({ id: k.name.replace("multi:bot:", ""), ...reg });
        }
      }
      complete = page.list_complete;
      cursor = page.cursor;
    }
    if (!mine.length) {
      await reply("你还没有注册 bot。直接把 Bot Token 发给我就能部署。");
      return new Response("OK");
    }
    // 数据面板：逐个读每个 bot 自己命名空间的统计与设置
    const rUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const rToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    const LV = { light: "🟢简易", medium: "🟡中等", strong: "🔴强力" };
    const AD = { light: "🟢宽松", standard: "🟡标准", strict: "🔴严格" };
    const lines = [`📋 <b>我的机器人</b>（共 <b>${mine.length}</b> 个）`, SEP, `📅 今日：<code>${day}</code>`, ""];
    for (const b of mine) {
      const kv = createKV(rUrl, rToken, `b${b.id}:`);
      const num = async (key) => parseInt((await kv.get(key)) || "0") || 0;
      const users = await num("stat:users");
      const msgs = await num("stat:msgs");
      const adBlocked = await num("stat:adblocked");
      const dUsers = await num(`stat:daily:${day}:users`);
      const dMsgs = await num(`stat:daily:${day}:msgs`);
      const level = (await kv.get("cfg:level")) || "medium";
      const adLevel = (await kv.get("cfg:adlevel")) || "standard";
      const whiteN = await countPrefixedUids(kv, "verified:", "trusted");
      const blackN = await countPrefixedUids(kv, "banned:");
      const probN = await countPrefixedUids(kv, "probation:");
      if (lines.length > 4) lines.push(SUBSEP);
      lines.push(
        `🤖 <b>@${escapeHtml(b.username || "?")}</b>（<code>${b.id}</code>）`,
        `　 今日：联系人 <b>${dUsers}</b>｜消息 <b>${dMsgs}</b>`,
        `　 累计：联系人 <b>${users}</b>｜消息 <b>${msgs}</b>｜广告拦截 <b>${adBlocked}</b>`,
        `　 验证等级：<b>${LV[level] || LV.medium}</b>｜广告过滤：<b>${AD[adLevel] || AD.standard}</b>`,
        `　 名单：⭐白名单 <b>${whiteN}</b>｜🚫黑名单 <b>${blackN}</b>｜👀观察期 <b>${probN}</b>`,
        ""
      );
    }
    lines.push("<i>注销某个 bot：/del &lt;bot数字ID 或 @用户名&gt;</i>");
    await tg(mToken, "sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: mine.flatMap((b) => [
          [{ text: `📇 联系人管理 @${b.username || b.id}`, callback_data: `mgr:contacts:${b.id}` }],
          [{ text: `⚙️ 设置：验证等级 / 广告过滤 @${b.username || b.id}`, callback_data: `mgr:settings:${b.id}` }],
          [{ text: `🤖 AI 辅助设置 @${b.username || b.id}`, callback_data: `mgr:ai:${b.id}` }],
          [
            { text: "⭐白名单", callback_data: `mgr:wlist:${b.id}` },
            { text: "🚫黑名单", callback_data: `mgr:blist:${b.id}` },
            { text: "👀观察期", callback_data: `mgr:plist:${b.id}` },
          ],
        ]),
      },
    });
    return new Response("OK");
  }

  if (text.startsWith("/del")) {
    const target = (text.split(/\s+/)[1] || "").replace(/^@/, "");
    let botId = /^\d+$/.test(target) ? target : null;
    if (!botId && target) {
      let cursor;
      let complete = false;
      while (!complete && !botId) {
        const page = await registry.list({ prefix: "multi:bot:", cursor });
        for (const k of page.keys) {
          const reg = await registry.get(k.name, { type: "json" });
          if (reg && reg.username === target) botId = k.name.replace("multi:bot:", "");
        }
        complete = page.list_complete;
        cursor = page.cursor;
      }
    }
    if (!botId) {
      await reply("没找到这个 bot。先用 /list 看一下。");
      return new Response("OK");
    }
    const reg = await registry.get(`multi:bot:${botId}`, { type: "json" });
    if (!reg || String(reg.owner) !== String(chatId)) {
      await reply("没找到你名下的这个 bot。先用 /list 看一下。");
      return new Response("OK");
    }
    if (reg.token) await tg(reg.token, "deleteWebhook", {});
    await registry.delete(`multi:bot:${botId}`);
    await reply(`🗑 已注销 @${escapeHtml(reg.username || botId)}，它的转发已停止。`);
    return new Response("OK");
  }

  await reply("没听懂。直接把 Bot Token 发给我就能部署，或发 /help 看用法。");
  return new Response("OK");
}
