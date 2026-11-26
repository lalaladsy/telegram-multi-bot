// Telegram command menus (setMyCommands) for the multi-bot platform.
// Visitors see a minimal menu; each bot owner gets the full owner menu in
// their private chat with the bot (chat scope). Same idea for the manager.

// Menu content version: bump whenever the command lists below change.
// Stored per bot (registry menuSet / KV multi:mgrmenu); a mismatch with the
// stored value triggers a re-set on the next webhook/manager update.
export const MENU_VERSION = 8;

async function setCommands(token, commands, scope) {
  const body = { commands };
  if (scope) body.scope = scope;
  try {
    // Hard 6s timeout: a hung Telegram call must never stall menu setup.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let r;
    try {
      r = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const j = await r.json();
    return j.ok === true;
  } catch {
    return false;
  }
}

export async function setBotMenus(token, ownerId) {
  const visitor = [{ command: "start", description: "开始使用" }];
  const owner = [
    { command: "start", description: "开始使用" },
    { command: "help", description: "功能清单与使用说明" },
    { command: "tongji", description: "数据统计（今日 + 累计）" },
    { command: "level", description: "验证方式与难度" },
    { command: "ad", description: "广告过滤等级（宽松 / 标准 / 严格）" },
    { command: "ai", description: "AI 辅助设置（接口/Token/模型）" },
    { command: "zongjie", description: "AI 今日消息总结" },
    { command: "baimingdan", description: "白名单管理" },
    { command: "heimingdan", description: "黑名单管理" },
    { command: "guancha", description: "观察期管理" },
    { command: "open", description: "开放接收消息" },
    { command: "close", description: "暂停接收消息" },
    { command: "reset", description: "重置用户验证（回复转发消息用）" },
    { command: "cleanup", description: "清理过期数据" },
    { command: "fix", description: "自检修复（bot 没反应时用）" },
  ];
  const a = await setCommands(token, visitor);
  const b = await setCommands(token, owner, { type: "chat", chat_id: Number(ownerId) });
  return a && b;
}

export async function setManagerMenus(token, adminIds) {
  const base = [
    { command: "start", description: "开始 / 注册机器人" },
    { command: "list", description: "我的机器人与管理面板" },
    { command: "del", description: "删除一个机器人" },
  ];
  let ok = await setCommands(token, base);
  for (const id of adminIds || []) {
    const withAdmin = [...base, { command: "admin", description: "平台管理统计" }, { command: "fix", description: "自检修复（管理 bot 没反应时用）" }];
    ok = (await setCommands(token, withAdmin, { type: "chat", chat_id: Number(id) })) && ok;
  }
  return ok;
}
