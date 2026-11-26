// Cloudflare Worker：Telegram 双向机器人 v5.3

import { renderCodeImage, renderCountImage, renderGridImage } from "./captcha.js";
import { escapeHtml } from "./util.js";
import { setBotMenus } from "./menus.js";
import {
    getAiConfig as sharedGetAiConfig,
    saveAiConfig as sharedSaveAiConfig,
    getAiBroken as sharedGetAiBroken,
    markAiAuthFailure,
    callAiChat as sharedCallAiChat,
    fetchAiModels as sharedFetchAiModels,
    testAiConnection as sharedTestAiConnection,
    maskAiKey,
    fmtAiBrokenTime,
    AI_SUMMARY_SYSTEM_PROMPT,
    assembleSummaryMaterial,
    chunkSummaryText
} from "./ai.js";

// --- 配置常量 ---
const CONFIG = {
    VERIFY_ID_LENGTH: 12,
    VERIFY_EXPIRE_SECONDS: 300,         // 5分钟
    VERIFIED_EXPIRE_SECONDS: 2592000,   // 30天
    MEDIA_GROUP_EXPIRE_SECONDS: 60,
    MEDIA_GROUP_DELAY_MS: 3000,         // 3秒（从2秒增加）
    PENDING_MAX_MESSAGES: 10,           // 验证期间最多暂存的消息数
    RATE_LIMIT_MESSAGE: 45,
    RATE_LIMIT_VERIFY: 3,
    RATE_LIMIT_WINDOW: 60,
    BUTTON_COLUMNS: 2,
    MAX_TITLE_LENGTH: 128,
    MAX_NAME_LENGTH: 30,
    API_TIMEOUT_MS: 10000,
    // 动态人机验证
    CHALLENGE_TTL_SECONDS: 90,          // 单轮挑战有效期 90 秒
    CHALLENGE_ROUNDS_REQUIRED: 2,       // 需连续通过 2 轮不同题型
    CHALLENGE_MAX_FAILS: 3,             // 累计失败 3 次进入冷却
    CHALLENGE_COOLDOWN_SECONDS: 600,    // 冷却 10 分钟
    CHALLENGE_MIN_ANSWER_MS: 1000,      // 答题快于 1 秒视为机器人行为
    // 防广告机器人加强（第一层：验证加固 / 第二层：验证后 probation）
    HONEYPOT_ENABLED: true,             // 验证按钮组混入蜜罐按钮（点中判定机器人）
    PROBATION_HOURS: 24,                // 验证通过后保护期时长（小时）
    PROBATION_MSG_LIMIT: 2,             // 保护期内正常转发满 N 条消息自动解除
    HIGH_RISK_SCORE: 3,                 // 风险分达到此值需多过 1 轮验证
    // 验证等级三档（机主可调，存 KV cfg:level）：light 简易 / medium 中等（默认）/ strong 强力
    LEVEL_DEFAULT: "medium",            // 未设置时的缺省等级
    PROBATION_STRONG_HOURS: 48,         // 强力档 probation 时长（小时）
    PROBATION_STRONG_MSG_LIMIT: 2,      // 强力档 probation 内正常转发满 N 条消息解除
    // 统一累计风险分（risk:<uid> 存 JSON {s:分数, t:周期开始时间戳, r:本周期已提醒}，
    // 非加白用户每条消息累计）：加分 = 广告评分，被拦截再 +2；以 30 天为一个计分周期，周期满自动清零重计。
    // 观察期内达本档拉黑线直接拉黑（obs: 通知由机主处置）；观察期外累计 20 分只提醒机主决定（rsk: 通知），不自动拉黑
    RISK_CYCLE_MS: 30 * 86400 * 1000,   // 计分周期 30 天
    RISK_BAN_LINE_PROBATION: 5,         // 观察期内拉黑线缺省 5 分（快照 ban 优先：简易 8 / 中等 5 / 强力 2）
    RISK_REMIND_LINE_NORMAL: 20,        // 非观察期提醒线 20 分（只提醒，不自动拉黑）
    RISK_BLOCKED_BONUS: 2,              // 被拦截（广告过滤/观察期链接）的消息额外 +2
    // Cloudflare Turnstile 网页验证（仅 strong 强力档且配置了 TURNSTILE_SITE_KEY 时启用）
    TURNSTILE_SESSION_TTL_SECONDS: 600, // Turnstile 一次性会话有效期 10 分钟
    // AI 辅助（机主自带 OpenAI 兼容接口与 Token，存 cfg:ai）：新用户通过验证后异步分析一次，只提醒机主、不拦验证
    AI_INPUT_TTL_SECONDS: 300,          // /ai 面板输入等待态有效期 5 分钟
    AI_ASSIST_PENDING_TTL_SECONDS: 300, // AI 辅助分析进行中标记保留 5 分钟，防并发重复触发
    AI_ASSIST_RETRY_TTL_SECONDS: 3600,  // AI 辅助分析失败标记保留 1 小时，之后有新消息转发时可重试一次
    AI_MODELS_TTL_SECONDS: 600,         // 自动获取的模型列表缓存 10 分钟
    AI_TIMEOUT_MS: 25000,               // AI 接口请求超时 25 秒（部分中转站响应慢）
    AI_DEFAULT_MODEL: "gpt-4o-mini",    // 未选模型时的默认模型名
    // AI 总结模式（cfg:ai.summary，与辅助观察独立）：开启后暂存已转发消息文本，按人汇总生成今日总结
    AI_SUMMARY_TTL_SECONDS: 172800,     // 总结记录保留 48 小时自动过期
    AI_SUMMARY_MAX_PER_USER: 50,        // 每人每天最多记录 50 条，超出丢弃最旧
    AI_SUMMARY_TEXT_MAX: 300,           // 单条记录文本截断 300 字
    AI_SUMMARY_MATERIAL_MAX: 12000,     // 汇总材料总字数上限，超出按人截断并注明
    // 私人转发模式
    FWD_MAP_TTL_SECONDS: 2592000        // fwd 映射保留 30 天
};

// --- 动态验证素材池（运行时程序化生成题目，不使用固定题库） ---
const CHALLENGE_EMOJIS = [
    "🍎", "🍌", "🍇", "🍓", "🍊", "🍉", "🍑", "🍒", "🥝", "🍍",
    "🐶", "🐱", "🐰", "🦊", "🐼", "🐸", "🐵", "🦁", "🐷", "🐔",
    "🚗", "✈️", "🚲", "🚀", "⛵", "🚂", "⚽", "🏀", "🎾", "🏈",
    "⭐", "❤️", "🔥", "💧", "🌙", "☀️", "⚡", "🎈", "🎁", "🔔"
];

// --- 辅助工具函数 ---

// 结构化日志系统
const Logger = {
    /**
     * 记录信息级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    info(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    },

    /**
     * 记录警告级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    warn(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'WARN',
            action,
            ...data
        };
        console.warn(JSON.stringify(log));
    },

    /**
     * 记录错误级别日志
     * @param {string} action - 操作名称
     * @param {Error|string} error - 错误对象或消息
     * @param {object} data - 附加数据
     */
    error(action, error, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            action,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            ...data
        };
        console.error(JSON.stringify(log));
    },

    /**
     * 记录调试级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    debug(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'DEBUG',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    }
};

// 加密安全的随机数生成
function secureRandomInt(min, max) {
    const range = max - min;
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return min + (bytes[0] % range);
}

function secureRandomId(length = 12) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// 随机十六进制串（Turnstile 一次性会话 ID 用）
function secureRandomHex(length = 24) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

// escapeHtml 在 lib/util.js（与管理端共用，顶部已 import）

// 统一排版：标题分隔线 / 块间轻分隔
const SEP = "━━━━━━━━━━━━";
const SUBSEP = "┄┄┄┄┄┄┄┄";

// 安全的 JSON 获取
async function safeGetJSON(env, key, defaultValue = null) {
    try {
        const data = await env.TOPIC_MAP.get(key, { type: "json" });
        if (data === null || data === undefined) {
            return defaultValue;
        }
        if (typeof data !== 'object') {
            Logger.warn('kv_invalid_type', { key, type: typeof data });
            return defaultValue;
        }
        return data;
    } catch (e) {
        Logger.error('kv_parse_failed', e, { key });
        return defaultValue;
    }
}

// 获取所有 KV keys（处理分页）
async function getAllKeys(env, prefix) {
    const allKeys = [];
    let cursor = undefined;

    do {
        const result = await env.TOPIC_MAP.list({ prefix, cursor });
        allKeys.push(...result.keys);
        cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return allKeys;
}

// Fisher-Yates 洗牌算法
function shuffleArray(arr) {
    const array = [...arr];
    for (let i = array.length - 1; i > 0; i--) {
        const j = secureRandomInt(0, i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 速率限制检查
async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
    const key = `ratelimit:${action}:${userId}`;
    const countStr = await env.TOPIC_MAP.get(key);
    const count = parseInt(countStr || "0");

    if (count >= limit) {
        return { allowed: false, remaining: 0 };
    }

    await env.TOPIC_MAP.put(key, String(count + 1), { expirationTtl: window });
    return { allowed: true, remaining: limit - count - 1 };
}

export default {
  async fetch(request, env, ctx) {
    // 环境自检：私人模式（设置了 OWNER_ID）只需要 BOT_TOKEN + OWNER_ID
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    const ownerMode = isOwnerMode(env);

    // 【修复 #7】规范化环境变量，统一为字符串类型
    const normalizedEnv = {
        ...env,
        SUPERGROUP_ID: env.SUPERGROUP_ID ? String(env.SUPERGROUP_ID) : "",
        OWNER_ID: ownerMode ? String(env.OWNER_ID) : "",
        BOT_TOKEN: String(env.BOT_TOKEN)
    };

    if (request.method !== "POST") return new Response("OK");

    // 验证 Content-Type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        Logger.warn('invalid_content_type', { contentType });
        return new Response("OK");
    }

    let update;
    try {
      update = await request.json();

      // 验证基本结构
      if (!update || typeof update !== 'object') {
          Logger.warn('invalid_json_structure', { update: typeof update });
          return new Response("OK");
      }
    } catch (e) {
      Logger.error('json_parse_failed', e);
      return new Response("OK");
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, Date.now()));

    if (msg.chat && msg.chat.type === "private") {
      // 私人模式：机主的私聊走机主处理（回信/指令），不走普通用户验证流程
      if (ownerMode && String(msg.chat.id) === normalizedEnv.OWNER_ID) {
        try {
          await handleOwnerMessage(msg, normalizedEnv, ctx);
        } catch (e) {
          Logger.error('owner_message_failed', e, { userId: msg.chat.id });
        }
        return new Response("OK");
      }
      try {
        await handlePrivateMessage(msg, normalizedEnv, ctx);
      } catch (e) {
        // 不向用户泄露技术细节
        const errText = `⚠️ 系统繁忙，请稍后再试。`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error('private_message_failed', e, { userId: msg.chat.id });
      }
      return new Response("OK");
    }

    return new Response("OK");
  },
};

// ---------------- 核心业务逻辑 ----------------

// ---- 验证等级（三档，机主在私人模式下用 /level 切换，存 KV cfg:level）----

// 读取当前 bot 的验证等级：light | medium | strong
// 私人模式读 cfg:level，缺省/非法值按 LEVEL_DEFAULT
async function getVerifyLevel(env) {
    if (!isOwnerMode(env)) return "medium";
    const lv = await env.TOPIC_MAP.get("cfg:level");
    return (lv === "light" || lv === "strong") ? lv : CONFIG.LEVEL_DEFAULT;
}

// 读取当前 bot 的验证方式：quiz 答题（默认）| web 网页（存 cfg:vmode）
// 存量 "ai"（旧 AI 判定模式已下线）一律按 quiz 处理
async function getVerifyMode(env) {
    if (!isOwnerMode(env)) return "quiz";
    const m = await env.TOPIC_MAP.get("cfg:vmode");
    return m === "web" ? "web" : "quiz";
}

// 等级对应的 probation 参数（ban = 观察期内累计风险分拉黑线；三档都有观察期）
// 简易以前无观察期，现按用户定版改为 24h / 8 分；中等 24h / 5 分；强力 48h / 2 分
function levelProbationParams(level) {
    if (level === "light") return { hours: 24, limit: 2, ban: 8 };
    if (level === "strong") return { hours: CONFIG.PROBATION_STRONG_HOURS, limit: CONFIG.PROBATION_STRONG_MSG_LIMIT, ban: 2 };
    return { hours: CONFIG.PROBATION_HOURS, limit: CONFIG.PROBATION_MSG_LIMIT, ban: CONFIG.RISK_BAN_LINE_PROBATION };
}

// ---- 第二层防护：probation（新用户保护期）----

// 读取 probation 快照 { ts, hours, limit, ban }：通过验证时按当时等级写入，避免机主中途改档影响已在观察期的人
// 兼容旧数据（probation:<userId> 为纯时间戳字符串）：读不到 JSON 时按 medium（24h / 2 条 / 拉黑线 5 分）处理；
// 旧 JSON 快照无 ban 字段时同样按中等 5 分兜底
async function getProbationMeta(env, userId) {
    const raw = await env.TOPIC_MAP.get(`probation:${userId}`);
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj.ts === "number" && obj.ts > 0) {
            return {
                ts: obj.ts,
                hours: obj.hours || CONFIG.PROBATION_HOURS,
                limit: obj.limit || CONFIG.PROBATION_MSG_LIMIT,
                ban: (typeof obj.ban === "number" && obj.ban > 0) ? obj.ban : CONFIG.RISK_BAN_LINE_PROBATION
            };
        }
    } catch { /* 旧格式：纯时间戳，继续走下面的兼容分支 */ }
    const ts = parseInt(raw) || 0;
    if (!ts) return null;
    return { ts, hours: CONFIG.PROBATION_HOURS, limit: CONFIG.PROBATION_MSG_LIMIT, ban: CONFIG.RISK_BAN_LINE_PROBATION };
}

// 读取 probation 状态；已满快照 hours 小时则自动解除并返回 false
async function isInProbation(env, userId) {
    const meta = await getProbationMeta(env, userId);
    if (!meta) return false;
    if (Date.now() - meta.ts >= meta.hours * 3600 * 1000) {
        await env.TOPIC_MAP.delete(`probation:${userId}`);
        await env.TOPIC_MAP.delete(`probation_count:${userId}`);
        Logger.info('probation_expired', { userId });
        return false;
    }
    return true;
}

// 判定消息是否带链接特征（probation 期间只拦截链接类；转发消息一律放行）
function hasLinkFeature(msg) {
    // 链接实体（文本或图片说明里的 url / text_link）
    const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
    if (entities.some(e => e && (e.type === "url" || e.type === "text_link"))) return true;
    // 文本特征
    const text = msg.text || msg.caption || "";
    if (/(https?:\/\/|t\.me\/|telegram\.me\/|www\.)/i.test(text)) return true;
    return false;
}

// probation 期间一条正常消息转发成功后计数，满快照 limit 条自动解除
async function bumpProbationCount(env, userId) {
    const meta = await getProbationMeta(env, userId);
    const limit = meta ? meta.limit : CONFIG.PROBATION_MSG_LIMIT;
    const count = parseInt(await env.TOPIC_MAP.get(`probation_count:${userId}`) || "0") + 1;
    if (count >= limit) {
        await env.TOPIC_MAP.delete(`probation:${userId}`);
        await env.TOPIC_MAP.delete(`probation_count:${userId}`);
        Logger.info('probation_completed_by_messages', { userId, count });
    } else {
        await env.TOPIC_MAP.put(`probation_count:${userId}`, String(count));
    }
}

// ---- 统一累计风险分（risk:<uid>）：给观察期装上牙齿，也覆盖普通用户的长期累计 ----
// 非加白用户的每条消息都计分：加分 = 该条广告评分（scoreAdMessage），被拦截
// （广告过滤拦截或观察期链接拦截）额外 +RISK_BLOCKED_BONUS；得 0 分的干净消息不加分、也不清零。
// 计分周期 30 天：risk:<uid> 存 JSON { s: 本周期累计分, t: 周期开始时间戳, r: 本周期是否已提醒 }；
// 每次计分时若 now - t ≥ 30 天则开启新周期（分数从本次加分重新计，r 重置）；键 TTL = 本周期剩余秒数，
// 不滑动续期到周期外。旧值兼容：纯数字字符串视为分数、周期从当前时刻起算。
// 处置按用户当时身份分：观察期内取通过验证时快照的 ban（简易 8 / 中等 5 / 强力 2 分），达线直接拉黑；
// 观察期外不自动拉黑——本周期累计达 RISK_REMIND_LINE_NORMAL（20 分）时只提醒机主决定（每周期只提醒一次）。
// 分数跨进出观察期连续计算（同一周期内进/出观察期、观察期到期/满额解除都不清分）；
// 机主手动加白/解封/清除验证时会一并清分（见 clearRiskScore 的各调用点）。

// 解析 risk:<uid> 原始值 → { s, t, r }；无值返回 null。旧纯数字值：分数照单全收，周期从现在起算。
function parseRiskState(raw) {
    if (raw == null || raw === "") return null;
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object" && typeof obj.s === "number") {
            return { s: obj.s, t: (typeof obj.t === "number" && obj.t > 0) ? obj.t : Date.now(), r: obj.r ? 1 : 0 };
        }
    } catch { /* 非 JSON：按旧纯数字格式走下面 */ }
    const n = parseInt(raw) || 0;
    return n > 0 ? { s: n, t: Date.now(), r: 0 } : null;
}

// 读取当前有效计分状态：无记录或周期已满（now - t ≥ 30 天）一律视为新周期 { s:0, t:now, r:0 }
async function getRiskState(env, userId) {
    const st = parseRiskState(await env.TOPIC_MAP.get(`risk:${userId}`));
    if (!st) return { s: 0, t: Date.now(), r: 0 };
    if (Date.now() - st.t >= CONFIG.RISK_CYCLE_MS) return { s: 0, t: Date.now(), r: 0 };
    return st;
}

// 当前周期累计分（展示/判断用）
async function getRiskScore(env, userId) {
    return (await getRiskState(env, userId)).s;
}

async function clearRiskScore(env, userId) {
    await env.TOPIC_MAP.delete(`risk:${userId}`);
}

// 状态展示用的观察期/风险分两行（/cd 与信息头 ℹ️ 状态共用，纯文本）：
// 加白用户豁免两者；观察期内显示剩余小时、干净消息进度与本档拉黑线；
// 观察期外显示 30 天周期累计分与 20 分提醒线
async function userProbationRiskLines(env, userId, verifyStatus) {
    if (verifyStatus === "trusted") {
        return { probation: "观察期: 🌟 已豁免（加白）", risk: "风险分: 🌟 已豁免（加白）" };
    }
    const inProb = await isInProbation(env, userId);
    const score = await getRiskScore(env, userId);
    if (inProb) {
        const meta = await getProbationMeta(env, userId);
        const remainH = meta ? Math.max(0, Math.ceil((meta.ts + meta.hours * 3600000 - Date.now()) / 3600000)) : 0;
        const cnt = parseInt(await env.TOPIC_MAP.get(`probation_count:${userId}`) || "0") || 0;
        return {
            probation: `观察期: 👀 是（剩 ${remainH} 小时，干净消息 ${cnt}/${meta ? meta.limit : CONFIG.PROBATION_MSG_LIMIT}）`,
            risk: `风险分: ${score}/${meta ? meta.ban : CONFIG.RISK_BAN_LINE_PROBATION}（达线自动拉黑）`
        };
    }
    return { probation: "观察期: 否", risk: `风险分: ${score}/${CONFIG.RISK_REMIND_LINE_NORMAL}（30 天周期，达 ${CONFIG.RISK_REMIND_LINE_NORMAL} 提醒机主）` };
}

// 写回计分状态：TTL 设为本周期剩余秒数（周期结束键自动过期，不滑动续期）
async function saveRiskState(env, userId, st) {
    const remainSec = Math.max(1, Math.ceil((st.t + CONFIG.RISK_CYCLE_MS - Date.now()) / 1000));
    const val = { s: st.s, t: st.t };
    if (st.r) val.r = 1;
    await env.TOPIC_MAP.put(`risk:${userId}`, JSON.stringify(val), { expirationTtl: remainSec });
}

// 累计一次计分：points 为本条加分（已含拦截额外分），reasons 为本条命中信号（通知展示用），
// line 为该用户当前适用的线：观察期内 = 快照 ban 拉黑线（简易 8 / 中等 5 / 强力 2），
// 观察期外 = RISK_REMIND_LINE_NORMAL 提醒线（20 分）；inProbation 区分两种处置。
// 观察期内达线：立即拉黑（写 banned、清观察期与风险分），推送 obs: 按钮通知由机主决定
// 解封/加白/保持黑名单，返回 { total, banned:true }，调用方应直接结束（该消息不转发）。
// 观察期外达线：不拉黑；仅本周期首次达线时推送 rsk: 按钮提醒（拉黑/加白/暂不处理）并置 r 标记，
// 分数保留继续累计，返回 { total, banned:false, reminded }。未达线只写回累计。
async function applyRiskScore(env, userId, msg, points, reasons, line, inProbation) {
    const st = await getRiskState(env, userId);
    const total = st.s + points;
    if (inProbation && total >= line) {
        await env.TOPIC_MAP.put(`banned:${userId}`, "1");
        await env.TOPIC_MAP.delete(`probation:${userId}`);
        await env.TOPIC_MAP.delete(`probation_count:${userId}`);
        await env.TOPIC_MAP.delete(`risk:${userId}`);
        Logger.info('risk_auto_banned', { userId, total, line, inProbation });
        if (isOwnerMode(env)) {
            const from = msg.from || {};
            const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || "未知";
            const uname = from.username ? `@${from.username}` : "无";
            await tgCall(env, "sendMessage", {
                chat_id: Number(env.OWNER_ID),
                text: `🚫 <b>观察期自动拉黑</b>\n${SEP}\n访客：<b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）\nID：<code>${userId}</code>\n累计风险分：<b>${total}</b> 分（拉黑线 ${line} 分）\n本条命中：${escapeHtml((reasons || []).join("、") || "—")}\n内容：${escapeHtml(buildAdPreview(msg))}\n\n<i>已加入黑名单，其后续消息不再转发。点下方按钮处置：</i>`,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "🔓 解封", callback_data: `obs:unban:${userId}` },
                        { text: "⭐ 加白", callback_data: `obs:trust:${userId}` },
                        { text: "保持黑名单", callback_data: `obs:keep:${userId}` }
                    ]]
                }
            });
        }
        return { total, banned: true };
    }
    const next = { s: total, t: st.t, r: st.r };
    let reminded = false;
    if (!inProbation && total >= line && !st.r) {
        next.r = 1;
        reminded = true;
    }
    await saveRiskState(env, userId, next);
    if (reminded && isOwnerMode(env)) {
        Logger.info('risk_remind_line_reached', { userId, total, line });
        const from = msg.from || {};
        const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || "未知";
        const uname = from.username ? `@${from.username}` : "无";
        await tgCall(env, "sendMessage", {
            chat_id: Number(env.OWNER_ID),
            text: `⚠️ <b>累计计分提醒</b>\n${SEP}\n访客：<b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）\nID：<code>${userId}</code>\n累计风险分：<b>${total}</b>/${line} 分（30 天计分周期）\n本条命中：${escapeHtml((reasons || []).join("、") || "—")}\n内容：${escapeHtml(buildAdPreview(msg))}\n\n<i>该用户 30 天周期内累计计分已达 ${line} 分，是否拉黑由您决定。</i>`,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "🚫 拉黑", callback_data: `rsk:ban:${userId}` },
                    { text: "⭐ 加白", callback_data: `rsk:trust:${userId}` },
                    { text: "暂不处理", callback_data: `rsk:ignore:${userId}` }
                ]]
            }
        });
    }
    return { total, banned: false, reminded };
}

// ---- 广告过滤（三档，机主在私人模式下用 /ad 切换，存 KV cfg:adlevel）----

const AD_KEYWORDS = ["兼职", "刷单", "赚钱", "投资", "理财", "博彩", "赌博", "USDT", "招商", "代理加盟", "返利", "薅羊毛", "出U", "收U", "承兑"];
const AD_THRESHOLDS = { light: 5, standard: 3, strict: 2 };
const AD_LEVEL_NAMES = { light: "🟢 宽松", standard: "🟡 标准", strict: "🔴 严格" };

// 读取当前 bot 的广告过滤档位：light | standard | strict（缺省 standard）
async function getAdLevel(env) {
    const lv = await env.TOPIC_MAP.get("cfg:adlevel");
    return (lv === "light" || lv === "strict") ? lv : "standard";
}

// 广告评分：对访客消息按信号累计分数，达到当前档位阈值即拦截
function scoreAdMessage(msg) {
    let score = 0;
    const reasons = [];
    const text = msg.text || msg.caption || "";
    const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];

    // t.me 链接（文本或 text_link 实体指向 t.me）
    const hasTgLink = /t\.me\//i.test(text) || entities.some(e => e && e.type === "text_link" && /t\.me\//i.test(e.url || ""));
    // 链接：URL/text_link 实体或 URL 正则 +2
    if (hasLinkFeature(msg) || /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io|xyz|top|vip|cc|shop|site|online|click|link)\b)/i.test(text)) {
        score += 2; reasons.push("链接+2");
    }
    // t.me 链接额外 +2
    if (hasTgLink) { score += 2; reasons.push("t.me+2"); }
    // 广告关键词：每个 +2，上限 +4
    let kwScore = 0;
    for (const kw of AD_KEYWORDS) {
        if (text.includes(kw)) kwScore += 2;
    }
    if (kwScore > 0) {
        const add = Math.min(kwScore, 4);
        score += add; reasons.push(`关键词+${add}`);
    }
    // 手机号 +2
    if (/1[3-9]\d{9}/.test(text)) { score += 2; reasons.push("手机号+2"); }
    // @提及 +1
    if (entities.some(e => e && e.type === "mention") || /@[A-Za-z0-9_]{3,}/.test(text)) { score += 1; reasons.push("@提及+1"); }
    // 转发自频道/群的消息 +2
    if (msg.forward_origin || msg.forward_from_chat || msg.forward_from) { score += 2; reasons.push("转发+2"); }
    // 联系人名片 +1
    if (msg.contact) { score += 1; reasons.push("名片+1"); }
    return { score, reasons };
}

// 消息内容预览（广告拦截通知机主用）：文本截断 200 字，非文本写类型
function buildAdPreview(msg) {
    const text = msg.text || msg.caption || "";
    if (text) return text.slice(0, 200);
    if (msg.photo) return "[图片]";
    if (msg.video) return "[视频]";
    if (msg.document) return "[文件]";
    if (msg.contact) return "[联系人名片]";
    if (msg.sticker) return "[贴纸]";
    if (msg.voice) return "[语音]";
    if (msg.video_note) return "[视频消息]";
    if (msg.animation) return "[动图]";
    return "[其他消息]";
}

// 广告拦截统计：累计 stat:adblocked + 每日 stat:daily:<日期>:adblocked（每日键保留 40 天）
async function recordAdBlockedStat(env) {
    try {
        const total = parseInt(await env.TOPIC_MAP.get("stat:adblocked") || "0") || 0;
        await env.TOPIC_MAP.put("stat:adblocked", String(total + 1));
        const dKey = `stat:daily:${shanghaiDateStr()}:adblocked`;
        const d = parseInt(await env.TOPIC_MAP.get(dKey) || "0") || 0;
        await env.TOPIC_MAP.put(dKey, String(d + 1), { expirationTtl: 40 * 86400 });
    } catch (e) {
        Logger.error('record_ad_blocked_stat_failed', e);
    }
}

async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // 速率限制检查
  const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
      await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "⚠️ 发送过于频繁，请稍后再试。"
      });
      return;
  }

  // 拦截普通用户发送的指令
  if (msg.text && msg.text.startsWith("/") && msg.text.trim() !== "/start") {
      return;
  }

  const isBanned = await env.TOPIC_MAP.get(`banned:${userId}`);
  if (isBanned) {
      // 已拉黑：消息不转发；给访客一条拉黑提示（bannotice 标记限流：同一人 1 小时内最多提示一次，
      // 解封时各解封路径会一并删除该标记，重新拉黑后可立即再次提示）
      const noticeKey = `bannotice:${userId}`;
      if (!(await env.TOPIC_MAP.get(noticeKey))) {
          await env.TOPIC_MAP.put(noticeKey, "1", { expirationTtl: 3600 });
          await tgCall(env, "sendMessage", {
              chat_id: userId,
              text: "🚫 <b>您已被拉黑</b>\n\n您的消息无法送达。",
              parse_mode: "HTML"
          });
      }
      return;
  }

  // 缓存用户信息（username / Premium 状态），供验证风险打分在无 from 时回退使用
  if (msg.from) {
      await env.TOPIC_MAP.put(`uinfo:${userId}`, JSON.stringify({
          username: msg.from.username || null,
          is_premium: !!msg.from.is_premium
      }), { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
  }

  const verified = await env.TOPIC_MAP.get(`verified:${userId}`);

  // 全局暂停接收（机主裸发 /close 时写 cfg:closed）：暂停时不转发、不触发验证，只回一条暂停提示；
  // 已加白（trusted）用户豁免、照常转发（与广告过滤的加白豁免口径一致）
  if (verified !== "trusted" && (await env.TOPIC_MAP.get("cfg:closed")) === "1") {
      await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "⏸ 对方暂时关闭了私聊，请稍后再试。"
      });
      return;
  }

  if (!verified) {
    const isStart = msg.text && msg.text.trim() === "/start";
    const pendingMsgId = isStart ? null : msg.message_id;
    await sendVerificationChallenge(userId, env, pendingMsgId, msg.from || null, msg, ctx);
    return;
  }

  const isTrusted = verified === "trusted";
  // 观察期状态（trusted 豁免：加白用户不走观察期逻辑）
  const inProbation = !isTrusted && (await isInProbation(env, userId));

  // 广告评分与拦截判定（仅私人模式；加白 trusted 用户豁免）：只算一次，广告过滤与累计风险分共用
  let adScore = 0;
  let adReasons = [];
  let adLevel = "standard";
  let adBlocked = false;
  if (isOwnerMode(env) && !isTrusted) {
      adLevel = await getAdLevel(env);
      const s = scoreAdMessage(msg);
      adScore = s.score;
      adReasons = s.reasons;
      adBlocked = adScore >= AD_THRESHOLDS[adLevel];
  }
  const linkBlocked = inProbation && hasLinkFeature(msg);
  const blocked = adBlocked || linkBlocked;

  // 统一累计风险分：本条加分 = 广告评分 +（被拦截时额外 +2）；30 天一个计分周期。
  // 观察期内达快照 ban 线（简易 8 / 中等 5 / 强力 2）立即拉黑并推送通知（obs: 按钮），消息不转发；
  // 观察期外达 20 分提醒线只推送提醒（rsk: 按钮）由机主决定是否拉黑，消息照常走后续流程。
  let riskTotal = 0;
  let banLine = CONFIG.RISK_REMIND_LINE_NORMAL;
  if (inProbation) {
      const meta0 = await getProbationMeta(env, userId);
      if (meta0) banLine = meta0.ban;
  }
  if (isOwnerMode(env) && !isTrusted) {
      riskTotal = await getRiskScore(env, userId);
      const points = adScore + (blocked ? CONFIG.RISK_BLOCKED_BONUS : 0);
      if (points > 0) {
          const r = await applyRiskScore(env, userId, msg, points, adReasons, banLine, inProbation);
          riskTotal = r.total;
          if (r.banned) {
              // 自动拉黑通知已推送给机主；给访客回一条与拦截场景一致的提示后结束
              await tgCall(env, "sendMessage", {
                  chat_id: userId,
                  text: adBlocked
                      ? "🚫 <b>消息已被拦截</b>\n\n您的消息疑似广告，未能送达。"
                      : "🚫 <b>消息已被拦截</b>\n\n您的消息未能送达。",
                  parse_mode: "HTML"
              });
              return;
          }
      }
  }

  // 广告过滤拦截（未达拉黑线时走原流程：通知机主一键放行/加白/拉黑）
  if (adBlocked) {
      Logger.info('ad_message_blocked', { userId, messageId: msg.message_id, score: adScore, adLevel, reasons: adReasons });
      await recordAdBlockedStat(env);
      await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "🚫 <b>消息已被拦截</b>\n\n您的消息疑似广告，未能送达。",
          parse_mode: "HTML"
      });
      const from = msg.from || {};
      const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || "未知";
      const uname = from.username ? `@${from.username}` : "无";
      await tgCall(env, "sendMessage", {
          chat_id: Number(env.OWNER_ID),
          text: `🚫 <b>广告拦截</b>\n${SEP}\n访客：<b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）\nID：<code>${userId}</code>\n评分：<b>${adScore}</b> 分（${AD_LEVEL_NAMES[adLevel]}，阈值 ${AD_THRESHOLDS[adLevel]})\n命中：${escapeHtml(adReasons.join("、") || "—")}\n内容：${escapeHtml(buildAdPreview(msg))}`,
          parse_mode: "HTML",
          reply_markup: {
              inline_keyboard: [[
                  { text: "✅ 放行", callback_data: `adpass:${userId}:${msg.message_id}` },
                  { text: "⭐ 加白", callback_data: `adtrust:${userId}:${msg.message_id}` },
                  { text: "🚫 拉黑", callback_data: `adban:${userId}` }
              ]]
          }
      });
      return;
  }

  // probation 期间：带链接的消息直接拦截不转发（转发消息放行）
  if (linkBlocked) {
      Logger.info('probation_message_blocked', { userId, messageId: msg.message_id });
      const pMeta = await getProbationMeta(env, userId);
      const pHours = pMeta ? pMeta.hours : CONFIG.PROBATION_HOURS;
      await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: `👀 <b>新用户保护期</b>\n${SEP}\n保护期内不能发送链接，请先正常聊天：发满 <b>2</b> 条正常消息、满 <b>${pHours}</b> 小时或被管理员信任后解除。`,
          parse_mode: "HTML"
      });
      // 私人模式下通知机主并附操作按钮（拉黑/解除隔离/加白），便于机主一键处置（群模式不发此类提示）
      if (isOwnerMode(env)) {
          const snippet = msg.text ? `\n内容：${escapeHtml(msg.text.slice(0, 100))}` : "";
          await tgCall(env, "sendMessage", {
              chat_id: Number(env.OWNER_ID),
              text: `⚠️ <b>已拦截链接消息</b>\n${SEP}\n访客 ID：<code>${userId}</code>${snippet}\n当前累计风险分：<b>${riskTotal}/${banLine}</b>（达 ${banLine} 分将自动拉黑）`,
              parse_mode: "HTML",
              reply_markup: {
                  inline_keyboard: [[
                      { text: "🚫 拉黑", callback_data: `iso:ban:${userId}` },
                      { text: "🔓 解除隔离", callback_data: `iso:release:${userId}` },
                      { text: "⭐ 加白", callback_data: `iso:trust:${userId}` }
                  ]]
              }
          });
      }
      return;
  }

  await forwardUserMessage(msg, userId, key, env, ctx);

  // 观察期解除进度：只有干净消息（计分 0 且未被拦截，能走到这里即未被拦）才计数，满额自动解除；
  // 带分的通过消息只累计风险分，不计解除进度
  if (inProbation && adScore === 0) {
      await bumpProbationCount(env, userId);
  }
}

// ---------------- 私人转发模式（OWNER_ID） ----------------

// 是否启用私人模式：设置了 OWNER_ID 即启用，消息转发给机主个人号而非话题群
function isOwnerMode(env) {
    return !!(env && env.OWNER_ID && String(env.OWNER_ID).trim() !== "");
}

// 统一转发入口（验证通过后的消息、验证期间暂存的消息都走这里）：平台版只有私人模式，直接转发给机主
async function forwardUserMessage(msg, userId, key, env, ctx) {
    return forwardToOwner(msg, userId, key, env, ctx);
}

// 构建发给机主的信息头文本（HTML 发送：昵称/用户名先转义，避免特殊字符破版）
function buildUserHeaderText(from, userId) {
    const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim() || "未知";
    const username = from?.username ? `@${from.username}` : "无";
    return `👤 <b>来自用户的消息</b>\n${SEP}\n昵称：<b>${escapeHtml(name)}</b>\n用户名：${escapeHtml(username)}\nID：<code>${userId}</code>\n\n<i>💡 回复本条或下面转发的消息即可回信</i>`;
}

// 信息头上的一键管理按钮（回调 own:<动作>:<userId>，仅机主本人可点，处理见 handleOwnerCallback）
function buildOwnerKeyboard(userId) {
    return {
        inline_keyboard: [
            [
                { text: "🚫 屏蔽", callback_data: `own:ban:${userId}` },
                { text: "⭐ 加白", callback_data: `own:trust:${userId}` }
            ],
            [
                { text: "🔓 解封", callback_data: `own:unban:${userId}` },
                { text: "ℹ️ 状态", callback_data: `own:info:${userId}` }
            ],
            [
                { text: "🧹 清除验证", callback_data: `own:revoke:${userId}` }
            ]
        ]
    };
}

// 清除某用户的全部验证状态（/reset 与 own:revoke 共用同一组删除）：已验证标记、观察期及计数、
// 待验证标记、进行中的答题挑战与 Turnstile 会话、失败计数与冷却一并清掉，
// 对方下次发消息必须从头重新走验证（机主反复测试验证流程用）
async function clearUserVerification(env, userId) {
    await env.TOPIC_MAP.delete(`verified:${userId}`);
    await env.TOPIC_MAP.delete(`probation:${userId}`);
    await env.TOPIC_MAP.delete(`probation_count:${userId}`);
    await env.TOPIC_MAP.delete(`risk:${userId}`);
    await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
    await env.TOPIC_MAP.delete(`challenge:${userId}`);
    await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
    await env.TOPIC_MAP.delete(`verify_fails:${userId}`);
    await env.TOPIC_MAP.delete(`verify_cooldown:${userId}`);
    const sess = await env.TOPIC_MAP.get(`tsess_by_user:${userId}`);
    if (sess) await env.TOPIC_MAP.delete(`tsess:${sess}`);
    await env.TOPIC_MAP.delete(`tsess_by_user:${userId}`);
}

// 私人模式数据统计：累计转发消息数 + 唯一联系人数（get+put 计数器，失败不影响转发主流程）
// 上海时区日期串 YYYY-MM-DD（每日统计的键）
function shanghaiDateStr(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}

async function recordForwardStat(env, userId) {
    try {
        const msgs = parseInt(await env.TOPIC_MAP.get("stat:msgs") || "0") || 0;
        await env.TOPIC_MAP.put("stat:msgs", String(msgs + 1));
        const seen = await env.TOPIC_MAP.get(`seen:${userId}`);
        if (!seen) {
            await env.TOPIC_MAP.put(`seen:${userId}`, "1");
            const users = parseInt(await env.TOPIC_MAP.get("stat:users") || "0") || 0;
            await env.TOPIC_MAP.put("stat:users", String(users + 1));
        }
        // 每日统计（键保留 40 天）：stat:daily:<日期>:msgs / :users
        const day = shanghaiDateStr();
        const dMsgs = parseInt(await env.TOPIC_MAP.get(`stat:daily:${day}:msgs`) || "0") || 0;
        await env.TOPIC_MAP.put(`stat:daily:${day}:msgs`, String(dMsgs + 1), { expirationTtl: 40 * 86400 });
        const dSeenKey = `seen:daily:${day}:${userId}`;
        const dSeen = await env.TOPIC_MAP.get(dSeenKey);
        if (!dSeen) {
            await env.TOPIC_MAP.put(dSeenKey, "1", { expirationTtl: 40 * 86400 });
            const dUsers = parseInt(await env.TOPIC_MAP.get(`stat:daily:${day}:users`) || "0") || 0;
            await env.TOPIC_MAP.put(`stat:daily:${day}:users`, String(dUsers + 1), { expirationTtl: 40 * 86400 });
        }
    } catch (e) {
        Logger.error('record_forward_stat_failed', e, { userId });
    }
}

// 记录机主侧消息 -> 用户的映射，供机主回复时反查
async function putFwdMapping(env, ownerMessageId, userId) {
    if (!ownerMessageId) return;
    await env.TOPIC_MAP.put(`fwd:${ownerMessageId}`, String(userId), { expirationTtl: CONFIG.FWD_MAP_TTL_SECONDS });
}

// 私人模式转发：信息头 + copyMessage 发给机主，并记录 fwd 映射（不建论坛话题）
async function forwardToOwner(msg, userId, key, env, ctx) {
    const ownerId = Number(env.OWNER_ID);

    // 并发兜底：被标记为需要重新验证时先发起验证
    const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
    if (needsVerify) {
        await sendVerificationChallenge(userId, env, msg.message_id || null, msg.from || null);
        return;
    }

    let rec = await safeGetJSON(env, key, null);
    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }
    if (!rec) {
        // 私人模式不建话题，只保留状态记录（closed/title 供 /info 使用）
        rec = { closed: false, title: buildTopicTitle(msg.from || {}) };
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    }

    // 媒体组（相册）：整组只发一次信息头，组内消息由 handleMediaGroup 聚合后发送并记录映射
    if (msg.media_group_id) {
        const hdrKey = `mghdr:${msg.media_group_id}`;
        const hdrSent = await env.TOPIC_MAP.get(hdrKey);
        if (!hdrSent) {
            await env.TOPIC_MAP.put(hdrKey, "1", { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
            const headerRes = await tgCall(env, "sendMessage", { chat_id: ownerId, text: buildUserHeaderText(msg.from, userId), parse_mode: "HTML", reply_markup: buildOwnerKeyboard(userId) });
            if (headerRes.ok) await putFwdMapping(env, headerRes.result?.message_id, userId);
        }
        await handleMediaGroup(msg, env, ctx, {
            direction: "p2o",
            targetChat: ownerId,
            mapUserId: userId
        });
        await recordForwardStat(env, userId);
        // 总结模式：媒体组整组只记一条（以组内首条到达时的内容/占位为准）
        if (!hdrSent) await recordSummaryMessage(env, msg, userId);
        // AI 辅助：新用户首条消息转发成功后异步分析一次（后台执行，不阻塞转发）
        await maybeTriggerAiAssist(env, ctx, msg, userId);
        return;
    }

    const headerRes = await tgCall(env, "sendMessage", { chat_id: ownerId, text: buildUserHeaderText(msg.from, userId), parse_mode: "HTML", reply_markup: buildOwnerKeyboard(userId) });
    if (headerRes.ok) await putFwdMapping(env, headerRes.result?.message_id, userId);

    const copyRes = await tgCall(env, "copyMessage", { chat_id: ownerId, from_chat_id: userId, message_id: msg.message_id });
    if (copyRes.ok) {
        await putFwdMapping(env, copyRes.result?.message_id, userId);
        await recordForwardStat(env, userId);
        // 总结模式：转发成功才记录（开关关时内部直接返回）
        await recordSummaryMessage(env, msg, userId);
        // AI 辅助：新用户首条消息转发成功后异步分析一次（后台执行，不阻塞转发）
        await maybeTriggerAiAssist(env, ctx, msg, userId);
    } else {
        Logger.error('forward_to_owner_failed', copyRes.description || 'copyMessage failed', { userId, messageId: msg.message_id });
    }
}

// 机主自检修复（裸发 /fix）：查本 bot 的 webhook 状态 → 重新绑定（带原 secret，避免校验失效）→
// 重推命令菜单，最后给机主发一份报告。覆盖「webhook 失效型没反应」；若 Telegram 侧把本 bot
// 按 ID 挂起，各调用会超时失败、报告如实写明——那不是本地状态卡住，指令清不掉，只能换新 bot。
async function runBotSelfFix(env, ownerId) {
    const lines = ["🛠 <b>自检修复报告</b>", SEP];
    try {
        const info = await tgCall(env, "getWebhookInfo", {});
        if (info && info.ok && info.result) {
            const r = info.result;
            lines.push(`当前 webhook：<code>${escapeHtml(r.url || "(未设置)")}</code>`);
            lines.push(`待处理消息：<b>${r.pending_update_count || 0}</b> 条`);
            if (r.last_error_message) lines.push(`最近错误：${escapeHtml(String(r.last_error_message))}`);
        } else {
            lines.push("⚠️ 查不到 webhook 状态（Telegram 未正常响应）");
        }
    } catch {
        lines.push("⚠️ 查询 webhook 状态超时（Telegram 可能正在挂起本 bot）");
    }
    try {
        const wh = await tgCall(env, "setWebhook", {
            url: `${env.APP_ORIGIN}/api/webhook?b=${env.BOT_ID}`,
            ...(env.WEBHOOK_SECRET ? { secret_token: env.WEBHOOK_SECRET } : {}),
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: false
        });
        lines.push(wh && wh.ok ? "✅ webhook 已重新绑定" : "❌ webhook 重新绑定失败（Telegram 可能已挂起本 bot，只能换新 bot）");
    } catch {
        lines.push("❌ webhook 重新绑定超时（Telegram 可能已挂起本 bot，只能换新 bot）");
    }
    try {
        const menuOk = await setBotMenus(env.BOT_TOKEN, ownerId);
        lines.push(menuOk ? "✅ 命令菜单已重推" : "⚠️ 命令菜单重推失败");
    } catch {
        lines.push("⚠️ 命令菜单重推失败");
    }
    try {
        await tgCall(env, "sendMessage", { chat_id: ownerId, text: lines.join("\n"), parse_mode: "HTML" });
    } catch {}
}

// 私人模式 /cleanup（机主裸发）：扫描带内嵌过期时间的残留键并删除——
// tsess:<session>（JSON 内 exp 已过）连带其 tsess_by_user:<uid> 指针；
// challenge:<uid>（issuedAt 超过 10 分钟未更新，远超单轮 90 秒有效期）连带 user_challenge:<uid> 指针。
// 无内嵌时间戳的键（needs_verify:/mgctx: 等靠 KV TTL 自行过期）无法判断，一律不碰，避免误删。
// 完成后给机主发回执（扫描 N 项，删除 M 项），M=0 也发。
async function runPrivateCleanup(env) {
    const ownerId = Number(env.OWNER_ID);
    let scanned = 0;
    let deleted = 0;
    try {
        const now = Date.now();
        const tsessKeys = await getAllKeys(env, "tsess:");
        for (const { name } of tsessKeys) {
            scanned++;
            const sess = await safeGetJSON(env, name, null);
            if (sess && typeof sess.exp === "number" && sess.exp <= now) {
                await env.TOPIC_MAP.delete(name);
                deleted++;
                if (sess.userId != null) {
                    const ptr = await env.TOPIC_MAP.get(`tsess_by_user:${sess.userId}`);
                    if (ptr && name === `tsess:${ptr}`) {
                        await env.TOPIC_MAP.delete(`tsess_by_user:${sess.userId}`);
                        deleted++;
                    }
                }
            }
        }
        const challengeKeys = await getAllKeys(env, "challenge:");
        for (const { name } of challengeKeys) {
            scanned++;
            const state = await safeGetJSON(env, name, null);
            const issuedAt = state && typeof state.issuedAt === "number" ? state.issuedAt : 0;
            if (issuedAt && now - issuedAt > 10 * 60 * 1000) {
                await env.TOPIC_MAP.delete(name);
                deleted++;
                const uid = name.slice("challenge:".length);
                if (/^\d+$/.test(uid) && (await env.TOPIC_MAP.get(`user_challenge:${uid}`))) {
                    await env.TOPIC_MAP.delete(`user_challenge:${uid}`);
                    deleted++;
                }
            }
        }
    } catch (e) {
        Logger.error('private_cleanup_failed', e, { ownerId: env.OWNER_ID });
    }
    await tgCall(env, "sendMessage", {
        chat_id: ownerId,
        text: `🧹 清理完成：扫描 ${scanned} 项，删除 ${deleted} 项过期数据。`
    });
}

// 机主私聊处理：回复机器人转发的消息 -> 回信给对应用户；回复 + 指令 -> 对该用户执行管理操作
async function handleOwnerMessage(msg, env, ctx) {
    const ownerId = Number(env.OWNER_ID);
    const replyTo = msg.reply_to_message;

    if (!replyTo) {
        const plainText = (msg.text || "").trim();
        // AI 配置输入等待态（/ai 面板点设置类按钮后置位 cfg:ai_input，5 分钟过期）：
        // 机主下一条普通消息即作为该项的值；发 /cancel 取消，发其他命令取消等待并继续执行该命令
        const aiInputField = await env.TOPIC_MAP.get("cfg:ai_input");
        if (aiInputField) {
            if (plainText === "/cancel") {
                await env.TOPIC_MAP.delete("cfg:ai_input");
                await tgCall(env, "sendMessage", { chat_id: ownerId, text: "已取消 AI 设置。" });
                return;
            }
            if (plainText.startsWith("/")) {
                await env.TOPIC_MAP.delete("cfg:ai_input");
                // 不 return，继续走下面的命令处理
            } else if (msg.text) {
                await handleAiInputValue(msg, env, aiInputField);
                return;
            }
        }
        // 主人功能清单：机主私聊 /start 或 /help 时回复（访客的 /start 不走这里，维持原样）
        if (plainText === "/start" || plainText === "/help") {
            await tgCall(env, "sendMessage", { chat_id: ownerId, text: OWNER_HELP_TEXT, parse_mode: "HTML" });
            return;
        }
        // 广告过滤设置：机主无引用发送 /ad 或 /guanggao 时回复带按钮的三档面板
        if (plainText === "/ad" || plainText === "/guanggao") {
            const current = await getAdLevel(env);
            await tgCall(env, "sendMessage", {
                chat_id: ownerId,
                text: buildAdPanelText(current),
                parse_mode: "HTML",
                reply_markup: buildAdKeyboard(current)
            });
            return;
        }
        // 验证方式设置：机主无引用发送 /level 或 /dengji 时回复带按钮的方式面板（quiz 时含难度按钮）
        if (plainText === "/level" || plainText === "/dengji") {
            const mode = await getVerifyMode(env);
            const current = await getVerifyLevel(env);
            await tgCall(env, "sendMessage", {
                chat_id: ownerId,
                text: buildLevelPanelText(mode, current),
                parse_mode: "HTML",
                reply_markup: buildLevelKeyboard(mode, current)
            });
            return;
        }
        // AI 辅助配置：机主无引用发送 /ai 时回复辅助设置面板（自带接口与 Token）
        if (plainText === "/ai") {
            const cfg = await getAiConfig(env);
            await tgCall(env, "sendMessage", {
                chat_id: ownerId,
                text: buildAiPanelText(cfg, await getAiBroken(env)),
                parse_mode: "HTML",
                reply_markup: buildAiKeyboard(cfg)
            });
            return;
        }
        // AI 今日总结：机主无引用发送 /zongjie 或 /summary 时生成当天消息汇总（记录来自总结模式的暂存）
        if (plainText === "/zongjie" || plainText === "/summary") {
            await generateTodaySummary(env);
            return;
        }
        // 名单与观察期管理：机主无引用发送 /baimingdan /heimingdan /guancha 时回复对应列表（带操作按钮）
        if (plainText === "/baimingdan" || plainText === "/heimingdan" || plainText === "/guancha") {
            const view = plainText === "/baimingdan"
                ? await buildWhitelistView(env)
                : plainText === "/heimingdan"
                    ? await buildBlacklistView(env)
                    : await buildProbationListView(env);
            await tgCall(env, "sendMessage", { chat_id: ownerId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
            return;
        }
        // 数据统计：机主无引用发送 /stats 或 /tongji 时回复累计数据
        if (plainText === "/stats" || plainText === "/tongji") {
            const users = parseInt(await env.TOPIC_MAP.get("stat:users") || "0") || 0;
            const msgs = parseInt(await env.TOPIC_MAP.get("stat:msgs") || "0") || 0;
            const day = shanghaiDateStr();
            const dUsers = parseInt(await env.TOPIC_MAP.get(`stat:daily:${day}:users`) || "0") || 0;
            const dMsgs = parseInt(await env.TOPIC_MAP.get(`stat:daily:${day}:msgs`) || "0") || 0;
            const counts = await memberCounts(env);
            await tgCall(env, "sendMessage", { chat_id: ownerId, text: `📊 <b>数据统计</b>\n${SEP}\n今日联系人数：<b>${dUsers}</b>\n今日转发消息数：<b>${dMsgs}</b>\n累计联系人数：<b>${users}</b>\n累计转发消息数：<b>${msgs}</b>\n\n⭐白名单 <b>${counts.white}</b>｜🚫黑名单 <b>${counts.black}</b>｜👀观察期 <b>${counts.prob}</b>`, parse_mode: "HTML" });
            return;
        }
        // 全局暂停/恢复接收：机主裸发 /close /open（与回复版的单人对话关闭/恢复不同，这里是全局开关 cfg:closed）
        if (plainText === "/close") {
            await env.TOPIC_MAP.put("cfg:closed", "1");
            await tgCall(env, "sendMessage", { chat_id: ownerId, text: "⏸ 已暂停接收消息，访客发消息会被告知已暂停；发 /open 恢复。" });
            return;
        }
        if (plainText === "/open") {
            await env.TOPIC_MAP.delete("cfg:closed");
            await tgCall(env, "sendMessage", { chat_id: ownerId, text: "▶️ 已恢复接收消息。" });
            return;
        }
        // 裸 /reset 没有目标用户：回引导，不再静默（回复转发消息版 /reset 行为不变，仍重置被回复者）
        if (plainText === "/reset") {
            await tgCall(env, "sendMessage", { chat_id: ownerId, text: "请回复某个人的转发消息再发 /reset 重置TA的验证；也可以点转发消息头部的 🧹清除验证 按钮。" });
            return;
        }
        // 私人模式清理：裸 /cleanup 扫描并删除已过期的残留键，异步执行后单独发回执（机主必达）
        if (plainText === "/cleanup") {
            ctx.waitUntil(runPrivateCleanup(env));
            return;
        }
        // 自检修复：裸 /fix 查本 bot 的 webhook 状态并重新绑定、重推菜单，异步执行后发报告
        if (plainText === "/fix") {
            ctx.waitUntil(runBotSelfFix(env, ownerId));
            return;
        }
        // 相册的后续条目可能不带回复引用：靠 media_group_id 找回上下文后继续聚合
        if (msg.media_group_id) {
            const targetUserId = await env.TOPIC_MAP.get(`mgctx:${msg.media_group_id}`);
            if (targetUserId) {
                await handleMediaGroup(msg, env, ctx, { direction: "o2p", targetChat: Number(targetUserId) });
            }
        }
        // 没有回复引用的普通消息直接忽略（不报错、不转发）
        return;
    }

    const mappedUserId = await env.TOPIC_MAP.get(`fwd:${replyTo.message_id}`);
    if (!mappedUserId) {
        await tgCall(env, "sendMessage", { chat_id: ownerId, text: "⚠️ 只能回复机器人转发的消息才能回信。" });
        return;
    }
    const userId = Number(mappedUserId);
    const text = (msg.text || "").trim();

    // 指令：回复某条转发消息时发送 /ban 等指令，作用到该用户
    if (text.startsWith("/")) {
        await handleOwnerCommand(text, userId, env);
        return;
    }

    // 媒体组回信：首条带回复引用时记录相册上下文，后续条目靠 media_group_id 续传
    if (msg.media_group_id) {
        await env.TOPIC_MAP.put(`mgctx:${msg.media_group_id}`, String(userId), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
        await handleMediaGroup(msg, env, ctx, { direction: "o2p", targetChat: userId });
        return;
    }

    await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: ownerId, message_id: msg.message_id });
}

// 机主指令：回复某条转发消息时发送，作用到该用户，确认回执发回机主私聊
async function handleOwnerCommand(text, userId, env) {
    const ownerId = Number(env.OWNER_ID);
    const reply = (t) => tgCall(env, "sendMessage", { chat_id: ownerId, text: t, parse_mode: "Markdown" });
    const key = `user:${userId}`;

    if (text === "/close") {
        let rec = await safeGetJSON(env, key, null);
        if (!rec) rec = { closed: false };
        rec.closed = true;
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        await reply("🚫 **对话已强制关闭**");
        return;
    }

    if (text === "/open") {
        let rec = await safeGetJSON(env, key, null);
        if (!rec) rec = { closed: false };
        rec.closed = false;
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        await reply("✅ **对话已恢复**");
        return;
    }

    if (text === "/reset") {
        await clearUserVerification(env, userId);
        await reply("🔄 **验证重置**");
        return;
    }

    if ((text === "/trust" || text === "/bai")) {
        await env.TOPIC_MAP.put(`verified:${userId}`, "trusted");
        await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        // 被机主信任即刻解除 probation，并清掉累计风险分
        await env.TOPIC_MAP.delete(`probation:${userId}`);
        await env.TOPIC_MAP.delete(`probation_count:${userId}`);
        await clearRiskScore(env, userId);
        await reply("🌟 **已设置永久信任**");
        return;
    }

    if ((text === "/ban" || text === "/hei")) {
        await env.TOPIC_MAP.put(`banned:${userId}`, "1");
        await reply("🚫 **用户已封禁**");
        return;
    }

    if ((text === "/unban" || text === "/jiehei")) {
        await env.TOPIC_MAP.delete(`banned:${userId}`);
        await env.TOPIC_MAP.delete(`bannotice:${userId}`);
        await clearRiskScore(env, userId);
        await reply("✅ **用户已解封**");
        return;
    }

    if ((text === "/info" || text === "/cd")) {
        const userRec = await safeGetJSON(env, key, null);
        const verifyStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
        const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);
        const pr = await userProbationRiskLines(env, userId, verifyStatus);
        const info = `👤 **用户信息**\nUID: \`${userId}\`\n昵称: ${userRec?.title || "未知"}\n验证状态: ${verifyStatus ? (verifyStatus === 'trusted' ? '🌟 永久信任' : '✅ 已验证') : '❌ 未验证'}\n封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}\n${pr.probation}\n${pr.risk}\nLink: [点击私聊](tg://user?id=${userId})`;
        await reply(info);
        return;
    }

    // 未知指令不转发给用户，直接忽略
    Logger.debug('owner_unknown_command_ignored', { userId, text });
}

// ---------------- 验证模块 (动态生成) ----------------

// 挑战题型生成器：全部在运行时程序化随机生成，不使用固定题库
function pickDistinctEmojis(n) {
    return shuffleArray([...CHALLENGE_EMOJIS]).slice(0, n);
}

// ① 找不同（图片题）：4×4 图形阵列里混一个不同形状，按钮改为位置选项，
// 哪个位置是答案只在图片里，文本/按钮读不到
function genOddOneOutChallenge() {
    const shapePool = ["circle", "square", "triangle"];
    const [base, odd] = shuffleArray([...shapePool]).slice(0, 2);
    const oddIndex = secureRandomInt(0, 16);
    const posLabel = (i) => `第${Math.floor(i / 4) + 1}行第${(i % 4) + 1}个`;
    const correctLabel = posLabel(oddIndex);
    const otherCells = shuffleArray(
        Array.from({ length: 16 }, (_, i) => i).filter((i) => i !== oddIndex)
    );
    const options = shuffleArray([correctLabel, ...otherCells.slice(0, 3).map(posLabel)]);
    // 蜜罐：一个不在选项内的其他位置标签
    const trapCell = otherCells[3 + secureRandomInt(0, otherCells.length - 3)];
    return {
        type: "odd",
        text: `🔍 <b>找不同</b>\n\n图中 4×4 的图形阵列里有一个与众不同，请点出它的<b>位置</b>。`,
        image: { kind: "grid", base, odd, oddIndex },
        options,
        answerIndex: options.indexOf(correctLabel),
        columns: 2,
        trapText: posLabel(trapCell)
    };
}

// ② 数数（图片题）：图中随机分布蓝色圆形与橙色方形，只数圆形，数量只在图片里
function genCountChallenge() {
    const count = secureRandomInt(3, 10); // 圆形出现 3~9 次
    const fillerCount = secureRandomInt(2, 8); // 方形 2~7 个
    const optionSet = new Set([count]);
    for (const d of shuffleArray([-2, -1, 1, 2, 3])) {
        if (optionSet.size >= 4) break;
        if (count + d > 0) optionSet.add(count + d);
    }
    const options = shuffleArray([...optionSet]).map(String);
    // 蜜罐：一个不在选项内的近似数字（与正确答案保持距离，降低真人误数命中概率）
    const trapCandidates = [count + 4, count + 5, count - 4, count + 6, count - 5].filter(v => v > 0 && !optionSet.has(v));
    return {
        type: "count",
        text: `🔢 <b>数一数</b>\n\n请数一数：图中一共有几个 <b>圆形</b>？`,
        image: { kind: "count", circles: count, squares: fillerCount },
        options,
        answerIndex: options.indexOf(String(count)),
        columns: 2,
        trapText: String(trapCandidates.length > 0 ? trapCandidates[0] : count + 7)
    };
}

// ③ 指令定位：按钮单行排列，点击从左数第 N 个
function genPositionChallenge() {
    const emojis = pickDistinctEmojis(6);
    const options = emojis.slice(0, 5);
    const n = secureRandomInt(1, 6); // 1~5
    return {
        type: "position",
        text: `👉 <b>按指令点击</b>\n\n请点击从左数第 <b>${n}</b> 个按钮。`,
        options,
        answerIndex: n - 1,
        columns: options.length,
        // 蜜罐追加在末尾（第 6 个），不改变前 5 个按钮的视觉序号
        trapText: emojis[5],
        trapAtEnd: true
    };
}

// ④ 顺序记忆（图片题）：4 个字符的序列只画进图片，选项为字符的不同排列，
// 目标序列不出现在任何文本里，脚本只能靠猜
function genSequenceChallenge() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆的 I/O/0/1
    const seq = shuffleArray(chars.split("")).slice(0, 4); // 4 个互不相同字符
    const correct = seq.join("");
    const optionSet = new Set([correct]);
    let guard = 0;
    while (optionSet.size < 4 && guard < 100) {
        guard++;
        optionSet.add(shuffleArray([...seq]).join(""));
    }
    const options = shuffleArray([...optionSet]);
    // 蜜罐：一个不在选项内的其他排列
    let trapText = shuffleArray([...seq]).join("");
    guard = 0;
    while (optionSet.has(trapText) && guard < 100) {
        guard++;
        trapText = shuffleArray([...seq]).join("");
    }
    return {
        type: "sequence",
        text: `🧠 <b>顺序记忆</b>\n\n请记住图中序列的顺序，点选与它完全一致的选项。`,
        image: { kind: "code", code: correct },
        options,
        answerIndex: options.indexOf(correct),
        columns: 2,
        trapText
    };
}

// ⑤ 动态口令（图片题）：随机 4 位数字/字母口令只画进图片，选项为一位之差的相似口令，
// 口令明文不出现在消息文本里
function genPassphraseChallenge() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆的 I/O/0/1
    const makeSimilar = (code) => {
        const arr = code.split("");
        const pos = secureRandomInt(0, arr.length);
        let c = chars[secureRandomInt(0, chars.length)];
        if (c === arr[pos]) c = chars[(chars.indexOf(c) + 1) % chars.length];
        arr[pos] = c;
        return arr.join("");
    };
    const code = Array.from({ length: 4 }, () => chars[secureRandomInt(0, chars.length)]).join("");
    const optionSet = new Set([code]);
    let guard = 0;
    while (optionSet.size < 4 && guard < 100) {
        guard++;
        optionSet.add(makeSimilar(code));
    }
    const options = shuffleArray([...optionSet]);
    // 蜜罐：又一个相似口令，不在选项内
    let trapText = makeSimilar(code);
    guard = 0;
    while (optionSet.has(trapText) && guard < 100) {
        guard++;
        trapText = makeSimilar(code);
    }
    return {
        type: "passphrase",
        text: `🔑 <b>动态口令</b>\n\n请点击下面与图中口令完全相同的按钮。`,
        image: { kind: "code", code },
        options,
        answerIndex: options.indexOf(code),
        columns: 2,
        trapText
    };
}

const CHALLENGE_GENERATORS = {
    odd: genOddOneOutChallenge,
    count: genCountChallenge,
    position: genPositionChallenge,
    sequence: genSequenceChallenge,
    passphrase: genPassphraseChallenge
};

// 随机生成一轮挑战（可排除已用题型，保证同一轮验证内题型不重复）
function generateChallenge(excludeTypes = []) {
    let types = Object.keys(CHALLENGE_GENERATORS).filter(t => !excludeTypes.includes(t));
    if (types.length === 0) types = Object.keys(CHALLENGE_GENERATORS);
    const type = types[secureRandomInt(0, types.length)];
    return CHALLENGE_GENERATORS[type]();
}

// 按钮使用短 ID（挑战 ID + 选项序号），避免回调数据截断
// 蜜罐：在按钮组随机位置混入一个外观正常的按钮（callback 前缀 trap:），
// 真人按题意作答不会点它，乱点/全点的机器人命中即判定异常
function buildChallengeKeyboard(challengeId, challenge, honeypotEnabled = true) {
    const options = challenge.options || [];
    const buttons = options.map((opt, idx) => ({
        text: opt,
        callback_data: `verify:${challengeId}:${idx}`
    }));
    if (CONFIG.HONEYPOT_ENABLED && honeypotEnabled && challenge.trapText) {
        const trapBtn = { text: challenge.trapText, callback_data: "" };
        // 指令定位题的蜜罐只能放末尾，否则会改变前面按钮的视觉序号
        const insertAt = challenge.trapAtEnd
            ? buttons.length
            : secureRandomInt(0, buttons.length + 1);
        buttons.splice(insertAt, 0, trapBtn);
        trapBtn.callback_data = `trap:${challengeId}:${insertAt}`;
    }
    const keyboard = [];
    const cols = challenge.columns || CONFIG.BUTTON_COLUMNS;
    for (let i = 0; i < buttons.length; i += cols) {
        keyboard.push(buttons.slice(i, i + cols));
    }
    return { inline_keyboard: keyboard };
}

// ---- 图片题呈现：答案只在图片里；渲染/发送失败时自动回退文本题（指令定位），不把用户锁死 ----

// 按 image 规格渲染 PNG 字节（captcha.js 纯 JS 光栅绘制）
async function renderChallengeImage(image) {
    if (!image) return null;
    if (image.kind === "code") return renderCodeImage(image.code);
    if (image.kind === "count") return renderCountImage({ circles: image.circles, squares: image.squares });
    if (image.kind === "grid") return renderGridImage({ base: image.base, odd: image.odd, oddIndex: image.oddIndex });
    return null;
}

// 题目消息正文（文本题作 text、图片题作 caption，格式一致）
function buildChallengeText(round, totalRounds, challenge, fullFooter = true) {
    const footer = fullFooter
        ? `\n\n<i>⏱️ 请在 ${CONFIG.CHALLENGE_TTL_SECONDS} 秒内完成，连对 ${totalRounds} 轮即可通过</i>`
        : `\n\n<i>⏱️ 请在 ${CONFIG.CHALLENGE_TTL_SECONDS} 秒内完成</i>`;
    return `🛡️ <b>人机验证</b>（第 <b>${round}/${totalRounds}</b> 轮）\n${SEP}\n${challenge.text}${footer}`;
}

// 全新发送一轮题目：图片题 sendPhoto、文本题 sendMessage；成功返回 { media, messageId }
async function sendChallengeFresh(env, userId, state, challenge, png) {
    const text = buildChallengeText(state.round, state.totalRounds, challenge, true);
    const keyboard = buildChallengeKeyboard(state.id, challenge, state.honeypot !== false);
    if (challenge.image && png) {
        const res = await tgSendPhoto(env, { chat_id: userId, photoBytes: png, caption: text, reply_markup: keyboard });
        if (res.ok && res.result?.message_id) return { media: "photo", messageId: res.result.message_id };
        Logger.warn('challenge_photo_send_failed', { userId, description: res.description });
        return null;
    }
    const res = await tgCall(env, "sendMessage", {
        chat_id: userId,
        text,
        parse_mode: "HTML",
        reply_markup: keyboard
    });
    if (res.ok && res.result?.message_id) return { media: "text", messageId: res.result.message_id };
    return null;
}

// 把一轮题目呈现给用户，返回最终生效的 { challenge, media, messageId }：
// - 首轮（无 prevMessageId）：全新发送
// - 推进轮次：与上一条同为图片 → editMessageMedia 换图换 caption；同为文本 → editMessageText；
//   类型不同或编辑失败 → 删除旧消息后全新发送
// - 图片渲染/发送任何一步失败：整轮降级为文本题（指令定位）再发，challenge 随之替换
async function presentChallenge(env, userId, state, challenge, { prevMessageId = null, prevMedia = "text", fullFooter = true } = {}) {
    let finalChallenge = challenge;
    let png = null;
    if (challenge.image) {
        try {
            png = await renderChallengeImage(challenge.image);
        } catch (e) {
            Logger.error('challenge_render_error', e, { userId, type: challenge.type });
            png = null;
        }
        if (!png) finalChallenge = genPositionChallenge();
    }
    const isPhoto = !!(finalChallenge.image && png);

    if (prevMessageId) {
        const text = buildChallengeText(state.round, state.totalRounds, finalChallenge, fullFooter);
        const keyboard = buildChallengeKeyboard(state.id, finalChallenge, state.honeypot !== false);
        let edited = null;
        if (isPhoto && prevMedia === "photo") {
            edited = await tgEditMessageMedia(env, {
                chat_id: userId, message_id: prevMessageId, photoBytes: png, caption: text, reply_markup: keyboard
            }).catch(() => null);
        } else if (!isPhoto && prevMedia !== "photo") {
            edited = await tgCall(env, "editMessageText", {
                chat_id: userId, message_id: prevMessageId, text, parse_mode: "HTML", reply_markup: keyboard
            });
        }
        if (edited && edited.ok) {
            return { challenge: finalChallenge, media: isPhoto ? "photo" : "text", messageId: prevMessageId };
        }
        // 类型不同或编辑失败：删旧发新
        await tgCall(env, "deleteMessage", { chat_id: userId, message_id: prevMessageId }).catch(() => {});
    }

    let sent = await sendChallengeFresh(env, userId, state, finalChallenge, png);
    if (!sent && finalChallenge.image) {
        // 图片发送失败：降级文本题再发一次
        finalChallenge = genPositionChallenge();
        sent = await sendChallengeFresh(env, userId, state, finalChallenge, null);
    }
    if (sent) return { challenge: finalChallenge, media: sent.media, messageId: sent.messageId };
    return { challenge: finalChallenge, media: "text", messageId: prevMessageId };
}

// 回退替换题目后，把生效题目同步回状态（题型/答案/选项/蜜罐）
function syncStateWithChallenge(state, challenge) {
    state.type = challenge.type;
    state.answerIndex = challenge.answerIndex;
    state.options = challenge.options;
    state.columns = challenge.columns;
    state.trapText = challenge.trapText || null;
}

// 编辑题目消息的提示文字（作废/过期/通过）：图片消息改 caption，文本消息改 text
async function editChallengeNotice(env, userId, messageId, media, text) {
    if (!messageId) return;
    if (media === "photo") {
        await tgCall(env, "editMessageCaption", {
            chat_id: userId,
            message_id: messageId,
            caption: text,
            parse_mode: "HTML"
        });
    } else {
        await tgCall(env, "editMessageText", {
            chat_id: userId,
            message_id: messageId,
            text,
            parse_mode: "HTML"
        });
    }
}

// 累计验证失败（默认 +1，蜜罐命中 +2）；达到上限时进入 10 分钟冷却。返回 true 表示已进入冷却
async function registerChallengeFail(env, userId, amount = 1) {
    const key = `verify_fails:${userId}`;
    const count = parseInt(await env.TOPIC_MAP.get(key) || "0") + amount;
    if (count >= CONFIG.CHALLENGE_MAX_FAILS) {
        await env.TOPIC_MAP.put(`verify_cooldown:${userId}`, "1", { expirationTtl: CONFIG.CHALLENGE_COOLDOWN_SECONDS });
        await env.TOPIC_MAP.delete(key);
        Logger.warn('verification_cooldown_started', { userId, failCount: count });
        return true;
    }
    await env.TOPIC_MAP.put(key, String(count), { expirationTtl: CONFIG.CHALLENGE_COOLDOWN_SECONDS });
    return false;
}

// 清理进行中的挑战状态
async function clearChallengeState(env, userId) {
    await env.TOPIC_MAP.delete(`challenge:${userId}`);
    await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
}

// 风险打分：无 username +2、非 Premium +1、新号（ID 较大）+1
// fromObj 缺失时回退到 handlePrivateMessage 时缓存的用户信息 uinfo:<userId>
async function computeRiskScore(env, userId, fromObj) {
    let from = fromObj || null;
    if (!from) {
        from = await safeGetJSON(env, `uinfo:${userId}`, null);
    }
    let score = 0;
    if (from) {
        if (!from.username) score += 2;
        if (!from.is_premium) score += 1;
    }
    if (Number(userId) > 7500000000) score += 1;
    return score;
}

async function sendVerificationChallenge(userId, env, pendingMsgId, fromObj = null, msgObj = null, ctx = null) {
    // 冷却中：直接提示，不下发新题
    const inCooldown = await env.TOPIC_MAP.get(`verify_cooldown:${userId}`);
    if (inCooldown) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⏳ <b>验证失败次数过多</b>\n\n请 10 分钟后再重新发送消息进行验证。",
            parse_mode: "HTML"
        });
        return;
    }

    // 已有进行中的挑战：仅将新消息加入待转发队列，避免重复下发题目/触发验证限速
    const existing = await safeGetJSON(env, `challenge:${userId}`, null);
    if (existing && existing.userId === userId) {
        if (pendingMsgId) {
            const pendingIds = Array.isArray(existing.pending_ids) ? existing.pending_ids.slice() : [];
            if (!pendingIds.includes(pendingMsgId)) {
                pendingIds.push(pendingMsgId);
                existing.pending_ids = pendingIds.length > CONFIG.PENDING_MAX_MESSAGES
                    ? pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES)
                    : pendingIds;
                await env.TOPIC_MAP.put(`challenge:${userId}`, JSON.stringify(existing), { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });
            }
        }
        Logger.debug('verification_duplicate_skipped', { userId, challengeId: existing.id, hasPending: !!pendingMsgId });
        return;
    }

    // Turnstile 会话进行中（strong 档网页验证已下发）：不重复下发，仅更新待处理消息 ID
    if (env.TURNSTILE_SITE_KEY) {
        const pendingSession = await env.TOPIC_MAP.get(`tsess_by_user:${userId}`);
        if (pendingSession) {
            const sess = await safeGetJSON(env, `tsess:${pendingSession}`, null);
            if (sess && Number(sess.userId) === Number(userId) && sess.exp > Date.now()
                && (await getVerifyLevel(env)) === "strong") {
                if (pendingMsgId && sess.pendingMsgId !== pendingMsgId) {
                    sess.pendingMsgId = pendingMsgId;
                    const remain = Math.max(1, Math.floor((sess.exp - Date.now()) / 1000));
                    await env.TOPIC_MAP.put(`tsess:${pendingSession}`, JSON.stringify(sess), { expirationTtl: remain });
                }
                Logger.debug('turnstile_duplicate_skipped', { userId });
                return;
            }
            // 会话已失效或等级已改档：清掉指针，按正常流程重新发起
            await env.TOPIC_MAP.delete(`tsess_by_user:${userId}`);
        }
    }

    // 验证方式二选一（cfg:vmode）：web 方式在下方分流；quiz（含存量 ai 按 quiz 兜底）走答题流程
    const vmode = await getVerifyMode(env);

    // 验证请求速率限制：仅在需要创建新挑战时检查
    const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
    if (!verifyLimit.allowed) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⚠️ 验证请求过于频繁，请5分钟后再试。"
        });
        return;
    }

    // web 网页方式：新访客直接走 Turnstile 网页真人验证，不先答题；
    // 平台未配置 TURNSTILE_SITE_KEY 时回退答题流程
    if (vmode === "web" && env.TURNSTILE_SITE_KEY) {
        await sendTurnstilePrompt(userId, env, pendingMsgId);
        return;
    }

    // strong 强力档且已配置 Turnstile：优先走网页真人验证（答题验证作为备用入口，在提示消息上切换）
    const level = await getVerifyLevel(env);
    if (level === "strong" && env.TURNSTILE_SITE_KEY) {
        await sendTurnstilePrompt(userId, env, pendingMsgId);
        return;
    }

    await startQuizChallenge(userId, env, {
        pendingIds: pendingMsgId ? [pendingMsgId] : [],
        fromObj,
        level
    });
}

// 发起答题验证：按等级/风险分决定轮次与蜜罐，再下发第一轮题目
// 验证等级决定轮次与蜜罐（等级只在验证发起时读取，过程中改档不影响本轮验证）：
// light 简易：固定 1 轮、无蜜罐；strong 强力：固定 3 轮；medium 中等：风险分级（低风险 2 轮 / 高风险 3 轮）
async function startQuizChallenge(userId, env, { pendingIds = [], fromObj = null, level = null } = {}) {
    const lv = level || (await getVerifyLevel(env));
    const riskScore = await computeRiskScore(env, userId, fromObj);
    let totalRounds;
    if (lv === "light") totalRounds = 1;
    else if (lv === "strong") totalRounds = 3;
    else totalRounds = riskScore >= CONFIG.HIGH_RISK_SCORE ? 3 : CONFIG.CHALLENGE_ROUNDS_REQUIRED;
    const honeypot = lv !== "light";

    await startChallengeRound(userId, env, {
        round: 1,
        usedTypes: [],
        pendingIds,
        riskScore,
        totalRounds,
        level: lv,
        honeypot
    });
}

// strong 档 Turnstile 优先流程：生成一次性会话并下发带 WebApp 按钮的验证提示
async function sendTurnstilePrompt(userId, env, pendingMsgId) {
    const session = secureRandomHex(24);
    const record = {
        userId,
        pendingMsgId: pendingMsgId || null,
        exp: Date.now() + CONFIG.TURNSTILE_SESSION_TTL_SECONDS * 1000
    };
    await env.TOPIC_MAP.put(`tsess:${session}`, JSON.stringify(record), { expirationTtl: CONFIG.TURNSTILE_SESSION_TTL_SECONDS });
    await env.TOPIC_MAP.put(`tsess_by_user:${userId}`, session, { expirationTtl: CONFIG.TURNSTILE_SESSION_TTL_SECONDS });

    const verifyUrl = `${env.APP_ORIGIN}/verify?b=${env.BOT_ID}&s=${session}`;
    Logger.info('turnstile_prompt_sent', { userId });

    await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: `🛡️ <b>人机验证</b>\n${SEP}\n当前开启了强力验证，请先完成网页真人验证：点击下方按钮，在打开的页面里完成验证即可。\n\n<i>⏱️ 验证链接 10 分钟内有效；如网页打不开或无法完成，可改用答题验证</i>`,
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [
                [{ text: "🛡 点此进行真人验证", web_app: { url: verifyUrl } }],
                [{ text: "改用答题验证", callback_data: `tsquiz:${session}` }]
            ]
        }
    });
}

// Turnstile 提示上的「改用答题验证」：校验会话归属后作废会话，转入答题流程
async function handleTurnstileFallback(query, env, data) {
    const userId = query.from.id;
    const session = data.slice("tsquiz:".length);
    const sess = session ? await safeGetJSON(env, `tsess:${session}`, null) : null;
    if (!sess || Number(sess.userId) !== Number(userId) || sess.exp <= Date.now()) {
        await tgCall(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: "❌ 验证会话已过期，请重新发送消息",
            show_alert: true
        });
        return;
    }

    await env.TOPIC_MAP.delete(`tsess:${session}`);
    await env.TOPIC_MAP.delete(`tsess_by_user:${userId}`);

    await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "已切换为答题验证"
    });

    const messageId = query.message?.message_id;
    if (messageId) {
        await tgCall(env, "editMessageText", {
            chat_id: userId,
            message_id: messageId,
            text: "🛡️ <b>人机验证</b>\n\n已切换为答题验证，题目见下方新消息。",
            parse_mode: "HTML"
        });
    }

    Logger.info('turnstile_fallback_to_quiz', { userId });
    await startQuizChallenge(userId, env, {
        pendingIds: sess.pendingMsgId ? [sess.pendingMsgId] : [],
        fromObj: query.from || null
    });
}

// 下发一轮动态挑战（新建题目消息），并保存状态：轮次/题型/答案下标/签发时间/风险分
async function startChallengeRound(userId, env, { round, usedTypes, pendingIds, riskScore = 0, totalRounds = CONFIG.CHALLENGE_ROUNDS_REQUIRED, forceType = null, level = "medium", honeypot = true }) {
    const challenge = (forceType && CHALLENGE_GENERATORS[forceType])
        ? CHALLENGE_GENERATORS[forceType]()
        : generateChallenge(usedTypes);
    const challengeId = secureRandomId(CONFIG.VERIFY_ID_LENGTH);
    const state = {
        id: challengeId,
        userId,
        round,
        totalRounds,
        riskScore,
        level,
        honeypot,
        type: challenge.type,
        answerIndex: challenge.answerIndex,
        options: challenge.options,
        columns: challenge.columns,
        trapText: challenge.trapText || null,
        usedTypes: [...usedTypes, challenge.type],
        issuedAt: Date.now(),
        pending_ids: pendingIds,
        media: "text" // 题目消息形态：text 文本消息 / photo 图片消息（编辑时需区分）
    };

    await env.TOPIC_MAP.put(`challenge:${userId}`, JSON.stringify(state), { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });
    // 兼容旧指针键：标记该用户正在验证中
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, challengeId, { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });

    Logger.info('verification_sent', {
        userId,
        challengeId,
        round,
        type: challenge.type,
        riskScore,
        totalRounds,
        level,
        pendingCount: pendingIds.length
    });

    // 呈现题目：图片题 sendPhoto（答案只在图片里），文本题 sendMessage；
    // 图片渲染/发送失败时 presentChallenge 内部自动回退文本题并返回生效题目
    const presented = await presentChallenge(env, userId, state, challenge, { fullFooter: true });
    if (presented.challenge !== challenge) {
        syncStateWithChallenge(state, presented.challenge);
        state.usedTypes = [...usedTypes, presented.challenge.type];
        Logger.warn('challenge_image_fallback', { userId, challengeId, fallbackType: presented.challenge.type });
    }
    state.media = presented.media;
    // 记录题目消息 ID，便于后续编辑同一条消息推进轮次
    if (presented.messageId) {
        state.messageId = presented.messageId;
        await env.TOPIC_MAP.put(`challenge:${userId}`, JSON.stringify(state), { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });
    }
    return state;
}

// 一次失败处理（答错 / 答题过快 / 蜜罐命中）：累计次数，未达上限则作废当前挑战并立即下发新挑战（轮次从 1 重来）；达上限进入冷却
async function failChallengeAttempt(env, userId, query, state, alertText, failCount = 1) {
    const messageId = query.message?.message_id;
    const cooldown = await registerChallengeFail(env, userId, failCount);
    await clearChallengeState(env, userId);

    await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: alertText,
        show_alert: true
    });

    if (messageId) {
        await editChallengeNotice(env, userId, messageId, state.media, cooldown
            ? "⏳ <b>验证失败次数过多</b>\n\n请 10 分钟后再重新发送消息进行验证。"
            : "❌ <b>本轮验证已作废</b>\n\n请看下方新的验证题目。");
    }

    if (!cooldown) {
        const pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids : [];
        // 重来仍保留本次验证的风险分级与等级（高风险用户重开后依然要过满轮次）
        await startChallengeRound(userId, env, {
            round: 1,
            usedTypes: [],
            pendingIds,
            riskScore: state.riskScore || 0,
            totalRounds: state.totalRounds || CONFIG.CHALLENGE_ROUNDS_REQUIRED,
            level: state.level || "medium",
            honeypot: state.honeypot !== false
        });
    }
}

// ---- 验证方式/等级切换面板（私人模式，机主用 /level 打开）----
// 顶部二选一：🧩答题 quiz / 🌐网页 web（存 cfg:vmode）；
// quiz 方式下保留原三档难度按钮（存 cfg:level，逻辑不变）

const LEVEL_NAMES = { light: "🟢 简易拦截", medium: "🟡 中等拦截", strong: "🔴 强力拦截" };
const VMODE_NAMES = { quiz: "🧩 答题验证", web: "🌐 网页验证" };

function buildLevelKeyboard(mode, current) {
    const mark = (m) => (m === mode ? " ✅" : "");
    const rows = [
        [
            { text: `🧩 答题验证${mark("quiz")}`, callback_data: "vm:quiz" },
            { text: `🌐 网页验证${mark("web")}`, callback_data: "vm:web" }
        ]
    ];
    if (mode === "quiz") {
        const lm = (lv) => (lv === current ? " ✅" : "");
        rows.push([{ text: `🟢 简易拦截${lm("light")}`, callback_data: "lvl:light" }]);
        rows.push([{ text: `🟡 中等拦截${lm("medium")}`, callback_data: "lvl:medium" }]);
        rows.push([{ text: `🔴 强力拦截${lm("strong")}`, callback_data: "lvl:strong" }]);
    }
    return { inline_keyboard: rows };
}

function buildLevelPanelText(mode, current) {
    let text = `🛡️ <b>验证方式设置</b>\n${SEP}\n当前方式：<b>${VMODE_NAMES[mode]}</b>\n\n▸ 🧩 答题：访客答图片题过关\n▸ 🌐 网页：点按钮过真人验证，通过后观察期 48h，累计 2 分拉黑`;
    if (mode === "quiz") {
        text += `\n\n<b>答题难度</b>（当前：<b>${LEVEL_NAMES[current]}</b>）\n▸ 🟢 简易：1 轮答题｜观察期 24h，累计 8 分拉黑\n▸ 🟡 中等：2 轮答题（高风险 3 轮）+蜜罐｜观察期 24h，累计 5 分拉黑\n▸ 🔴 强力：3 轮答题+蜜罐（或网页真人验证）｜观察期 48h，累计 2 分拉黑`;
    }
    text += `\n\n<i>观察期：链接类消息会被拦，干净消息发满 2 条自动解除；观察期内累计风险分达到本档拉黑线（简易 8 / 中等 5 / 强力 2 分）直接拉黑，并推送通知由您决定解封 / 加白 / 保持黑名单\n点击下方按钮切换，只影响之后新发起的验证</i>`;
    return text;
}

// 机主私聊 /start、/help 时的功能清单（让机主知道全部功能与入口）
const OWNER_HELP_TEXT = [
    "👑 <b>主人功能清单</b>",
    SEP,
    "📋 <b>命令菜单</b>",
    "▸ 点输入框旁的「菜单」按钮（或输入 /）打开，全部功能都在里面",
    "",
    "🛡 <b>验证方式与难度</b> <code>/level</code>",
    "▸ 🧩答题（默认）：答图片题，分三档",
    "▸ 🟢简易：1 轮答题｜观察期 24h，累计 8 分拉黑",
    "▸ 🟡中等：2 轮答题（高风险 3 轮）+蜜罐｜观察期 24h，累计 5 分拉黑",
    "▸ 🔴强力：3 轮答题+蜜罐（或网页真人验证）｜观察期 48h，累计 2 分拉黑",
    "▸ 🌐网页验证：直接走 Cloudflare 真人验证，通过后观察期 48h，累计 2 分拉黑",
    "▸ 观察期：期间链接被拦，干净消息发满 2 条解除；累计风险分达到本档拉黑线直接拉黑，并推送通知由你决定解封 / 加白 / 保持黑名单",
    "",
    "🤖 <b>AI 辅助</b> <code>/ai</code>",
    "▸ 新用户通过验证后，AI 结合其头像 / 昵称 / 简介与首条发言识别广告号，疑似时提醒你是否拉黑",
    "▸ 自带 OpenAI 兼容接口地址与 Token：面板里设置 / 点选模型 / 测试连接",
    "▸ AI 只做辅助提醒，不参与验证、不会拦截消息，最终处置由你决定",
    "▸ 📝 总结模式（在 /ai 里开）：暂存当天转发消息 48 小时，发 <code>/zongjie</code> 让 AI 按人汇总今天谁联系了你、都说了什么事",
    "",
    "📢 <b>广告过滤</b> <code>/ad</code>",
    "▸ 🟢宽松 5 分拦 · 🟡标准 3 分拦（链接+广告词）· 🔴严格 2 分拦（单链接即拦），命中通知你处置",
    "▸ 计分：链接 +2 · t.me 额外 +2 · 广告词 +2/个（上限 +4）· 手机号 +2；白名单不计分",
    "▸ 计分会累计：观察期内按档位累计 8 / 5 / 2 分（简易 / 中等 / 强力）直接拉黑；观察期结束后以 30 天为一个计分周期，累计 20 分会提醒你决定是否拉黑",
    "",
    "📊 <b>数据统计</b> <code>/tongji</code>",
    "▸ 今日 + 累计联系人数 / 消息数（含白名单 / 黑名单 / 观察期人数）",
    "",
    "📋 <b>名单管理</b>",
    "▸ <code>/baimingdan</code> 白名单（可取消加白）",
    "▸ <code>/heimingdan</code> 黑名单（可解封）",
    "▸ <code>/guancha</code> 观察期（看剩余时间、进度与风险分，可解除观察期 / 拉黑）",
    "",
    "🔘 <b>转发消息头按钮</b>",
    "▸ 🚫屏蔽 · ⭐加白 · 🔓解封 · ℹ️状态 · 🧹清除验证",
    "▸ 清除验证：清掉对方的已验证状态，方便反复测试验证流程；清除后对方下次发消息需重新验证",
    "",
    "⚠️ <b>观察期拦截通知按钮</b>",
    "▸ 🚫拉黑 · 🔓解除隔离 · ⭐加白",
    "",
    "🚫 <b>广告拦截通知按钮</b>",
    "▸ ✅放行 · ⭐加白（并放行原消息）· 🚫拉黑",
    "",
    "🚫 <b>自动拉黑通知按钮</b>（观察期内累计风险分达到拉黑线时推送）",
    "▸ 🔓解封 · ⭐加白 · 保持黑名单（解封 / 加白都会清掉风险分）",
    "",
    "⚠️ <b>累计计分提醒按钮</b>（观察期结束后，30 天计分周期内累计 20 分时推送）",
    "▸ 🚫拉黑 · ⭐加白 · 暂不处理（拉黑 / 加白清掉风险分；暂不处理保留分数，本周期不再提醒）",
    "",
    "🤖 <b>AI 辅助提醒按钮</b>",
    "▸ 🚫拉黑 · ⭐加白 · ✔️忽略（AI 疑似广告时只发给你看，点按钮处置）",
    "",
    "↩️ <b>回信</b>",
    "▸ 直接回复任意一条转发的消息即可回信，对方看不到你的账号",
    "",
    "🔧 <b>回复转发消息 + 指令</b>",
    "▸ <code>/bai</code> 加白 · <code>/hei</code> 拉黑 · <code>/jiehei</code> 解封 · <code>/cd</code> 状态 · <code>/open</code> 开放 · <code>/close</code> 关闭 · <code>/reset</code> 重置验证",
    "▸ 裸发（不回复）：<code>/close</code> 全局暂停接收 · <code>/open</code> 全局恢复 · <code>/cleanup</code> 清理过期数据（已加白用户不受暂停影响）",
    "▸ <code>/fix</code> 自检修复：bot 没反应时发它，自动检查并重新绑定 webhook、重推菜单，再发一份报告",
    "",
    "<i>点下方按钮操作，或发 /help 查看全部功能</i>",
].join("\n");

// ---- 广告过滤切换面板（私人模式，机主用 /ad 打开）----

function buildAdKeyboard(current) {
    const mark = (lv) => (lv === current ? " ✅" : "");
    return {
        inline_keyboard: [
            [{ text: `🟢 宽松${mark("light")}`, callback_data: "adlvl:light" }],
            [{ text: `🟡 标准${mark("standard")}`, callback_data: "adlvl:standard" }],
            [{ text: `🔴 严格${mark("strict")}`, callback_data: "adlvl:strict" }]
        ]
    };
}

function buildAdPanelText(current) {
    return `📢 <b>广告过滤设置</b>\n${SEP}\n当前档位：<b>${AD_LEVEL_NAMES[current]}</b>\n\n▸ 🟢 宽松：评分 ≥5 才拦截（链接叠加关键词 / 手机号等强广告特征）\n▸ 🟡 标准：评分 ≥3 拦截（链接再叠加任一广告信号）\n▸ 🔴 严格：评分 ≥2 拦截（单独一个链接就拦）\n\n<b>评分信号</b>\n链接 +2 · t.me 额外 +2 · 广告关键词每个 +2（上限 +4）· 手机号 +2 · 转发自频道 / 群 +2 · @提及 +1 · 联系人名片 +1\n\n<i>加白（⭐）用户不受广告过滤影响；被拦消息会通知你，可一键放行 / 加白 / 拉黑。计分会累计：观察期内按档位累计 8 / 5 / 2 分（简易 / 中等 / 强力），达到拉黑线直接拉黑并通知你处理；观察期结束后以 30 天为一个计分周期，累计 20 分会提醒你决定是否拉黑</i>`;
}

// 广告过滤切换回调（adlvl:<level>）：仅机主本人可操作，写入 cfg:adlevel 并刷新面板
async function handleAdLevelCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const level = data.split(":")[1];
    if (level !== "light" && level !== "standard" && level !== "strict") {
        await answer("❌ 无效档位", true);
        return;
    }

    await env.TOPIC_MAP.put("cfg:adlevel", level);
    Logger.info('ad_level_changed', { ownerId: env.OWNER_ID, level });
    await answer(`已切换为 ${AD_LEVEL_NAMES[level]}`);

    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId) {
        await tgCall(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: buildAdPanelText(level),
            parse_mode: "HTML",
            reply_markup: buildAdKeyboard(level)
        });
    }
}

// 广告拦截通知按钮回调（adpass:/adtrust:<userId>:<原消息ID>、adban:<userId>）：仅机主本人可点
async function handleAdActionCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const parts = data.split(":");
    const action = parts[0];
    const targetId = Number(parts[1]);
    const origMsgId = Number(parts[2]);
    if (!targetId) {
        await answer("❌ 无效操作", true);
        return;
    }
    const ownerId = Number(env.OWNER_ID);
    let note = "";

    if (action === "adban") {
        await env.TOPIC_MAP.put(`banned:${targetId}`, "1");
        note = "🚫 已拉黑该访客";
    } else if (action === "adpass" || action === "adtrust") {
        if (action === "adtrust") {
            await env.TOPIC_MAP.put(`verified:${targetId}`, "trusted");
            await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
            // 加白即刻解除 probation，并清掉累计风险分
            await env.TOPIC_MAP.delete(`probation:${targetId}`);
            await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
            await clearRiskScore(env, targetId);
        }
        // 把被拦的原消息补转发给机主，并记录映射以便机主回复回信
        if (origMsgId) {
            const copyRes = await tgCall(env, "copyMessage", { chat_id: ownerId, from_chat_id: targetId, message_id: origMsgId });
            if (copyRes.ok) await putFwdMapping(env, copyRes.result?.message_id, targetId);
        }
        note = action === "adtrust" ? "⭐ 已加白并放行原消息" : "✅ 已放行原消息";
    } else {
        await answer("❌ 未知操作", true);
        return;
    }

    await answer(note);

    // 编辑拦截通知：标注处理结果并移除按钮
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId && query.message?.text) {
        await tgCall(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: `${query.message.text}\n\n—— ${note}`,
            reply_markup: { inline_keyboard: [] }
        });
    }
}

// 验证等级切换回调（lvl:<level>）：仅机主本人可操作，写入 cfg:level 并刷新面板
// 验证方式切换回调（vm:quiz|web）：仅机主本人可操作，写入 cfg:vmode 并刷新方式面板
async function handleVmCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const mode = data.split(":")[1];
    if (mode !== "quiz" && mode !== "web") {
        await answer("❌ 无效方式", true);
        return;
    }

    await env.TOPIC_MAP.put("cfg:vmode", mode);
    Logger.info('verify_mode_changed', { ownerId: env.OWNER_ID, mode });
    await answer(`验证方式已切换为 ${VMODE_NAMES[mode]}`);

    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId) {
        const level = await getVerifyLevel(env);
        await tgCall(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: buildLevelPanelText(mode, level),
            parse_mode: "HTML",
            reply_markup: buildLevelKeyboard(mode, level)
        });
    }
}

async function handleLevelCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    // 仅私人模式下有效，且点击者必须是机主本人
    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const level = data.split(":")[1];
    if (level !== "light" && level !== "medium" && level !== "strong") {
        await answer("❌ 无效等级", true);
        return;
    }

    await env.TOPIC_MAP.put("cfg:level", level);
    Logger.info('verify_level_changed', { ownerId: env.OWNER_ID, level });
    await answer(`已切换为 ${LEVEL_NAMES[level]}`);

    // 刷新面板：当前方式与难度文本、✅ 位置同步更新
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId) {
        const mode = await getVerifyMode(env);
        await tgCall(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: buildLevelPanelText(mode, level),
            parse_mode: "HTML",
            reply_markup: buildLevelKeyboard(mode, level)
        });
    }
}

// probation 拦截通知按钮回调（iso:<action>:<userId>）：机主一键拉黑/解除隔离/加白
async function handleIsoCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    // 仅私人模式下有效，且点击者必须是机主本人
    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const parts = data.split(":");
    const action = parts[1];
    const targetId = Number(parts[2]);
    if (!action || !targetId) {
        await answer("❌ 无效操作", true);
        return;
    }

    if (action === "ban") {
        await env.TOPIC_MAP.put(`banned:${targetId}`, "1");
        await env.TOPIC_MAP.delete(`probation:${targetId}`);
        await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
        await answer("🚫 已拉黑");
        return;
    }

    if (action === "release") {
        await env.TOPIC_MAP.delete(`probation:${targetId}`);
        await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
        await answer("🔓 已解除隔离");
        return;
    }

    if (action === "trust") {
        await env.TOPIC_MAP.put(`verified:${targetId}`, "trusted");
        await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
        await env.TOPIC_MAP.delete(`probation:${targetId}`);
        await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
        await clearRiskScore(env, targetId);
        await answer("⭐ 已加白");
        return;
    }

    await answer("❌ 未知操作", true);
}

// 累计风险分自动拉黑通知按钮回调（obs:<action>:<userId>）：机主决定解封/加白/保持黑名单。
// 解封/加白都会清掉风险分，避免解封后被旧分立刻再次拉黑；保持黑名单只标注不改状态。
// 处置后编辑原通知标注结果（与 aia:/ad 通知同口径）。
async function handleObsCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    // 仅私人模式下有效，且点击者必须是机主本人
    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const parts = data.split(":");
    const action = parts[1];
    const targetId = Number(parts[2]);
    if (!action || !targetId) {
        await answer("❌ 无效操作", true);
        return;
    }

    let note = "";
    if (action === "unban") {
        // 解封：删封禁与风险分；verified 标记拉黑时未动，恢复为已验证（不再回观察期）
        await env.TOPIC_MAP.delete(`banned:${targetId}`);
        await env.TOPIC_MAP.delete(`bannotice:${targetId}`);
        await clearRiskScore(env, targetId);
        note = "🔓 已解封（风险分已清零）";
    } else if (action === "trust") {
        await env.TOPIC_MAP.put(`verified:${targetId}`, "trusted");
        await env.TOPIC_MAP.delete(`banned:${targetId}`);
        await env.TOPIC_MAP.delete(`bannotice:${targetId}`);
        await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
        await env.TOPIC_MAP.delete(`probation:${targetId}`);
        await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
        await clearRiskScore(env, targetId);
        note = "⭐ 已加白（风险分已清零）";
    } else if (action === "keep") {
        note = "已保持黑名单";
    } else {
        await answer("❌ 未知操作", true);
        return;
    }

    await answer(note);

    // 编辑原通知：标注处理结果并移除按钮
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId && query.message?.text) {
        await tgCall(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: `${query.message.text}\n\n—— ${note}`,
            reply_markup: { inline_keyboard: [] }
        });
    }
}

// 累计计分提醒通知按钮回调（rsk:<action>:<userId>）：非观察期用户 30 天周期内累计达 20 分时推送，
// 机主决定拉黑/加白/暂不处理。拉黑/加白都会清掉风险分；暂不处理保留分数（提醒标记 r 已在
// 推送时写入，本周期不会再重复提醒）。处置后编辑原通知标注结果（与 obs:/aia: 同口径）。
async function handleRskCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    // 仅私人模式下有效，且点击者必须是机主本人
    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const parts = data.split(":");
    const action = parts[1];
    const targetId = Number(parts[2]);
    if (!action || !targetId) {
        await answer("❌ 无效操作", true);
        return;
    }

    let note = "";
    if (action === "ban") {
        await env.TOPIC_MAP.put(`banned:${targetId}`, "1");
        await clearRiskScore(env, targetId);
        note = "🚫 已拉黑（风险分已清零）";
    } else if (action === "trust") {
        await env.TOPIC_MAP.put(`verified:${targetId}`, "trusted");
        await env.TOPIC_MAP.delete(`banned:${targetId}`);
        await env.TOPIC_MAP.delete(`bannotice:${targetId}`);
        await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
        await env.TOPIC_MAP.delete(`probation:${targetId}`);
        await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
        await clearRiskScore(env, targetId);
        note = "⭐ 已加白（风险分已清零）";
    } else if (action === "ignore") {
        note = "暂不处理（分数保留，本周期不再提醒）";
    } else {
        await answer("❌ 未知操作", true);
        return;
    }

    await answer(note);

    // 编辑原通知：标注处理结果并移除按钮
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId && query.message?.text) {
        await tgCall(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: `${query.message.text}\n\n—— ${note}`,
            reply_markup: { inline_keyboard: [] }
        });
    }
}

// ---- 名单与观察期管理（私人模式机主：/baimingdan /heimingdan /guancha + lst: 回调）----
// 与管理端（api/manager.js）读写同一组键：verified:<uid>=="trusted" 为白名单、
// banned:<uid> 为黑名单、probation:<uid> + probation_count:<uid> 为观察期。

// 枚举某前缀下的用户 ID（逻辑键 <prefix><uid>），valueEquals 给定时只取 value 相等的，最多 limit 个
async function listMemberUids(env, prefix, limit = 10, valueEquals) {
    const keys = await getAllKeys(env, prefix);
    const uids = [];
    for (const k of keys) {
        const uid = k.name.slice(prefix.length);
        if (!/^\d+$/.test(uid)) continue; // 只认 <prefix><数字uid>（probation: 前缀天然不含 probation_count:）
        if (valueEquals !== undefined && (await env.TOPIC_MAP.get(k.name)) !== valueEquals) continue;
        uids.push(uid);
        if (uids.length >= limit) break;
    }
    return uids;
}

// 统计某前缀下的用户总数（同上过滤规则）
async function countMembers(env, prefix, valueEquals) {
    const keys = await getAllKeys(env, prefix);
    let n = 0;
    for (const k of keys) {
        const uid = k.name.slice(prefix.length);
        if (!/^\d+$/.test(uid)) continue;
        if (valueEquals !== undefined && (await env.TOPIC_MAP.get(k.name)) !== valueEquals) continue;
        n++;
    }
    return n;
}

// 三个名单的当前人数（/tongji 用）
async function memberCounts(env) {
    return {
        white: await countMembers(env, "verified:", "trusted"),
        black: await countMembers(env, "banned:"),
        prob: await countMembers(env, "probation:")
    };
}

// 用户展示信息：名字取 user:<uid>.title，@ 取 uinfo:<uid>.username；
// tag 是按钮上的用户标识：优先 @username，没有用昵称（截断 8 字），再没有用 ID 后 4 位，
// 名单多人时靠它区分每一行按钮属于谁，如「🚫拉黑 @WuY_X」
async function describeMember(env, uid) {
    const rec = await safeGetJSON(env, `user:${uid}`, null);
    const uinfo = await safeGetJSON(env, `uinfo:${uid}`, null);
    let tag;
    if (uinfo?.username) tag = `@${uinfo.username}`;
    else if ((rec?.title || "").trim()) tag = [...rec.title.trim()].slice(0, 8).join("");
    else tag = `ID…${String(uid).slice(-4)}`;
    return { name: rec?.title || "未知", uname: uinfo?.username ? `@${uinfo.username}` : "无", tag };
}

// 白名单视图（/baimingdan）：verified == "trusted" 的用户，每人一个「取消加白」
async function buildWhitelistView(env) {
    const uids = await listMemberUids(env, "verified:", 10, "trusted");
    const lines = [`⭐ <b>白名单</b>（共 <b>${uids.length}</b> 人）`, SEP];
    const keyboard = [];
    for (const uid of uids) {
        const { name, uname, tag } = await describeMember(env, uid);
        if (lines.length > 2) lines.push(SUBSEP);
        lines.push(`▸ <b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）`, `　 ID：<code>${uid}</code>`);
        keyboard.push([{ text: `取消加白 ${tag}`, callback_data: `lst:untrust:${uid}` }]);
    }
    if (!uids.length) lines.push("▸ 白名单是空的");
    return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

// 黑名单视图（/heimingdan）：banned: 下的用户，每人一个「🔓 解封」
async function buildBlacklistView(env) {
    const uids = await listMemberUids(env, "banned:", 10);
    const lines = [`🚫 <b>黑名单</b>（共 <b>${uids.length}</b> 人）`, SEP];
    const keyboard = [];
    for (const uid of uids) {
        const { name, uname, tag } = await describeMember(env, uid);
        if (lines.length > 2) lines.push(SUBSEP);
        lines.push(`▸ <b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）`, `　 ID：<code>${uid}</code>`);
        keyboard.push([{ text: `🔓解封 ${tag}`, callback_data: `lst:unban:${uid}` }]);
    }
    if (!uids.length) lines.push("▸ 黑名单是空的");
    return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

// 观察期视图（/guancha）：probation: 下的用户，显示剩余小时（向上取整）、已通过消息数/上限与累计风险分/拉黑线，
// 每人「🔓 解除观察期」+「🚫 拉黑」
async function buildProbationListView(env) {
    const uids = await listMemberUids(env, "probation:", 10);
    const lines = [`👀 <b>观察期用户</b>（共 <b>${uids.length}</b> 人）`, SEP];
    const keyboard = [];
    for (const uid of uids) {
        const meta = await getProbationMeta(env, uid);
        if (!meta) continue;
        const { name, uname, tag } = await describeMember(env, uid);
        const remain = Math.max(0, Math.ceil((meta.ts + meta.hours * 3600 * 1000 - Date.now()) / 3600000));
        const count = parseInt(await env.TOPIC_MAP.get(`probation_count:${uid}`) || "0") || 0;
        const risk = await getRiskScore(env, uid);
        if (lines.length > 2) lines.push(SUBSEP);
        lines.push(`▸ <b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）`, `　 ID：<code>${uid}</code>｜剩余约 <b>${remain}</b> 小时｜已通过 <b>${count}/${meta.limit}</b> 条｜风险分 <b>${risk}/${meta.ban}</b>`);
        keyboard.push([
            { text: `🔓解除观察期 ${tag}`, callback_data: `lst:release:${uid}` },
            { text: `🚫拉黑 ${tag}`, callback_data: `lst:ban:${uid}` }
        ]);
    }
    if (!uids.length) lines.push("当前没有观察期用户（观察期在验证通过后产生）");
    return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

// 名单视图按钮回调（lst:<action>:<userId>）：仅私人模式机主可点。
// 每个 action 只出现在一个视图里（unban→黑名单、untrust→白名单、release/ban→观察期），
// 处理完按 action 唯一对应的视图编辑原消息刷新。
async function handleListCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const parts = data.split(":");
    const action = parts[1];
    const targetId = Number(parts[2]);
    if (!action || !targetId) {
        await answer("❌ 无效操作", true);
        return;
    }

    let note = "";
    let view = null;
    if (action === "unban") {
        await env.TOPIC_MAP.delete(`banned:${targetId}`);
        await env.TOPIC_MAP.delete(`bannotice:${targetId}`);
        await clearRiskScore(env, targetId);
        note = "🔓 已解封";
        view = await buildBlacklistView(env);
    } else if (action === "untrust") {
        // 取消加白：永久信任降为普通已验证（与管理端 mgr:untrust 一致）
        if ((await env.TOPIC_MAP.get(`verified:${targetId}`)) === "trusted") {
            await env.TOPIC_MAP.put(`verified:${targetId}`, "1");
        }
        note = "已取消加白";
        view = await buildWhitelistView(env);
    } else if (action === "release") {
        await env.TOPIC_MAP.delete(`probation:${targetId}`);
        await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
        note = "🔓 已解除观察期";
        view = await buildProbationListView(env);
    } else if (action === "ban") {
        await env.TOPIC_MAP.put(`banned:${targetId}`, "1");
        await env.TOPIC_MAP.delete(`probation:${targetId}`);
        await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
        note = "🚫 已拉黑";
        view = await buildProbationListView(env);
    } else {
        await answer("❌ 未知操作", true);
        return;
    }

    await answer(note);
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId && view) {
        await tgCall(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: view.text,
            parse_mode: "HTML",
            reply_markup: view.reply_markup
        });
    }
}

// 机主信息头按钮回调：一键屏蔽/加白/解封/查看状态，语义与 handleOwnerCommand 的同名指令一致
async function handleOwnerCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    // 仅私人模式下有效，且点击者必须是机主本人
    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const parts = data.split(":");
    const action = parts[1];
    const targetId = Number(parts[2]);
    if (!action || !targetId) {
        await answer("❌ 无效操作", true);
        return;
    }

    if (action === "ban") {
        await env.TOPIC_MAP.put(`banned:${targetId}`, "1");
        await answer("🚫 已屏蔽");
        return;
    }

    if (action === "trust") {
        await env.TOPIC_MAP.put(`verified:${targetId}`, "trusted");
        await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
        // 被机主信任即刻解除 probation，并清掉累计风险分
        await env.TOPIC_MAP.delete(`probation:${targetId}`);
        await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
        await clearRiskScore(env, targetId);
        await answer("⭐ 已加白");
        return;
    }

    if (action === "unban") {
        await env.TOPIC_MAP.delete(`banned:${targetId}`);
        await env.TOPIC_MAP.delete(`bannotice:${targetId}`);
        await clearRiskScore(env, targetId);
        await answer("🔓 已解封");
        return;
    }

    if (action === "revoke") {
        // 清除验证：与 /reset 同一组删除，不通知对方；对方下次发消息重新走验证
        await clearUserVerification(env, targetId);
        await answer("🧹 已清除验证，对方下次发消息需重新验证");
        return;
    }

    if (action === "info") {
        // 内容与 /cd（/info）一致；弹窗不解析 Markdown，使用纯文本排版
        const userRec = await safeGetJSON(env, `user:${targetId}`, null);
        const verifyStatus = await env.TOPIC_MAP.get(`verified:${targetId}`);
        const banStatus = await env.TOPIC_MAP.get(`banned:${targetId}`);
        const pr = await userProbationRiskLines(env, targetId, verifyStatus);
        const info = `👤 用户信息\nUID: ${targetId}\n昵称: ${userRec?.title || "未知"}\n验证状态: ${verifyStatus ? (verifyStatus === 'trusted' ? '🌟 永久信任' : '✅ 已验证') : '❌ 未验证'}\n封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}\n${pr.probation}\n${pr.risk}`;
        await answer(info, true);
        return;
    }

    await answer("❌ 未知操作", true);
}

// 蜜罐按钮回调：点中即判定机器人 —— 作废挑战、失败 +2、提示异常操作（达标则进入冷却）
async function handleTrapCallback(query, env, data) {
    const parts = data.split(":");
    const challengeId = parts[1];
    const userId = query.from.id;

    const state = await safeGetJSON(env, `challenge:${userId}`, null);
    if (!state || state.id !== challengeId) {
        await tgCall(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: "❌ 验证已过期，请重发消息",
            show_alert: true
        });
        return;
    }

    Logger.warn('verification_honeypot_hit', { userId, challengeId, trapIndex: parts[2], type: state.type });
    await failChallengeAttempt(env, userId, query, state, "🚨 检测到异常操作，验证已作废", 2);
}

// ---- AI 辅助配置（私人模式，机主自带 OpenAI 兼容接口与 Token，存 cfg:ai）----
// 配置 JSON：{ enabled, base, key, model, summary, ua }；enabled =「辅助观察」开关，summary =「总结模式」开关，
// 两者互相独立；ua = 自定义客户端标识（User-Agent），空 = 不改默认；Token 只存本 bot 自己的 KV，面板与日志一律打码

// ---- 以下 AI 基础能力与管理端共用 lib/ai.js 的共享实现（以 KV 对象为参数）：配置读写 / chat 调用 /
// 模型列表 / 连接测试 / 失效标记。这里只保留 env 口径的薄封装，现有调用点签名不变 ----
async function getAiConfig(env) {
    return sharedGetAiConfig(env.TOPIC_MAP);
}

async function saveAiConfig(env, cfg) {
    return sharedSaveAiConfig(env.TOPIC_MAP, cfg);
}

async function callAiChat(env, cfg, messages, maxTokens = 120, opts = {}) {
    return sharedCallAiChat(cfg, messages, maxTokens, opts);
}

async function getAiBroken(env) {
    return sharedGetAiBroken(env.TOPIC_MAP);
}

async function fetchAiModels(env, cfg) {
    return sharedFetchAiModels(cfg);
}

// 测试连接：共享实现负责 ping 与失效标记清理；401/403 时走本端的 handleAiAuthFailure
// （带日志；notify: false——测试结果由调用方当场告知机主，不在此重复提醒）
async function aiTestConnection(env, cfg) {
    return sharedTestAiConnection(env.TOPIC_MAP, cfg, {
        onAuthFailure: (status) => handleAiAuthFailure(env, status, { notify: false })
    });
}

// AI 鉴权失败（401/403）统一处置：存储侧（记录失效标记 + 自动关闭 AI 两个开关）走共享 markAiAuthFailure；
// 本端负责记日志与提醒机主（24 小时最多一条，cfg:ai_alert_ts 节流）
async function handleAiAuthFailure(env, status, { notify = true } = {}) {
    await markAiAuthFailure(env.TOPIC_MAP, status);
    Logger.warn('ai_auth_failed_assist_disabled', { ownerId: env.OWNER_ID, status });
    if (notify) {
        const now = Date.now();
        const lastAlert = parseInt(await env.TOPIC_MAP.get("cfg:ai_alert_ts") || "0") || 0;
        if (now - lastAlert >= 24 * 3600 * 1000) {
            await env.TOPIC_MAP.put("cfg:ai_alert_ts", String(now));
            await tgCall(env, "sendMessage", {
                chat_id: Number(env.OWNER_ID),
                text: `⚠️ 您的 AI 已失效（接口返回 ${status}），辅助观察与总结模式暂停。更新 Token 后可在 /ai 重新开启。`
            });
        }
    }
}

function buildAiPanelText(cfg, broken = null) {
    const modelShown = cfg.model || `${CONFIG.AI_DEFAULT_MODEL}（默认）`;
    let text = `🤖 <b>AI 辅助设置</b>\n${SEP}\n辅助观察：<b>${cfg.enabled ? "🟢 已开启" : "⚪ 未开启"}</b>\n总结模式：<b>${cfg.summary ? "🟢 已开启" : "⚪ 未开启"}</b>\n`;
    if (broken) text += `🔴 Token 疑似失效（最近失败 ${fmtAiBrokenTime(broken.ts)}）\n`;
    text += `接口：${cfg.base ? `<code>${escapeHtml(cfg.base)}</code>` : "未设置"}\n模型：<code>${escapeHtml(modelShown)}</code>\nToken：${cfg.key ? `<code>${escapeHtml(maskAiKey(cfg.key))}</code>` : "未设置"}\n`;
    if (cfg.ua) text += `自定义 UA：<code>${escapeHtml(cfg.ua)}</code>\n`;
    text += `\n<i>辅助观察：新用户通过验证时，AI 结合其头像、昵称、简介与首条发言识别广告号，疑似时弹窗提醒你是否拉黑；只提醒、不拦截。\n总结模式：把当天收到的消息按人记录下来，发 /zongjie 或点下方按钮，AI 汇总今天谁联系了你、都说了什么事。\n自定义 UA：有些中转站的 Key 只认特定客户端（如 claude-cli），设了之后每次 AI 请求都会带上这个标识；不设则按默认发送。\n隐私：总结模式开启后会暂存访客消息文本 48 小时用于生成总结，关闭即不再记录。</i>`;
    return text;
}

// Token 恢复后的重新开启询问：机主点 ai:back:yes 重新开启 AI 辅助，ai:back:no 保持关闭
async function sendAiRestorePrompt(env) {
    await tgCall(env, "sendMessage", {
        chat_id: Number(env.OWNER_ID),
        text: "✅ <b>您的 AI Token 已恢复</b>\n\n是否重新开启 AI 辅助？",
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [[
                { text: "✅ 重新开启 AI 辅助", callback_data: "ai:back:yes" },
                { text: "保持关闭", callback_data: "ai:back:no" }
            ]]
        }
    });
}

function buildAiKeyboard(cfg) {
    return {
        inline_keyboard: [
            [{ text: cfg.enabled ? "⏯ 辅助观察（当前：开）" : "⏯ 辅助观察（当前：关）", callback_data: "ai:toggle" }],
            [{ text: cfg.summary ? "📝 总结模式（当前：开）" : "📝 总结模式（当前：关）", callback_data: "ai:sumtoggle" }],
            [{ text: "📋 生成今日总结", callback_data: "ai:sumgen" }],
            [
                { text: "🌐 设置接口", callback_data: "ai:set:base" },
                { text: "🔑 设置Token", callback_data: "ai:set:key" }
            ],
            [
                { text: "🤖 设置模型", callback_data: "ai:set:model" },
                { text: "📋 选择模型", callback_data: "ai:models" }
            ],
            [{ text: "🆔 设置自定义 UA", callback_data: "ai:set:ua" }],
            [{ text: "🧪 测试连接", callback_data: "ai:test" }]
        ]
    };
}

// 模型点选视图：最多列 12 个，点选即写入 cfg:ai.model；列表暂存 cfg:ai_models（短 TTL）
function buildAiModelsText(shown, total) {
    let text = `📋 <b>选择模型</b>\n${SEP}\n共获取到 <b>${total}</b> 个模型，点下方按钮即可设为当前模型：`;
    if (total > shown.length) text += `\n\n<i>仅列出前 ${shown.length} 个，其余模型可点「🤖 设置模型」手填</i>`;
    return text;
}

function buildAiModelsKeyboard(shown) {
    const rows = [];
    for (let i = 0; i < shown.length; i += 2) {
        const row = [{ text: shown[i].slice(0, 34), callback_data: `ai:model:${i}` }];
        if (shown[i + 1]) row.push({ text: shown[i + 1].slice(0, 34), callback_data: `ai:model:${i + 1}` });
        rows.push(row);
    }
    rows.push([{ text: "↩️ 返回设置", callback_data: "ai:back" }]);
    return { inline_keyboard: rows };
}

// 拉一次模型列表并把点选视图发给机主（Token 设置成功后自动调用，也供 ai:models 复用逻辑）
async function sendAiModelsPicker(env, cfg) {
    const ownerId = Number(env.OWNER_ID);
    const r = await fetchAiModels(env, cfg);
    if (!r.ok || !r.ids.length) {
        await tgCall(env, "sendMessage", {
            chat_id: ownerId,
            text: `❌ 自动获取模型失败：${escapeHtml(r.error || "未知错误")}\n可在 /ai 面板点「🤖 设置模型」手填模型名。`,
            parse_mode: "HTML"
        });
        return false;
    }
    const shown = r.ids.slice(0, 12);
    await env.TOPIC_MAP.put("cfg:ai_models", JSON.stringify(shown), { expirationTtl: CONFIG.AI_MODELS_TTL_SECONDS });
    await tgCall(env, "sendMessage", {
        chat_id: ownerId,
        text: buildAiModelsText(shown, r.ids.length),
        parse_mode: "HTML",
        reply_markup: buildAiModelsKeyboard(shown)
    });
    return true;
}

const AI_SET_PROMPTS = {
    base: "🌐 请直接发送接口地址（OpenAI 兼容基地址，如 https://api.openai.com/v1）。\n下一条消息即保存，发 /cancel 取消。",
    key: "🔑 请直接发送 API Token。\n保存后会自动删除您这条消息，发 /cancel 取消。",
    model: "🤖 请直接发送模型名（如 gpt-4o-mini）。\n下一条消息即保存，发 /cancel 取消。",
    ua: "🆔 请直接发送自定义 User-Agent（客户端标识），如 claude-cli/2.0.14 (external, cli)。\n之后每次 AI 请求都会带上这个标识；发送「清空」可清除。下一条消息即保存，发 /cancel 取消。"
};

// /ai 面板按钮回调（ai:toggle / ai:sumtoggle / ai:sumgen / ai:set:<field> / ai:test / ai:models / ai:model:<i> / ai:back）：仅机主本人
async function handleAiCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const ownerId = Number(env.OWNER_ID);
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const refreshPanel = async () => {
        if (!chatId || !messageId) return;
        const cfg = await getAiConfig(env);
        await tgCall(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: buildAiPanelText(cfg, await getAiBroken(env)),
            parse_mode: "HTML",
            reply_markup: buildAiKeyboard(cfg)
        });
    };

    const parts = data.split(":");
    const sub = parts[1];

    if (sub === "toggle") {
        const cfg = await getAiConfig(env);
        cfg.enabled = !cfg.enabled;
        await saveAiConfig(env, cfg);
        Logger.info('ai_assist_toggled', { ownerId: env.OWNER_ID, enabled: cfg.enabled });
        await answer(cfg.enabled ? "🟢 AI 辅助已开启" : "⚪ AI 辅助已关闭");
        await refreshPanel();
        return;
    }

    if (sub === "sumtoggle") {
        const cfg = await getAiConfig(env);
        cfg.summary = !cfg.summary;
        await saveAiConfig(env, cfg);
        Logger.info('ai_summary_toggled', { ownerId: env.OWNER_ID, summary: cfg.summary });
        await answer(cfg.summary ? "📝 总结模式已开启（将暂存转发消息 48 小时）" : "⚪ 总结模式已关闭（不再记录）");
        await refreshPanel();
        return;
    }

    if (sub === "sumgen") {
        await answer("📝 正在生成今日总结…");
        await generateTodaySummary(env);
        return;
    }

    if (sub === "set") {
        const field = parts[2];
        if (!AI_SET_PROMPTS[field]) {
            await answer("❌ 无效设置项", true);
            return;
        }
        await env.TOPIC_MAP.put("cfg:ai_input", field, { expirationTtl: CONFIG.AI_INPUT_TTL_SECONDS });
        await answer("请发送内容");
        await tgCall(env, "sendMessage", { chat_id: ownerId, text: AI_SET_PROMPTS[field] });
        return;
    }

    if (sub === "test") {
        await answer("🧪 正在测试连接…");
        const cfg = await getAiConfig(env);
        const hadBroken = await getAiBroken(env);
        const r = await aiTestConnection(env, cfg);
        if (r.ok && hadBroken) {
            // 失效后手动测试恢复：主动弹重新开启询问，不用机主自己再去翻开关
            await sendAiRestorePrompt(env);
            return;
        }
        await tgCall(env, "sendMessage", {
            chat_id: ownerId,
            text: r.ok
                ? `✅ <b>连接成功</b>\n模型 <code>${escapeHtml(cfg.model || CONFIG.AI_DEFAULT_MODEL)}</code> 可用。`
                : `❌ <b>测试失败</b>：${escapeHtml(r.error || "未知错误")}${r.authFailed ? "\nAI 已失效，辅助观察与总结模式暂停；更新 Token 后可重新开启。" : ""}`,
            parse_mode: "HTML"
        });
        return;
    }

    if (sub === "models") {
        const cfg = await getAiConfig(env);
        if (!cfg.base || !cfg.key) {
            await answer("⚠️ 请先设置接口与 Token", true);
            return;
        }
        await answer("📋 正在获取模型列表…");
        const r = await fetchAiModels(env, cfg);
        if (!r.ok || !r.ids.length) {
            await tgCall(env, "sendMessage", {
                chat_id: ownerId,
                text: `❌ <b>获取模型失败</b>：${escapeHtml(r.error || "未知错误")}\n可点「🤖 设置模型」手填模型名。`,
                parse_mode: "HTML"
            });
            return;
        }
        const shown = r.ids.slice(0, 12);
        await env.TOPIC_MAP.put("cfg:ai_models", JSON.stringify(shown), { expirationTtl: CONFIG.AI_MODELS_TTL_SECONDS });
        if (chatId && messageId) {
            await tgCall(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: buildAiModelsText(shown, r.ids.length),
                parse_mode: "HTML",
                reply_markup: buildAiModelsKeyboard(shown)
            });
        }
        return;
    }

    if (sub === "model") {
        const idx = parseInt(parts[2]);
        const list = await safeGetJSON(env, "cfg:ai_models", null);
        const model = Array.isArray(list) ? list[idx] : null;
        if (!model) {
            await answer("❌ 模型列表已过期，请重新点「📋 选择模型」", true);
            return;
        }
        const cfg = await getAiConfig(env);
        cfg.model = model;
        await saveAiConfig(env, cfg);
        Logger.info('ai_model_selected', { ownerId: env.OWNER_ID, model });
        await answer(`🤖 已选择模型 ${model}`);
        await refreshPanel();
        return;
    }

    if (sub === "back") {
        // Token 恢复询问的应答：ai:back:yes 重新开启 AI 辅助 / ai:back:no 保持关闭
        if (parts[2] === "yes") {
            const cfg = await getAiConfig(env);
            cfg.enabled = true;
            await saveAiConfig(env, cfg);
            Logger.info('ai_assist_restored', { ownerId: env.OWNER_ID });
            await answer("✅ AI 辅助已重新开启");
            if (chatId && messageId) {
                await tgCall(env, "editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: buildAiPanelText(cfg, await getAiBroken(env)),
                    parse_mode: "HTML",
                    reply_markup: buildAiKeyboard(cfg)
                });
            }
            return;
        }
        if (parts[2] === "no") {
            await answer("保持关闭");
            if (chatId && messageId && query.message?.text) {
                await tgCall(env, "editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: `${query.message.text}\n\n—— 已选择保持关闭，可随时在 /ai 重新开启`,
                    reply_markup: { inline_keyboard: [] }
                });
            }
            return;
        }
        // 无参数的 ai:back 是模型列表的「返回设置」
        await answer();
        await refreshPanel();
        return;
    }

    await answer("❌ 未知操作", true);
}

// /ai 输入等待态的值处理：机主普通消息存入对应字段；Token 存后删原消息并自动拉模型列表
async function handleAiInputValue(msg, env, field) {
    const ownerId = Number(env.OWNER_ID);
    await env.TOPIC_MAP.delete("cfg:ai_input");
    const value = (msg.text || "").trim();
    const cfg = await getAiConfig(env);

    if (field === "base") {
        cfg.base = value.replace(/\/+$/, "");
        await saveAiConfig(env, cfg);
        Logger.info('ai_base_saved', { ownerId: env.OWNER_ID });
        await tgCall(env, "sendMessage", {
            chat_id: ownerId,
            text: buildAiPanelText(cfg, await getAiBroken(env)),
            parse_mode: "HTML",
            reply_markup: buildAiKeyboard(cfg)
        });
        return;
    }

    if (field === "model") {
        cfg.model = value;
        await saveAiConfig(env, cfg);
        Logger.info('ai_model_saved', { ownerId: env.OWNER_ID, model: value });
        await tgCall(env, "sendMessage", {
            chat_id: ownerId,
            text: buildAiPanelText(cfg, await getAiBroken(env)),
            parse_mode: "HTML",
            reply_markup: buildAiKeyboard(cfg)
        });
        return;
    }

    if (field === "ua") {
        const cleared = ["清空", "清除", "clear", "-"].includes(value.toLowerCase());
        cfg.ua = cleared ? "" : value.slice(0, 200);
        await saveAiConfig(env, cfg);
        Logger.info('ai_ua_saved', { ownerId: env.OWNER_ID, cleared });
        await tgCall(env, "sendMessage", {
            chat_id: ownerId,
            text: cleared ? "🆔 自定义 UA 已清除。" : buildAiPanelText(cfg, await getAiBroken(env)),
            parse_mode: "HTML",
            ...(cleared ? {} : { reply_markup: buildAiKeyboard(cfg) })
        });
        return;
    }

    if (field === "key") {
        cfg.key = value;
        await saveAiConfig(env, cfg);
        Logger.info('ai_key_saved', { ownerId: env.OWNER_ID });
        // 删除机主那条含 Token 的消息，降低泄露面（失败不影响保存结果）
        try {
            await tgCall(env, "deleteMessage", { chat_id: ownerId, message_id: msg.message_id });
        } catch { /* 删除失败不影响主流程 */ }
        await tgCall(env, "sendMessage", {
            chat_id: ownerId,
            text: "🔑 Token 已保存，您刚才发送 Token 的消息已删除。"
        });
        // 此前 Token 失效、AI 辅助被自动关闭（cfg:ai_broken 存在）：自动测一次新 Token，
        // 通过则弹重新开启询问；仍失败则提示不可用、不弹询问
        const hadBroken = await getAiBroken(env);
        if (hadBroken) {
            const r = await aiTestConnection(env, cfg);
            if (r.ok) {
                await sendAiRestorePrompt(env);
            } else {
                await tgCall(env, "sendMessage", {
                    chat_id: ownerId,
                    text: `⚠️ 新 Token 测试仍未通过：${escapeHtml(r.error || "未知错误")}，暂不重新开启 AI 辅助。`,
                    parse_mode: "HTML"
                });
            }
            return;
        }
        // 自动拉一次模型列表供点选（失败时内部会提示手填兜底）
        await sendAiModelsPicker(env, cfg);
        return;
    }
}

// ---- AI 总结模式（cfg:ai.summary，与辅助观察独立，默认关）----
// 平台默认不存聊天内容；只有机主打开总结开关后，才把【已成功转发】的消息按人暂存到
// sum:<上海日期>:<uid>（JSON 数组 {ts, text}，键 TTL 48 小时），供 /zongjie 生成今日汇总。
// 被封禁/未过验证/被广告或观察期拦截的消息不会走到转发，也就不会被记录。

// 记录用的单条文本：文本/说明文字截断 300 字，非文本记类型占位
function buildSummaryEntryText(msg) {
    const text = (msg.text || msg.caption || "").trim();
    if (text) return text.slice(0, CONFIG.AI_SUMMARY_TEXT_MAX);
    if (msg.photo) return "[图片]";
    if (msg.video) return "[视频]";
    if (msg.document) return "[文件]";
    if (msg.voice) return "[语音]";
    if (msg.audio) return "[音频]";
    if (msg.sticker) return "[贴纸]";
    if (msg.video_note) return "[视频消息]";
    if (msg.animation) return "[动图]";
    if (msg.contact) return "[联系人名片]";
    if (msg.location) return "[位置]";
    return "[其他消息]";
}

// 转发成功后调用：开关开着才记，每人每天最多 50 条（超出丢最旧）；全程轻量，失败不影响转发
async function recordSummaryMessage(env, msg, userId) {
    try {
        const cfg = await getAiConfig(env);
        if (!cfg.summary) return;
        const key = `sum:${shanghaiDateStr()}:${userId}`;
        const list = await safeGetJSON(env, key, null);
        const arr = Array.isArray(list) ? list : [];
        arr.push({ ts: Date.now(), text: buildSummaryEntryText(msg) });
        while (arr.length > CONFIG.AI_SUMMARY_MAX_PER_USER) arr.shift();
        await env.TOPIC_MAP.put(key, JSON.stringify(arr), { expirationTtl: CONFIG.AI_SUMMARY_TTL_SECONDS });
    } catch (e) {
        Logger.error('record_summary_message_failed', e, { userId });
    }
}

// AI_SUMMARY_SYSTEM_PROMPT 已抽到 lib/ai.js（与管理端共用，顶部已 import）

// 收集当天全部 sum:<date>:* 记录，按用户聚合成材料文本；总量超上限时按人截断并注明
// 收集当天全部 sum:<date>:* 记录，按用户聚合后交给共享 assembleSummaryMaterial 拼成材料文本
async function collectTodaySummaryMaterial(env) {
    const day = shanghaiDateStr();
    const prefix = `sum:${day}:`;
    const keys = await getAllKeys(env, prefix);
    const perUser = [];
    for (const { name } of keys) {
        const uid = name.slice(prefix.length);
        if (!/^\d+$/.test(uid)) continue;
        const list = await safeGetJSON(env, name, null);
        if (!Array.isArray(list) || !list.length) continue;
        const { name: displayName, uname } = await describeMember(env, uid);
        perUser.push({ uid, name: displayName, uname, items: list });
    }
    const { userCount, msgCount, material } = assembleSummaryMaterial(perUser);
    return { day, userCount, msgCount, material };
}

// 生成今日总结并以 HTML 发回机主私聊（/zongjie 命令与 /ai 面板「生成今日总结」按钮共用）
// 未配置/无记录直接提示；401/403 走统一失效处置；超时/5xx 只提示重试、不置失效标记
async function generateTodaySummary(env) {
    const ownerId = Number(env.OWNER_ID);
    const send = (text) => tgCall(env, "sendMessage", { chat_id: ownerId, text, parse_mode: "HTML" });
    const cfg = await getAiConfig(env);
    if (!cfg.base || !cfg.key) {
        await send("⚠️ AI 接口或 Token 还没配置，请先在 /ai 面板设置接口与 Token 后再生成总结。");
        return;
    }
    const { day, userCount, msgCount, material } = await collectTodaySummaryMaterial(env);
    if (!userCount) {
        await send("今天还没有已记录的消息（总结模式开启后转发的消息才会被记录）。");
        return;
    }
    await send(`📝 正在生成今日总结（共 ${userCount} 人、${msgCount} 条记录），请稍候…`);
    const r = await callAiChat(env, cfg, [
        { role: "system", content: AI_SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: `以下是今天（${day}）收到的访客消息记录，请按要求汇总：\n\n${material}` }
    ], 1500, { temperature: 0.3 });
    if (!r.ok) {
        if (r.status === 401 || r.status === 403) {
            await handleAiAuthFailure(env, r.status);
            await send(`❌ AI 已失效（接口返回 ${r.status}），辅助观察与总结模式暂停，请在 /ai 更新 Token 后重新开启。`);
            return;
        }
        if (r.error === "请求超时" || (typeof r.status === "number" && r.status >= 500)) {
            await send("❌ AI 响应超时，稍后再试。");
            return;
        }
        await send(`❌ 生成总结失败：${escapeHtml(r.error || "未知错误")}`);
        return;
    }
    const content = r.data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
        await send("❌ AI 未返回总结内容，请稍后再试。");
        return;
    }
    // 调用成功说明 Token 可用：顺带清掉可能残留的失效标记（与测试连接口径一致）
    await env.TOPIC_MAP.delete("cfg:ai_broken");
    const chunks = chunkSummaryText(content, 3000);
    for (let i = 0; i < chunks.length; i++) {
        const head = i === 0 ? `📋 <b>今日消息总结</b>（${day}）\n${SEP}\n` : "";
        await send(head + escapeHtml(chunks[i]));
    }
}

// ---- AI 辅助分析（新用户通过验证后，后台异步跑一次，只提醒机主、不拦截任何消息）----
// 触发点：forwardToOwner 成功转发某访客的消息后调 maybeTriggerAiAssist（每个用户只分析一次，
// aiassist:<uid> 标记防重复/防并发）；分析在 ctx.waitUntil 里后台执行，绝不阻塞转发本身。

const AI_ASSIST_SYSTEM_PROMPT = "你是一名广告账号识别助手。你的任务是识别广告/引流/诈骗账号：结合来访者的昵称、用户名、简介、头像情况与首条发言，判断其是否为广告号。广告号常见特征：昵称或简介含招商、代理、兼职、刷单、博彩、币圈、引流话术；头像为美女图、二维码、产品图或营销图；首条发言即推广、拉群或引流。判断必须保守：宁可放过，不可误伤正常用户；资料与发言正常的一律判 normal。只输出 JSON {\"verdict\":\"ad\"|\"normal\",\"reason\":\"一句话\"}，不要输出其他任何内容。";

// 下载 Telegram 文件并转 base64 data URI（头像视觉判断用）；任何一步失败返回 null，调用方降级纯文本分析
async function downloadTelegramFileAsDataUri(env, fileId) {
    try {
        const fileRes = await tgCall(env, "getFile", { file_id: fileId });
        const filePath = fileRes && fileRes.ok ? fileRes.result?.file_path : null;
        if (!filePath) return null;
        // 文件下载同样套用 API 超时（10s）：挂起时 abort，走下方 catch 降级返回 null
        const dlController = new AbortController();
        const dlTimer = setTimeout(() => dlController.abort(), CONFIG.API_TIMEOUT_MS);
        let resp;
        try {
            resp = await fetch(`${tgApiBase(env)}/file/bot${env.BOT_TOKEN}/${filePath}`, { signal: dlController.signal });
        } finally {
            clearTimeout(dlTimer);
        }
        if (!resp.ok) return null;
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
        }
        const mime = /\.png$/i.test(filePath) ? "image/png" : "image/jpeg";
        return `data:${mime};base64,${btoa(bin)}`;
    } catch {
        return null;
    }
}

// 触发 AI 辅助分析：同步部分只做开关/配置/标记检查（毫秒级，转发已在此前完成），
// 真正的分析交给 ctx.waitUntil 后台执行。每个用户只分析一次：
// aiassist:<uid> = { state: pending|done|failed }，pending/done/failed 任一存在都不会重复触发，
// failed 标记 1 小时过期后，下一次转发可再重试一次。
async function maybeTriggerAiAssist(env, ctx, msg, userId) {
    try {
        if (!isOwnerMode(env)) return;
        const cfg = await getAiConfig(env);
        if (!cfg.enabled || !cfg.base || !cfg.key) return;
        const existing = await env.TOPIC_MAP.get(`aiassist:${userId}`);
        if (existing) return;
        // 机主已手动加白（trusted）的用户不再分析，避免对已信任的人发疑似广告提醒
        if ((await env.TOPIC_MAP.get(`verified:${userId}`)) === "trusted") {
            await env.TOPIC_MAP.put(`aiassist:${userId}`, JSON.stringify({ state: "done", ts: Date.now(), skipped: "trusted" }), { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
            return;
        }
        await env.TOPIC_MAP.put(`aiassist:${userId}`, JSON.stringify({ state: "pending", ts: Date.now() }), { expirationTtl: CONFIG.AI_ASSIST_PENDING_TTL_SECONDS });
        const task = runAiAssistAnalysis(env, cfg, msg, userId)
            .catch((e) => Logger.error('ai_assist_analysis_crashed', e, { userId }));
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
        else await task;
    } catch (e) {
        Logger.error('ai_assist_trigger_failed', e, { userId });
    }
}

// AI 辅助分析主体（后台执行）：收集资料（getChat 简介 + 头像照片）→ 调模型判定 →
// 判 ad 才通知机主处置；判 normal 只记完成；失败静默（401/403 例外：走失效处置）
async function runAiAssistAnalysis(env, cfg, msg, userId) {
    const markDone = async (extra = {}) => {
        await env.TOPIC_MAP.put(`aiassist:${userId}`, JSON.stringify({ state: "done", ts: Date.now(), ...extra }), { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
    };
    const markFailed = async () => {
        await env.TOPIC_MAP.put(`aiassist:${userId}`, JSON.stringify({ state: "failed", ts: Date.now() }), { expirationTtl: CONFIG.AI_ASSIST_RETRY_TTL_SECONDS });
    };

    const from = msg.from || {};
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || "未知";
    const uname = from.username ? `@${from.username}` : "无";

    // 简介 bio：getChat(访客私聊) 的 bio 字段，取不到留空
    let bio = "";
    try {
        const chatRes = await tgCall(env, "getChat", { chat_id: userId });
        if (chatRes && chatRes.ok) bio = String(chatRes.result?.bio || "");
    } catch { /* 取不到留空 */ }

    // 头像：getUserProfilePhotos 取第一张的最小尺寸下载为 data URI 供视觉判断；失败则只有「有/无」
    let photoDesc = "无头像";
    let photoDataUri = null;
    try {
        const photosRes = await tgCall(env, "getUserProfilePhotos", { user_id: userId, limit: 1 });
        const photos = photosRes && photosRes.ok ? photosRes.result?.photos : null;
        if (Array.isArray(photos) && photos.length && Array.isArray(photos[0]) && photos[0].length) {
            photoDesc = "有头像";
            photoDataUri = await downloadTelegramFileAsDataUri(env, photos[0][0].file_id);
            if (photoDataUri) photoDesc = "有头像（头像图片附在本消息中，请结合图片内容判断）";
        }
    } catch { /* 头像取不到按无头像处理 */ }

    const firstText = msg.text || msg.caption || "";
    const firstDesc = firstText
        ? firstText.slice(0, 500)
        : (msg.message_id && !msg.text && !msg.photo && !msg.video && !msg.document && !msg.sticker && !msg.voice && !msg.contact && !msg.animation && !msg.video_note
            ? "（验证期间发送的消息，已正常转发，内容不可见）"
            : `（非文本消息：${buildAdPreview(msg)}）`);
    const profile = [
        `昵称：${name}`,
        `用户名：${from.username ? `@${from.username}` : "（无用户名）"}`,
        `Premium：${from.is_premium ? "是" : "否"}`,
        `用户ID：${userId}`,
        `简介：${bio ? bio.slice(0, 300) : "（无简介）"}`,
        `头像：${photoDesc}`,
        `首条发言：${firstDesc}`
    ].join("\n");

    const buildMessages = (photo) => [{
        role: "system", content: AI_ASSIST_SYSTEM_PROMPT
    }, {
        role: "user",
        content: photo
            ? [{ type: "text", text: profile }, { type: "image_url", image_url: { url: photo } }]
            : profile
    }];

    // 先带图调一次；带图请求报错（多为模型不支持图片）则去掉图片纯文本重试一次；再失败静默放弃
    let r = await callAiChat(env, cfg, buildMessages(photoDataUri), 120);
    if (!r.ok && photoDataUri) {
        r = await callAiChat(env, cfg, buildMessages(null), 120);
    }
    if (!r.ok) {
        // 鉴权失败（401/403）：Token 疑似失效，统一处置（标记 + 自动关闭辅助 + 节流提醒）
        if (r.status === 401 || r.status === 403) {
            await handleAiAuthFailure(env, r.status, { notify: true });
            await markDone({ skipped: "auth_failed" });
        } else {
            // 超时/5xx/网络错误：静默跳过本次分析，1 小时后有新消息转发时可重试
            Logger.warn('ai_assist_call_failed', { userId, error: r.error });
            await markFailed();
        }
        return;
    }

    // 解析判定（容忍代码块包裹与前后杂字）；解析不出按失败处理，不打扰任何人
    const content = r.data?.choices?.[0]?.message?.content || "";
    const cleaned = String(content).replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    let verdict = null;
    let reason = "";
    if (start >= 0 && end > start) {
        try {
            const obj = JSON.parse(cleaned.slice(start, end + 1));
            if (obj && (obj.verdict === "ad" || obj.verdict === "normal")) {
                verdict = obj.verdict;
                reason = String(obj.reason || "").slice(0, 100);
            }
        } catch { /* 解析失败走下面失败分支 */ }
    }
    if (!verdict) {
        Logger.warn('ai_assist_parse_failed', { userId });
        await markFailed();
        return;
    }

    await markDone({ verdict });
    if (verdict === "normal") {
        Logger.info('ai_assist_normal', { userId });
        return;
    }

    // 判 ad 才打扰机主：发提醒 + [拉黑/加白/忽略] 按钮，处置由机主决定（回调 aia:）
    Logger.info('ai_assist_ad_suspected', { userId });
    await tgCall(env, "sendMessage", {
        chat_id: Number(env.OWNER_ID),
        text: `🤖 <b>AI 辅助提醒</b>\n${SEP}\n新用户：<b>${escapeHtml(name)}</b>（${escapeHtml(uname)}）\nID：<code>${userId}</code>\n⚠️ 疑似广告号\n理由：${escapeHtml(reason || "—")}\n\n<i>该用户已通过验证、消息已正常转发；AI 仅供参考，是否处置由你决定</i>`,
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [[
                { text: "🚫 拉黑", callback_data: `aia:ban:${userId}` },
                { text: "⭐ 加白", callback_data: `aia:trust:${userId}` },
                { text: "✔️ 忽略", callback_data: `aia:ignore:${userId}` }
            ]]
        }
    });
}

// AI 辅助提醒按钮回调（aia:ban/trust/ignore:<userId>）：仅机主本人可点，处置后编辑提醒消息标注结果
async function handleAiAssistCallback(query, env, data) {
    const answer = (text, showAlert = false) => tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text,
        ...(showAlert ? { show_alert: true } : {})
    });

    if (!isOwnerMode(env) || String(query.from.id) !== String(env.OWNER_ID)) {
        await answer("⛔ 无权限", true);
        return;
    }

    const parts = data.split(":");
    const action = parts[1];
    const targetId = Number(parts[2]);
    if (!targetId) {
        await answer("❌ 无效操作", true);
        return;
    }
    let note = "";

    if (action === "ban") {
        // 拉黑复用现有封禁逻辑（banned:<uid>，与信息头屏蔽/广告拉黑同一键）
        await env.TOPIC_MAP.put(`banned:${targetId}`, "1");
        note = "🚫 已拉黑该用户";
    } else if (action === "trust") {
        await env.TOPIC_MAP.put(`verified:${targetId}`, "trusted");
        await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
        await env.TOPIC_MAP.delete(`probation:${targetId}`);
        await env.TOPIC_MAP.delete(`probation_count:${targetId}`);
        await clearRiskScore(env, targetId);
        note = "⭐ 已加白该用户";
    } else if (action === "ignore") {
        note = "✔️ 已忽略本次提醒";
    } else {
        await answer("❌ 未知操作", true);
        return;
    }

    await answer(note);

    // 编辑提醒消息：标注处理结果并移除按钮
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId && query.message?.text) {
        await tgCall(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: `${query.message.text}\n\n—— ${note}`,
            reply_markup: { inline_keyboard: [] }
        });
    }
}

async function handleCallbackQuery(query, env, ctx) {
    try {
        const data = query.data;
        // probation 拦截通知按钮（私人模式机主）
        if (data && data.startsWith("iso:")) {
            await handleIsoCallback(query, env, data);
            return;
        }
        // 累计风险分自动拉黑通知按钮：解封/加白/保持黑名单（私人模式机主）
        if (data && data.startsWith("obs:")) {
            await handleObsCallback(query, env, data);
            return;
        }
        // 累计计分提醒通知按钮：拉黑/加白/暂不处理（私人模式机主）
        if (data && data.startsWith("rsk:")) {
            await handleRskCallback(query, env, data);
            return;
        }
        // 广告过滤档位切换面板（私人模式机主）
        if (data && data.startsWith("adlvl:")) {
            await handleAdLevelCallback(query, env, data);
            return;
        }
        // 广告拦截通知按钮：放行/加白/拉黑（私人模式机主）
        if (data && (data.startsWith("adpass:") || data.startsWith("adtrust:") || data.startsWith("adban:"))) {
            await handleAdActionCallback(query, env, data);
            return;
        }
        // 验证方式切换面板（私人模式机主）
        if (data && data.startsWith("vm:")) {
            await handleVmCallback(query, env, data);
            return;
        }
        // AI 配置面板（私人模式机主）
        if (data && data.startsWith("ai:")) {
            await handleAiCallback(query, env, data);
            return;
        }
        // AI 辅助提醒按钮：拉黑/加白/忽略（私人模式机主）
        if (data && data.startsWith("aia:")) {
            await handleAiAssistCallback(query, env, data);
            return;
        }
        // 验证等级切换面板（私人模式机主）
        if (data && data.startsWith("lvl:")) {
            await handleLevelCallback(query, env, data);
            return;
        }
        // 机主一键管理按钮（私人模式信息头）
        if (data && data.startsWith("own:")) {
            await handleOwnerCallback(query, env, data);
            return;
        }
        // 名单管理视图按钮（私人模式机主：解封/取消加白/解除观察期/拉黑）
        if (data && data.startsWith("lst:")) {
            await handleListCallback(query, env, data);
            return;
        }
        // 蜜罐按钮：点中判定机器人
        if (data && data.startsWith("trap:")) {
            await handleTrapCallback(query, env, data);
            return;
        }
        // Turnstile 提示上的「改用答题验证」
        if (data && data.startsWith("tsquiz:")) {
            await handleTurnstileFallback(query, env, data);
            return;
        }
        if (!data.startsWith("verify:")) return;

        const parts = data.split(":");
        if (parts.length !== 3) return;

        const challengeId = parts[1];
        const selectedIndex = parseInt(parts[2]);  // 用户选择的索引
        const userId = query.from.id;
        const messageId = query.message?.message_id;

        // 挑战状态按用户存储（challenge:<userId>），挑战 ID 不匹配说明已作废/已换新题
        const state = await safeGetJSON(env, `challenge:${userId}`, null);
        if (!state || state.id !== challengeId) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 验证已过期，请重发消息",
                show_alert: true
            });
            return;
        }

        // 验证索引有效性
        if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= state.options.length) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 无效选项",
                show_alert: true
            });
            return;
        }

        const now = Date.now();
        const elapsed = now - (state.issuedAt || 0);

        // 挑战过期（KV TTL 之外的双保险）
        if (elapsed > CONFIG.CHALLENGE_TTL_SECONDS * 1000) {
            await clearChallengeState(env, userId);
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 验证已过期，请重发消息",
                show_alert: true
            });
            if (messageId) {
                await editChallengeNotice(env, userId, messageId, state.media, "⌛ <b>验证已过期</b>\n\n请重新发送任意消息获取新的验证。");
            }
            return;
        }

        // 答题过快：真人不可能在 1 秒内看清题目并点击，视为机器人行为，作废并累计失败
        if (elapsed < CONFIG.CHALLENGE_MIN_ANSWER_MS) {
            Logger.warn('verification_too_fast', { userId, challengeId, elapsed });
            await failChallengeAttempt(env, userId, query, state, "⚠️ 操作过快，验证已作废");
            return;
        }

        // 答错：累计失败，未冷却则作废重发（轮次从 1 重来）
        if (selectedIndex !== state.answerIndex) {
            Logger.info('verification_failed', {
                userId,
                challengeId,
                selectedIndex,
                correctIndex: state.answerIndex,
                round: state.round,
                type: state.type
            });
            await failChallengeAttempt(env, userId, query, state, "❌ 答案错误");
            return;
        }

        // 本轮答对但未满轮次：编辑同一条消息进入下一轮（题型与之前不同）
        if (state.round < state.totalRounds) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: `✅ 第 ${state.round} 轮通过，还剩 ${state.totalRounds - state.round} 轮`
            });

            // 最后一轮（第 3 轮）强制使用顺序记忆题：medium 高风险用户与 strong 全体用户
            const nextRound = state.round + 1;
            const forceSequence = nextRound === 3 && ((state.riskScore || 0) >= CONFIG.HIGH_RISK_SCORE || state.level === "strong");
            const next = forceSequence
                ? CHALLENGE_GENERATORS.sequence()
                : generateChallenge(state.usedTypes || []);
            const nextState = {
                ...state,
                round: nextRound,
                type: next.type,
                answerIndex: next.answerIndex,
                options: next.options,
                columns: next.columns,
                trapText: next.trapText || null,
                usedTypes: [...(state.usedTypes || []), next.type],
                issuedAt: Date.now()
            };
            await env.TOPIC_MAP.put(`challenge:${userId}`, JSON.stringify(nextState), { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });
            await env.TOPIC_MAP.put(`user_challenge:${userId}`, nextState.id, { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });

            Logger.info('verification_round_passed', { userId, challengeId, round: state.round, nextType: next.type });

            // 呈现下一轮：与上一条同形态时编辑原消息（图片题换图走 editMessageMedia），
            // 形态不同或编辑失败时删旧发新；图片失败自动回退文本题并同步状态
            const presented = await presentChallenge(env, userId, nextState, next, {
                prevMessageId: messageId || state.messageId || null,
                prevMedia: state.media || "text",
                fullFooter: false
            });
            if (presented.challenge !== next) {
                syncStateWithChallenge(nextState, presented.challenge);
                nextState.usedTypes = [...(state.usedTypes || []), presented.challenge.type];
                Logger.warn('challenge_image_fallback', { userId, challengeId, fallbackType: presented.challenge.type });
            }
            nextState.media = presented.media;
            if (presented.messageId) nextState.messageId = presented.messageId;
            await env.TOPIC_MAP.put(`challenge:${userId}`, JSON.stringify(nextState), { expirationTtl: CONFIG.CHALLENGE_TTL_SECONDS });
            return;
        }

        // 全部轮次通过
        await tgCall(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: "✅ 验证通过"
        });

        Logger.info('verification_passed', {
            userId,
            challengeId,
            rounds: state.totalRounds
        });

        // 30天有效期 - 使用配置常量
        await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
        await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        await env.TOPIC_MAP.delete(`verify_fails:${userId}`);
        await clearChallengeState(env, userId);

        // 第二层防护：通过验证后进入 probation（新用户保护期，拦截链接消息）
        // 按通过时的等级快照参数（hours/limit/ban 一并存入，三档都进观察期：简易 24h/8 分、中等 24h/5 分、强力 48h/2 分）
        const passLevel = state.level || "medium";
        const pParams = levelProbationParams(passLevel);
        if (pParams.hours > 0) {
            await env.TOPIC_MAP.put(`probation:${userId}`, JSON.stringify({
                ts: Date.now(),
                hours: pParams.hours,
                limit: pParams.limit,
                ban: pParams.ban
            }), { expirationTtl: pParams.hours * 3600 });
        } else {
            await env.TOPIC_MAP.delete(`probation:${userId}`);
        }
        await env.TOPIC_MAP.delete(`probation_count:${userId}`);

        if (messageId) {
            await editChallengeNotice(env, userId, messageId, state.media, "✅ <b>验证成功</b>\n\n您现在可以自由对话了。");
        }

        // 给访客本人发规则提醒（与网页验证通过提示同口径）：观察期时长、计分与拉黑线、两种解除方式、解除后月度计分；
        // 数字取本档快照参数（hours/ban），无观察期（hours<=0）则不发；发送失败不影响验证通过与后续转发主流程
        if (pParams.hours > 0) {
            try {
                await tgCall(env, "sendMessage", {
                    chat_id: userId,
                    text: `✅ 验证通过！\n\n⚠️ 温馨提示：\n您正处于 ${pParams.hours} 小时观察期，期间系统会按行为计分：发送链接、广告词、手机号等都会加分，累计 ${pParams.ban} 分将被直接拉黑。\n解除观察期有两种方式：① 等满 ${pParams.hours} 小时且期间未达到拉黑分数；② 您发送的前两条消息都是正常干净的消息，即可提前解除。\n解除观察期后仍实行月度计分：以 30 天为一个周期累计计分，累计 20 分机主将收到提醒并决定是否拉黑，请持续规范言行。`
                });
            } catch (e) {
                Logger.warn('verification_pass_reminder_failed', { userId, error: String((e && e.message) || e) });
            }
        }

        // 转发验证期间暂存的消息（走统一转发入口）
        const pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids.slice() : [];
        if (pendingIds.length > 0) {
            try {
                // 限制一次性转发量，避免用户恶意堆积导致执行超时
                const limitedIds = pendingIds.length > CONFIG.PENDING_MAX_MESSAGES
                    ? pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES)
                    : pendingIds;

                let forwardedCount = 0;
                for (const pendingId of limitedIds) {
                    if (!pendingId) continue;
                    const forwardedKey = `forwarded:${userId}:${pendingId}`;
                    const alreadyForwarded = await env.TOPIC_MAP.get(forwardedKey);
                    if (alreadyForwarded) {
                        Logger.info('message_forward_duplicate_skipped', { userId, messageId: pendingId });
                        continue;
                    }

                    const fakeMsg = {
                        message_id: pendingId,
                        chat: { id: userId, type: "private" },
                        from: query.from,
                    };

                    await forwardUserMessage(fakeMsg, userId, `user:${userId}`, env, ctx);
                    await env.TOPIC_MAP.put(forwardedKey, "1", { expirationTtl: 3600 });
                    forwardedCount++;
                }

                if (forwardedCount > 0) {
                    await tgCall(env, "sendMessage", {
                        chat_id: userId,
                        text: `📩 刚才的 ${forwardedCount} 条消息已帮您送达。`
                    });
                }
            } catch (e) {
                Logger.error('pending_message_forward_failed', e, { userId });
                await tgCall(env, "sendMessage", {
                    chat_id: userId,
                    text: "⚠️ 自动发送失败，请重新发送您的消息。"
                });
            }
        }
    } catch (e) {
        Logger.error('callback_query_error', e, {
            userId: query.from?.id,
            callbackData: query.data
        });
        await tgCall(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: `⚠️ 系统错误，请重试`,
            show_alert: true
        });
    }
}


// ---------------- 辅助函数 ----------------

// ---------------- 其他辅助函数 ----------------

// 改进的话题标题构建（清理特殊字符）
function buildTopicTitle(from) {
  const firstName = (from.first_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  const lastName = (from.last_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);

  // 清理 username
  let username = "";
  if (from.username) {
      username = from.username
          .replace(/[^\w]/g, '')  // 只保留字母数字下划线
          .substring(0, 20);
  }

  // 移除控制字符和换行符
  const cleanName = (firstName + " " + lastName)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const name = cleanName || "User";
  const usernameStr = username ? ` @${username}` : "";

  // Telegram 话题标题最大长度为 128 字符
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);

  return title;
}

// Telegram API 基础地址（强制 HTTPS + 格式校验），JSON 与 multipart 调用共用
function tgApiBase(env) {
  let base = env.API_BASE || "https://api.telegram.org";

  // 【修复 #20】强制 HTTPS
  if (base.startsWith("http://")) {
      Logger.warn('api_http_upgraded', { originalBase: base });
      base = base.replace("http://", "https://");
  }

  // 验证 URL 格式
  try {
      new URL(`${base}/test`);
  } catch (e) {
      Logger.error('api_base_invalid', e, { base });
      base = "https://api.telegram.org";
  }
  return base;
}

// multipart/form-data 版 Telegram 调用（sendPhoto / editMessageMedia 上传图片字节用）
async function tgMultipart(env, method, form, timeout = CONFIG.API_TIMEOUT_MS) {
  const base = tgApiBase(env);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
      const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
          method: "POST",
          body: form,
          signal: controller.signal
      });
      clearTimeout(timeoutId);
      return await resp.json();
  } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
          Logger.error('telegram_api_timeout', e, { method, timeout });
          return { ok: false, description: 'Request timeout' };
      }
      Logger.error('telegram_api_failed', e, { method });
      throw e;
  }
}

// 发送图片题（sendPhoto，图片字节直传）
async function tgSendPhoto(env, { chat_id, photoBytes, caption, reply_markup }) {
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  form.append("photo", new Blob([photoBytes], { type: "image/png" }), "captcha.png");
  if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
  }
  if (reply_markup) form.append("reply_markup", JSON.stringify(reply_markup));
  return tgMultipart(env, "sendPhoto", form);
}

// 换图推进轮次（editMessageMedia，图片字节以 attach:// 直传）
async function tgEditMessageMedia(env, { chat_id, message_id, photoBytes, caption, reply_markup }) {
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  form.append("message_id", String(message_id));
  form.append("media", JSON.stringify({
      type: "photo",
      media: "attach://photo",
      caption: caption || "",
      parse_mode: "HTML"
  }));
  form.append("photo", new Blob([photoBytes], { type: "image/png" }), "captcha.png");
  if (reply_markup) form.append("reply_markup", JSON.stringify(reply_markup));
  return tgMultipart(env, "editMessageMedia", form);
}

// 改进的 Telegram API 调用（添加超时和 HTTPS 强制）
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  const base = tgApiBase(env);

  // 【修复 #13】添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
      const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!resp.ok && resp.status >= 500) {
          Logger.warn('telegram_api_server_error', {
              method,
              status: resp.status
          });
      }

      const result = await resp.json();

      // 记录速率限制
      if (!result.ok && result.description && result.description.includes('Too Many Requests')) {
          const retryAfter = result.parameters?.retry_after || 5;
          Logger.warn('telegram_api_rate_limit', {
              method,
              retryAfter
          });
      }

      return result;
  } catch (e) {
      clearTimeout(timeoutId);

      if (e.name === 'AbortError') {
          Logger.error('telegram_api_timeout', e, { method, timeout });
          return { ok: false, description: 'Request timeout' };
      }

      Logger.error('telegram_api_failed', e, { method });
      throw e;
  }
}

async function handleMediaGroup(msg, env, ctx, { direction, targetChat, mapUserId }) {
    const groupId = msg.media_group_id;
    const key = `mg:${direction}:${groupId}`;
    const item = extractMedia(msg);
    if (!item) {
        const res = await tgCall(env, "copyMessage", {
            chat_id: targetChat,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id
        });
        // 私人模式：记录转发映射，机主回复这条消息时可反查用户
        if (mapUserId && res.ok) await putFwdMapping(env, res.result?.message_id, mapUserId);
        return;
    }
    let rec = await safeGetJSON(env, key, null);
    if (!rec) rec = { direction, targetChat, mapUserId: mapUserId || undefined, items: [], last_ts: Date.now() };
    rec.items.push({ ...item, msg_id: msg.message_id });
    rec.last_ts = Date.now();
    await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
    ctx.waitUntil(delaySend(env, key, rec.last_ts));
}

// 【修复 #15, #19】改进的媒体提取（支持更多类型，不修改原数组）
function extractMedia(msg) {
    // 图片
    if (msg.photo && msg.photo.length > 0) {
        const highestResolution = msg.photo[msg.photo.length - 1];  // 不使用 pop()
        return {
            type: "photo",
            id: highestResolution.file_id,
            cap: msg.caption || ""
        };
    }

    // 视频
    if (msg.video) {
        return {
            type: "video",
            id: msg.video.file_id,
            cap: msg.caption || ""
        };
    }

    // 文档
    if (msg.document) {
        return {
            type: "document",
            id: msg.document.file_id,
            cap: msg.caption || ""
        };
    }

    // 音频
    if (msg.audio) {
        return {
            type: "audio",
            id: msg.audio.file_id,
            cap: msg.caption || ""
        };
    }

    // 动图
    if (msg.animation) {
        return {
            type: "animation",
            id: msg.animation.file_id,
            cap: msg.caption || ""
        };
    }

    // 语音和视频消息不支持 media group
    return null;
}

// 【修复 #21】实现媒体组清理
async function flushExpiredMediaGroups(env, now) {
    try {
        const prefix = "mg:";
        const allKeys = await getAllKeys(env, prefix);
        let deletedCount = 0;

        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && rec.last_ts && (now - rec.last_ts > 300000)) { // 超过 5 分钟
                await env.TOPIC_MAP.delete(name);
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            Logger.info('media_groups_cleaned', { deletedCount });
        }
    } catch (e) {
        Logger.error('media_group_cleanup_failed', e);
    }
}

// 【修复 #12, #28】改进媒体组延迟发送
async function delaySend(env, key, ts) {
    await new Promise(r => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));

    const rec = await safeGetJSON(env, key, null);

    if (rec && rec.last_ts === ts) {
        // 验证媒体数组
        if (!rec.items || rec.items.length === 0) {
            Logger.warn('media_group_empty', { key });
            await env.TOPIC_MAP.delete(key);
            return;
        }

        const media = rec.items.map((it, i) => {
            if (!it.type || !it.id) {
                Logger.warn('media_group_invalid_item', { key, item: it });
                return null;
            }
            // 【修复 #28】限制 caption 长度
            const caption = i === 0 ? (it.cap || "").substring(0, 1024) : "";
            return { 
                type: it.type,
                media: it.id,
                caption
            };
        }).filter(Boolean);  // 过滤掉无效项

        if (media.length > 0) {
            try {
                const result = await tgCall(env, "sendMediaGroup", {
                    chat_id: rec.targetChat,
                    media
                });

                if (!result.ok) {
                    Logger.error('media_group_send_failed', result.description, {
                        key,
                        mediaCount: media.length
                    });
                } else {
                    Logger.info('media_group_sent', {
                        key,
                        mediaCount: media.length,
                        targetChat: rec.targetChat
                    });
                    // 私人模式：为相册每条消息记录 fwd 映射，机主回复任意一条即可回信
                    if (rec.mapUserId && Array.isArray(result.result)) {
                        for (const m of result.result) {
                            await putFwdMapping(env, m?.message_id, rec.mapUserId);
                        }
                    }
                }
            } catch (e) {
                Logger.error('media_group_send_exception', e, { key });
            }
        }

        await env.TOPIC_MAP.delete(key);
    }
}
