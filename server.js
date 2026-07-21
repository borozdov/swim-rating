"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const UPSTREAM = "https://rsf.lsport.net";
const ORG_ID = "5c43657e-c0ef-4eda-9737-025e2f7bbfe2";
const UPSTREAM_TIMEOUT_MS = 60000; // observed rsf.lsport.net taking 12-40s+ on "unique" queries — 35s was killing real, still-working requests
const CACHE_TTL_MS = 120000; // results rarely change second-to-second; longer TTL shields the slow upstream more

// Only these two known upstream paths are proxyable — not a generic open proxy.
const PROXY_ROUTES = {
  "/api/top": `/data/Records/Top/${ORG_ID}`,
  "/api/locations": `/data/Calendar/Locations/${ORG_ID}`,
};

const cache = new Map(); // "route:bodyHash" -> { expires, status, contentType, body }
const inFlight = new Map(); // "route:bodyHash" -> Promise<result> — coalesces concurrent identical requests so the UI's own re-fetches don't pile up on the slow upstream

function cacheKey(route, body) {
  return `${route}:${crypto.createHash("sha1").update(body).digest("hex")}`;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fetchUpstreamOnce(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type") || "application/json", body: text };
}

async function fetchUpstreamWithRetry(url, body) {
  try {
    return await fetchUpstreamOnce(url, body);
  } catch (err) {
    // A timeout means the upstream is just slow — retrying only doubles the wait.
    // A fast-failing error (connection reset, DNS blip) is worth one retry.
    if (err.name === "TimeoutError") throw err;
    return await fetchUpstreamOnce(url, body);
  }
}

async function proxyRequest(req, res, route, upstreamPath) {
  try {
    const body = await readBody(req);
    const key = cacheKey(route, body);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) {
      res.writeHead(cached.status, { "Content-Type": cached.contentType, "X-Cache": "HIT" });
      res.end(cached.body);
      return;
    }

    let coalesced = true;
    let pending = inFlight.get(key);
    if (!pending) {
      coalesced = false;
      pending = fetchUpstreamWithRetry(UPSTREAM + upstreamPath, body).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    const result = await pending;
    if (result.status === 200) cache.set(key, { ...result, expires: Date.now() + CACHE_TTL_MS });
    res.writeHead(result.status, { "Content-Type": result.contentType, "X-Cache": coalesced ? "COALESCED" : "MISS" });
    res.end(result.body);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function serveStatic(req, res) {
  const urlPath = req.url.split("?")[0];
  const relPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(ROOT, path.normalize(decodeURIComponent(relPath)));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const route = req.url.split("?")[0];
  const upstreamPath = req.method === "POST" && PROXY_ROUTES[route];
  if (upstreamPath) {
    proxyRequest(req, res, route, upstreamPath);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`Рейтинг пловцов: http://localhost:${PORT}`));
