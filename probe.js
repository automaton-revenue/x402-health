#!/usr/bin/env node
/**
 * probe.js — health-board probe for x402 endpoints.
 *
 * Reads endpoints.json (seed list of x402 endpoint base URLs advertised on
 * public directories such as x402lens.com and x402-list.com, which index
 * x402scan-listed services). For each URL it records:
 *   - HTTP status of the base URL
 *   - whether a 402 "x402" payment challenge is present (either returned
 *     directly, or on a well-known x402 route)
 *   - whether /openapi.json exists and parses as valid JSON
 *
 * Outputs:
 *   - board.md      (markdown table: URL, status, 402 challenge OK, openapi OK, last checked)
 *   - results.json  (machine-readable results, one record per endpoint)
 *
 * Usage:
 *   node probe.js                  # probe all endpoints, rewrite board.md + results.json
 *   node probe.js --selftest       # run built-in self-tests (no network), exit 0/1
 *
 * Node >= 18, no external dependencies.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const ENDPOINTS_FILE = path.join(ROOT, "endpoints.json");
const BOARD_FILE = path.join(ROOT, "board.md");
const RESULTS_FILE = path.join(ROOT, "results.json");

const TIMEOUT_MS = 15000;
const MAX_CONCURRENCY = 8;
const RETRIES = 1;
const UA =
  "Mozilla/5.0 (compatible; x402-health-board/1.0; automaton-revenue probe; +https://github.com/automaton-revenue)";

/* ------------------------------------------------------------------ utils */

function nowIso() {
  return new Date().toISOString().replace("T", " ").replace("Z", "Z");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** fetchWithTimeout — fetch() with an AbortController timeout. */
async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...opts,
      signal: ac.signal,
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

/** Try a request; on network error retry once before giving up. */
async function fetchRetry(url, opts = {}, retries = RETRIES) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, opts);
      // eslint-disable-next-line no-await-in-loop
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/* ----------------------------------------------------------------- checks */

/** normalizeBase — lowercase host, strip trailing slash, force https. */
function normalizeBase(raw) {
  if (typeof raw !== "string") return null;
  let u = raw.trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname.includes(".")) return null;
    parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** isChallenge — does this response carry a usable 402 x402 payment challenge? */
function isChallenge(res) {
  if (res.status !== 402) return false;
  const h = res.headers;
  // x402 spec: challenge is in the PAYMENT-REQUIRED header (JSON).
  const pay = h.get("payment-required") || h.get("x-payment");
  if (pay && pay.length > 0) return true;
  const accepts = h.get("x-accepts");
  if (accepts && /eip155/i.test(accepts)) return true;
  const contentType = h.get("content-type") || "";
  if (/json/i.test(contentType)) return true;
  return false;
}

/** openapiGetPaths — pick GET paths from an OpenAPI doc that can be probed
 * without supplied parameters (no required query/path params). */
function openapiGetPaths(doc, limit = 2) {
  if (!doc || typeof doc !== "object" || !doc.paths) return [];
  const out = [];
  for (const [p, ops] of Object.entries(doc.paths)) {
    if (out.length >= limit) break;
    if (!ops || typeof ops !== "object" || !ops.get) continue;
    const op = ops.get;
    const params = Array.isArray(op.parameters) ? op.parameters : [];
    const required = params.some((pp) => pp && pp.required && (pp.in === "query" || pp.in === "path"));
    if (required) continue;
    // skip paths with {placeholders} — they need path params even if not declared
    if (p.includes("{")) continue;
    out.push(p.startsWith("/") ? p : "/" + p);
  }
  return out;
}

/** checkOne — probe a single base URL: status, 402 challenge, openapi. */
async function checkOne(base) {
  const rec = {
    url: base,
    source: base,
    status: null,
    challenge402: false,
    challengeDetail: "no 402 response",
    openapi: false,
    openapiDetail: "",
    lastChecked: nowIso(),
    error: null,
  };
  let res = null;
  try {
    res = await fetchRetry(base, { redirect: "manual" });
    rec.status = res.status;
    if (isChallenge(res)) {
      rec.challenge402 = true;
      rec.challengeDetail = "402 challenge on base URL";
    }
  } catch (err) {
    rec.status = null;
    rec.error = `base fetch failed: ${err.name || "Error"}`;
    rec.challengeDetail = "base unreachable";
  }

  // /openapi.json validity — and, if valid, use its own GET paths to look
  // for the 402 challenge (each x402 service protects different routes).
  let probeRoutes = [];
  try {
    const r = await fetchRetry(base + "/openapi.json");
    if (r.status === 200) {
      const text = await r.text();
      try {
        const doc = JSON.parse(text);
        if (doc && typeof doc === "object" && !Array.isArray(doc)) {
          rec.openapi = true;
          rec.openapiDetail =
            doc.openapi || doc.swagger ? `spec ${doc.openapi || doc.swagger}` : "valid JSON object";
          probeRoutes = openapiGetPaths(doc);
        } else {
          rec.openapiDetail = "not a JSON object";
        }
      } catch (e) {
        rec.openapiDetail = `invalid JSON (${e.name})`;
      }
    } else {
      rec.openapiDetail = `HTTP ${r.status}`;
    }
  } catch (err) {
    rec.openapiDetail = `fetch failed: ${err.name || "Error"}`;
  }

  // Look for a 402 x402 challenge on the service's real API routes.
  if (res && !rec.challenge402) {
    const routes = [...probeRoutes, "/"].slice(0, 2);
    for (const route of routes) {
      if (route === "/") continue; // base URL already checked
      try {
        // eslint-disable-next-line no-await-in-loop
        const r2 = await fetchWithTimeout(base + route, { redirect: "manual" });
        if (isChallenge(r2)) {
          rec.challenge402 = true;
          rec.challengeDetail = `402 challenge on ${route}`;
          break;
        }
      } catch {
        /* ignore — route probe is best effort */
      }
    }
  }
  return rec;
}

/** checkAll — probe every URL with bounded concurrency. */
async function checkAll(endpoints) {
  const results = [];
  const batches = chunk(endpoints, MAX_CONCURRENCY);
  for (const batch of batches) {
    // eslint-disable-next-line no-await-in-loop
    const settled = await Promise.all(batch.map((e) => checkOne(e)));
    results.push(...settled);
  }
  return results;
}

/* ----------------------------------------------------------------- output */

function renderBoard(entries, generatedAt) {
  const ok402 = entries.filter((e) => e.challenge402).length;
  const okOpen = entries.filter((e) => e.openapi).length;
  const lines = [
    "# x402 Health Board",
    "",
    `Last checked: ${generatedAt}`,
    "",
    "Probe of public x402 endpoint base URLs (seeded from public directory listings of x402scan-listed services).",
    "",
    `| Endpoint URL | HTTP status | 402 challenge OK | openapi.json OK | Last checked |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  for (const e of entries) {
    lines.push(
      `| ${esc(e.url)} | ${e.status === null ? "unreachable" : e.status} | ${
        e.challenge402 ? "yes" : "no"
      } | ${e.openapi ? "yes" : "no"} | ${esc(e.lastChecked)} |`
    );
  }
  lines.push("", `Endpoints probed: ${entries.length}`);
  lines.push(`With 402 x402 challenge: ${ok402}`);
  lines.push(`With valid openapi.json: ${okOpen}`);
  lines.push("");
  return lines.join("\n");
}

function writeOutputs(entries, generatedAt) {
  fs.writeFileSync(BOARD_FILE, renderBoard(entries, generatedAt) + "\n");
  fs.writeFileSync(
    RESULTS_FILE,
    JSON.stringify({ generatedAt, count: entries.length, results: entries }, null, 2) + "\n"
  );
}

/* --------------------------------------------------------------- selftest */

function selftest() {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error(`FAIL: ${msg}`);
      process.exitCode = 1;
    } else {
      console.log(`ok: ${msg}`);
    }
  };
  // normalizeBase
  assert(normalizeBase("https://Example.com/") === "https://example.com", "normalizeBase strips slash/case");
  assert(normalizeBase("http://foo.bar") === "https://foo.bar", "normalizeBase upgrades http to https");
  assert(normalizeBase("not a url") === null, "normalizeBase rejects garbage");
  assert(normalizeBase("https://localhost") === null, "normalizeBase rejects dotless host");
  assert(normalizeBase("https://a.b.c/path?x=1#frag") === "https://a.b.c/path", "normalizeBase keeps single path, drops query/hash");
  // isChallenge
  const mk = (status, headers) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] || null } });
  assert(isChallenge(mk(402, { "payment-required": "eip155:8453/..." })), "isChallenge accepts payment-required header");
  assert(isChallenge(mk(402, { "x-accepts": "eip155:8453/usdc" })), "isChallenge accepts x-accepts eip155");
  assert(isChallenge(mk(402, { "content-type": "application/json" })), "isChallenge accepts JSON 402 body");
  assert(!isChallenge(mk(200, { "payment-required": "x" })), "isChallenge rejects 200");
  assert(!isChallenge(mk(402, {})), "isChallenge rejects bare 402 without any recognizable signal");
  // renderBoard / writeOutputs shape
  const sample = [
    { url: "https://a.test", status: 200, challenge402: true, openapi: true, lastChecked: "2026-01-01 00:00:00Z" },
    { url: "https://b.test|pipe", status: null, challenge402: false, openapi: false, lastChecked: "2026-01-01 00:00:00Z", error: "x" },
  ];
  const md = renderBoard(sample, "2026-01-01 00:00:00Z");
  assert(md.includes("| https://a.test | 200 | yes | yes |"), "renderBoard renders a passing row");
  assert(md.includes("\\|pipe"), "renderBoard escapes pipes in URLs");
  assert(md.split("\n").filter((l) => l.startsWith("| https")).length === 2, "renderBoard one row per endpoint");
  // board.md must always have >=25 rows when fed 25 endpoints
  const many = Array.from({ length: 30 }, (_, i) => ({
    url: `https://e${i}.test`,
    status: 200,
    challenge402: i % 3 === 0,
    openapi: i % 2 === 0,
    lastChecked: "2026-01-01 00:00:00Z",
  }));
  const mdMany = renderBoard(many, "t");
  const rows = mdMany.split("\n").filter((l) => /^https?:|^\| https?/.test(l)).length;
  assert(rows >= 30, `renderBoard emits one row per endpoint (${rows})`);
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (process.argv.includes("--selftest")) {
    selftest();
    if (process.exitCode === 1) {
      console.error("selftest FAILED");
    } else {
      console.log("selftest passed");
    }
    return;
  }
  if (!fs.existsSync(ENDPOINTS_FILE)) {
    console.error(`missing ${ENDPOINTS_FILE}`);
    process.exit(1);
  }
  let endpoints;
  try {
    const parsed = JSON.parse(fs.readFileSync(ENDPOINTS_FILE, "utf8"));
    endpoints = Array.isArray(parsed.endpoints) ? parsed.endpoints : null;
  } catch (err) {
    console.error(`could not parse ${ENDPOINTS_FILE}: ${err.message}`);
    process.exit(1);
  }
  if (!endpoints || !endpoints.length) {
    console.error("endpoints.json contains no endpoints array");
    process.exit(1);
  }
  const bases = [];
  const seen = new Set();
  for (const e of endpoints) {
    const u = normalizeBase(typeof e === "string" ? e : e.url);
    if (u && !seen.has(u)) {
      seen.add(u);
      bases.push(u);
    }
  }
  console.log(`probing ${bases.length} endpoints...`);
  const results = await checkAll(bases);
  const generatedAt = nowIso();
  writeOutputs(results, generatedAt);
  const ok402 = results.filter((r) => r.challenge402).length;
  const okOpen = results.filter((r) => r.openapi).length;
  console.log(`board.md + results.json written: ${results.length} rows, ${ok402} with 402 challenge, ${okOpen} with valid openapi.json`);
}

main().catch((err) => {
  console.error("probe failed:", err && err.message);
  process.exit(1);
});
