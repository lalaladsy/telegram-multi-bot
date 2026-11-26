// Turnstile WebApp verification page: GET /verify?b=<botId>&s=<session>
// Served as a Telegram WebApp: user completes Cloudflare Turnstile here,
// the page posts the token to /api/turnstile-check for server-side verify.
// The site key is injected by the server from env TURNSTILE_SITE_KEY.

export const config = { runtime: "edge" };

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>真人验证</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTsLoad&render=explicit" async defer></script>
<style>
  body { font-family: -apple-system, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px 16px; background: var(--tg-theme-bg-color, #ffffff); color: var(--tg-theme-text-color, #222222); text-align: center; }
  h1 { font-size: 20px; margin: 8px 0 4px; }
  p.desc { font-size: 14px; color: var(--tg-theme-hint-color, #888888); margin: 4px 0 20px; }
  #ts-box { display: flex; justify-content: center; min-height: 70px; }
  #status { margin-top: 20px; font-size: 15px; min-height: 22px; }
  #status.ok { color: #2e9e4f; }
  #status.err { color: #d33a2c; }
</style>
</head>
<body>
<h1>🛡 真人验证</h1>
<p class="desc">请完成下方验证，确认您不是机器人。</p>
<div id="ts-box"></div>
<div id="status">验证组件加载中…</div>
<script>
  var SITE_KEY = "__TURNSTILE_SITE_KEY__";
  var params = new URLSearchParams(location.search);
  var botId = params.get("b");
  var session = params.get("s");
  var widgetId = null;

  function setStatus(text, cls) {
    var el = document.getElementById("status");
    el.textContent = text;
    el.className = cls || "";
  }

  function resetWidget() {
    if (window.turnstile && widgetId !== null && widgetId !== undefined) {
      try { turnstile.reset(widgetId); } catch (e) {}
    }
  }

  window.onTsLoad = function () {
    if (window.Telegram && Telegram.WebApp) {
      Telegram.WebApp.ready();
      Telegram.WebApp.expand();
    }
    if (!botId || !session) {
      setStatus("❌ 验证参数缺失，请回到机器人重新发起验证。", "err");
      return;
    }
    if (!SITE_KEY) {
      setStatus("❌ 验证服务未配置，请改用答题验证。", "err");
      return;
    }
    widgetId = turnstile.render("#ts-box", {
      sitekey: SITE_KEY,
      callback: onTsToken,
      "error-callback": function () {
        setStatus("❌ 验证组件出错，请稍后重试。", "err");
      },
      "expired-callback": function () {
        setStatus("验证已过期，请重新完成。", "err");
        resetWidget();
      }
    });
    setStatus("请勾选上方验证框");
  };

  function onTsToken(token) {
    setStatus("正在确认验证结果…");
    fetch("/api/turnstile-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ b: botId, s: session, token: token })
    }).then(function (r) {
      return r.json();
    }).then(function (data) {
      if (data && data.ok) {
        setStatus("✅ 验证通过，可以关闭本页", "ok");
        document.getElementById("ts-box").style.display = "none";
        if (window.Telegram && Telegram.WebApp) {
          setTimeout(function () { Telegram.WebApp.close(); }, 900);
        }
      } else {
        setStatus("❌ 验证未通过，请重试。", "err");
        resetWidget();
      }
    }).catch(function () {
      setStatus("❌ 网络错误，请重试。", "err");
      resetWidget();
    });
  }
</script>
</body>
</html>`;

export default async function handler(request) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const siteKey = process.env.TURNSTILE_SITE_KEY || "";
  const html = PAGE.replace("__TURNSTILE_SITE_KEY__", siteKey);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
