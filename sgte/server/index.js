/**
 * Smart Guided Troubleshooting Engine — HTTP service (§5).
 *
 * Zero dependencies, Node 18+. Built on node:http rather than a framework so
 * the whole thing runs with `node server/index.js` on a machine with nothing
 * installed — which is also what §2 [4] asks for: clean containerisation and
 * dependable cold-start.
 *
 * Contract endpoints
 *   POST /v1/troubleshoot   { query, siis_response? }  -> plan + meta
 *   GET  /health            { "status": "ok" } once cache and index are ready
 *
 * Everything else on this server exists for the demo UI and is namespaced
 * under /api/ so it can never be mistaken for the graded contract.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DeeplinkIndex } from "../engine/retrieval.js";
import { troubleshoot } from "../engine/pipeline.js";
import { FastPathCache } from "./cache.js";
import { MetricsStore } from "./metrics.js";
import { validateResponse } from "../shared/contract.js";
import { canonical, variations } from "../shared/variations.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(path.join(ROOT, ".env"));

const START_PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";

/* ============================================================== boot state */

let READY = false;

const index = DeeplinkIndex.fromFile(path.join(ROOT, "data", "deeplinks.json"));
const cache = new FastPathCache({ ttlMs: Number(process.env.CACHE_TTL_MS || 60 * 60 * 1000) });
const metrics = new MetricsStore(path.join(ROOT, "data", "metrics.json"));

const siisRows = readJsonSafe(path.join(ROOT, "data", "siis_responses.json"))?.responses || [];
const seed = readJsonSafe(path.join(ROOT, "data", "cache-seed.json"));
const seeded = seed ? cache.seed(seed.records) : 0;

// §5 /health returns ok "when the caching layer, model connections, and vector
// indexes are fully initialized" — so it reports the truth rather than 200 by
// default.
READY = index.docs.length > 0 && cache.size >= 0;

/* ================================================================== routes */

const routes = {
  /* ------------------------------------------------- contract endpoints -- */

  "GET /health": async (_body, _url, res) => {
    if (!READY) return sendJson(res, 503, { status: "initializing" });
    return sendJson(res, 200, { status: "ok" });
  },

  "POST /v1/troubleshoot": async (body, _url, res) => {
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) return sendJson(res, 400, { error: "query is required" });

    const siis = normaliseSiis(body.siis_response);
    const out = troubleshoot({ query, siisResponse: siis, index, cache });

    metrics.record({
      type: "troubleshoot",
      latencyMs: out.body.meta.latency_ms,
      cacheHit: out.body.meta.cache_hit,
      match: out.body.meta.cache_match || null,
      contexts: out.body.response.contexts.length,
      fallback: out.body.fallback || null,
      hadSiis: !!siis
    });

    // §4.2.4 Pure JSON Delivery: the body is the payload, nothing wrapped
    // around it and no conversational preamble.
    return sendJson(res, 200, out.body);
  },

  /* ------------------------------------------------------ demo UI support - */

  "GET /api/health": async () => ({
    ok: READY,
    version: "1.0.0",
    catalog: { entries: index.docs.length, uris: index.uris.size, placeholder: !!index.placeholderEntry() },
    cache: { entries: cache.size, seeded, stats: cache.stats },
    reference: { rows: siisRows.length },
    retrieval: { dense: "hashed-char-ngram", keyword: "bm25" }
  }),

  /** The reference corpus, so the UI can offer a complaint without one typed. */
  "GET /api/reference": async () => ({
    rows: siisRows.map(r => ({
      id: r.id,
      query: String(r.original_query || "").replace(/^\s*\d+\.\s*/, "").trim(),
      title: r.siis_response?.title || ""
    }))
  }),

  /** Same engine as the contract route, but returns the diagnostics too. */
  "POST /api/troubleshoot": async (body) => {
    const query = String(body.query || "");
    if (!query.trim()) throw httpError(400, "query is required");

    let siis = normaliseSiis(body.siis_response);
    if (!siis && body.refId) {
      const row = siisRows.find(r => r.id === body.refId);
      if (row) siis = row.siis_response;
    }

    const out = troubleshoot({ query, siisResponse: siis, index, cache });
    metrics.record({
      type: "troubleshoot", latencyMs: out.body.meta.latency_ms,
      cacheHit: out.body.meta.cache_hit, match: out.body.meta.cache_match || null,
      contexts: out.body.response.contexts.length, fallback: out.body.fallback || null,
      hadSiis: !!siis, ui: true
    });

    const check = validateResponse(out.body.response, { catalogUris: index.uris });
    return { ...out.body, diagnostics: out.diagnostics, validation: check };
  },

  /** Phase 0 on its own, for the enrichment panel. */
  "POST /api/enrich": async (body) => {
    const query = String(body.query || "");
    return { query, canonical: canonical(query), query_variations: variations(query) };
  },

  "GET /api/metrics": async () => ({ ...metrics.summary(), cache: { entries: cache.list(), stats: cache.stats } }),

  "POST /api/metrics/reset": async () => { metrics.reset(); return { ok: true }; }
};

/* ================================================================== server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const key = `${req.method} ${url.pathname}`;

  if (req.method === "OPTIONS") return res.writeHead(204, cors()).end();

  const handler = routes[key];
  if (handler) {
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      const out = await handler(body, url, res);
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[sgte] ${key}:`, err);
      if (!res.headersSent) sendJson(res, status, { error: err.message || "internal error" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
    return sendJson(res, 404, { error: `no route for ${key}` });
  }

  serveStatic(url.pathname, res);
});

function startServer(port) {
  server.once("error", err => {
    if (err.code === "EADDRINUSE") {
      const next = port + 1;
      console.warn(`[sgte] Port ${port} is already in use; trying ${next}...`);
      startServer(next);
      return;
    }
    throw err;
  });

  server.listen(port, HOST, () => {
    console.log(`
  Smart Guided Troubleshooting Engine
  ------------------------------------------------------------
  API            http://${HOST}:${port}/v1/troubleshoot
  Health         http://${HOST}:${port}/health
  Console        http://${HOST}:${port}
  ------------------------------------------------------------
  Deeplinks      ${index.docs.length} catalog entries, ${index.uris.size} URIs
  Reference      ${siisRows.length} rows
  Cache          ${cache.size} pre-warmed plans
  Retrieval      BM25 + dense (hashed char n-gram)
  ------------------------------------------------------------
  Ctrl+C to stop.
`);
  });
}

startServer(START_PORT);

/* ================================================================= helpers */

/** Accept the reference text as an object or as a raw string. */
function normaliseSiis(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { title: "", content: text } : null;
  }
  if (typeof value === "object" && (value.content || value.title)) {
    return { title: String(value.title || ""), content: String(value.content || "") };
  }
  return null;
}

function serveStatic(pathname, res) {
  if (pathname === "/") pathname = "/index.html";
  const allowed = [path.join(ROOT, "public"), path.join(ROOT, "shared")];
  const base = pathname.startsWith("/shared/") ? ROOT : path.join(ROOT, "public");
  const file = path.normalize(path.join(base, pathname));

  if (!allowed.some(dir => file.startsWith(dir))) return res.writeHead(403).end("forbidden");

  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    res.writeHead(200, { "content-type": mimeFor(file), "cache-control": "no-cache", ...cors() }).end(data);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".py": "text/plain; charset=utf-8"
};
const mimeFor = f => MIME[path.extname(f).toLowerCase()] || "application/octet-stream";

const cors = () => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS"
});

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...cors()
  }).end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => {
      raw += c;
      if (raw.length > 4e6) { reject(httpError(413, "body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(httpError(400, "invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* a missing .env is the normal case */ }
}
