// Upstash Redis REST client with a Cloudflare KV-compatible surface.
// Implements the subset of KV used by bot.js: get / put / delete / list.
// Optional prefix namespaces every key (multi-bot isolation: one prefix per bot).

export function createKV(url, token, prefix = "") {
  if (!url || !token) return null;

  async function cmd(...args) {
    // Hard 8s timeout: a hung Upstash request must never stall the function.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("Upstash timeout (8s)");
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Upstash: ${data.error}`);
    return data.result;
  }

  const full = (key) => prefix + key;

  return {
    async get(key, opts) {
      const val = await cmd("GET", full(key));
      if (val === null || val === undefined) return null;
      if (opts && opts.type === "json") {
        try {
          return JSON.parse(val);
        } catch {
          return val;
        }
      }
      return val;
    },

    async put(key, value, opts) {
      const v = typeof value === "string" ? value : JSON.stringify(value);
      if (opts && opts.expirationTtl) {
        return cmd("SET", full(key), v, "EX", String(Math.max(1, Math.floor(opts.expirationTtl))));
      }
      return cmd("SET", full(key), v);
    },

    async delete(key) {
      return cmd("DEL", full(key));
    },

    // Cloudflare KV list: { keys: [{name}], list_complete, cursor }
    // Backed by Redis SCAN with MATCH prefix*. Returned names have the
    // namespace prefix stripped, so callers see logical keys only.
    async list(opts = {}) {
      const p = opts.prefix || "";
      const cursor = opts.cursor || "0";
      const [next, keys] = await cmd("SCAN", cursor, "MATCH", `${prefix}${p}*`, "COUNT", "200");
      const complete = next === "0";
      return {
        keys: keys.map((name) => ({ name: name.slice(prefix.length) })),
        list_complete: complete,
        cursor: complete ? "" : next,
      };
    },
  };
}
