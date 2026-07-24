/**
 * Прокси к rsf.lsport.net + раздача статики (public/) одним Worker'ом —
 * замена server.js для деплоя на Cloudflare (GitHub Pages не может принимать
 * POST, а /api/top и /api/locations — POST-запросы).
 *
 * Логика проксирования 1:1 повторяет server.js: тот же org ID, те же два
 * маршрута, тот же таймаут и один повтор при не-таймаут-ошибке. Кэш и
 * дедупликация параллельных одинаковых запросов, которые в server.js жили в
 * module-level Map (in-memory на процесс Node), здесь заменены на Workers
 * Cache API — единственный официально поддерживаемый способ переживать смену
 * изолята между запросами; module-level Map в Workers для этого не годится.
 */

const UPSTREAM = "https://rsf.lsport.net";
const ORG_ID = "5c43657e-c0ef-4eda-9737-025e2f7bbfe2";
const UPSTREAM_TIMEOUT_MS = 60000; // rsf.lsport.net реально настолько медленный на "unique"-запросах
const CACHE_TTL_S = 120;
// Фронтенд теперь на GitHub Pages — если этот Worker когда-нибудь снова станет
// прод-бэкендом (см. README), ему нужен тот же CORS, что уже есть в server.js.
const ALLOWED_ORIGIN = "https://borozdov.github.io";

const PROXY_ROUTES = {
  "/api/top": `/data/Records/Top/${ORG_ID}`,
  "/api/locations": `/data/Calendar/Locations/${ORG_ID}`,
};

async function sha1Hex(text) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchUpstreamOnce(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type") || "application/json", text };
}

async function fetchUpstreamWithRetry(url, body) {
  try {
    return await fetchUpstreamOnce(url, body);
  } catch (err) {
    // Таймаут значит, что upstream просто медленный — повтор только удвоит ожидание.
    // Быстро свалившаяся ошибка (обрыв соединения) стоит одной попытки повтора.
    if (err.name === "TimeoutError") throw err;
    return await fetchUpstreamOnce(url, body);
  }
}

async function proxyRequest(request, ctx, route, upstreamPath) {
  const bodyText = await request.text();
  const hash = await sha1Hex(bodyText);
  // Cache API ключуется по URL GET/HEAD-запроса — тело POST в ключ не входит.
  // Зашиваем хэш тела в синтетический GET-URL исключительно как ключ кэша
  // (см. developers.cloudflare.com/workers/cache/limitations — "hash the
  // request body into a synthetic URL" — это документированный обход).
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = route;
  cacheUrl.search = `?h=${hash}`;
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set("X-Cache", "HIT");
    hit.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    return hit;
  }

  const result = await fetchUpstreamWithRetry(UPSTREAM + upstreamPath, bodyText);
  if (result.status === 200) {
    const toCache = new Response(result.text, {
      status: 200,
      headers: { "Content-Type": result.contentType, "Cache-Control": `public, max-age=${CACHE_TTL_S}` },
    });
    // Не блокируем ответ пользователю записью в кэш.
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }
  return new Response(result.text, {
    status: result.status,
    headers: { "Content-Type": result.contentType, "X-Cache": "MISS", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Content-Type: application/json на POST — не "простой" CORS-запрос, браузер
    // сперва шлёт OPTIONS и ждёт эти три заголовка, прежде чем отправить сам POST.
    if (request.method === "OPTIONS" && PROXY_ROUTES[url.pathname]) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    const upstreamPath = request.method === "POST" && PROXY_ROUTES[url.pathname];
    if (upstreamPath) {
      try {
        return await proxyRequest(request, ctx, url.pathname, upstreamPath);
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
        });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
