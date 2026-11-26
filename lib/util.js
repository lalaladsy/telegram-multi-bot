// lib/util.js — 转发 bot（lib/bot.js）与管理端（api/manager.js）共用的小工具

// HTML 模式下用户可控字符串（昵称/用户名/消息预览等）必须先转义，避免 < > & 破版或注入标签
export function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
