/**
 * /deepcheck: a paid diagnostic for x402 API sellers. It fetches one public URL
 * unpaid and reports what a paying agent would see: the HTTP status, whether the
 * 402 carries a parseable x402 payment challenge, whether that challenge is valid,
 * and whether /openapi.json is a valid, payment-aware document. One failing
 * assertion and one concrete fix suggestion per failure mode.
 */
import { decodePaymentRequired } from "./edge.js";
import type { Net, Page } from "./net.js";

export interface ChallengeInfo {
  ok: boolean;
  /** What is wrong with the challenge, "" when ok. */
  detail: string;
  x402Version: number | null;
  network: string | null;
  /** Amount in token atomic units (USDC: 6 decimals), as advertised. */
  amount: string | null;
  payTo: string | null;
}

export interface OpenapiCheck {
  ok: boolean;
  /** What is wrong with the document, "" when ok. */
  detail: string;
  /** The document advertises paid operations via `x-payment-info`. */
  hasPaymentInfo: boolean;
}

export interface DeepcheckResult {
  url: string;
  /** Set only when the endpoint could not be reached at all: the caller then answers 502 and never charges. */
  error?: string;
  finalUrl: string | null;
  httpStatus: number | null;
  has402Challenge: boolean;
  challengeValid: boolean;
  challenge: { x402Version: number; network: string; amount: string; payTo: string } | null;
  openapiOk: boolean;
  openapiDetail: string | null;
  failingAssertion: string | null;
  fixSuggestion: string | null;
  checkedAt: string;
  ms: number;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const fail = (detail: string): ChallengeInfo => ({ ok: false, detail, x402Version: null, network: null, amount: null, payTo: null });

/**
 * Extract and validate the x402 payment requirements from an unpaid 402 response:
 * the base64 `PAYMENT-REQUIRED` (v2) or `X-PAYMENT` (v1-style) header, or the JSON
 * body. Valid means: parseable JSON, a non-empty `accepts` array whose first entry
 * has a scheme, a network, a positive amount and a payTo address.
 */
export function parseChallenge(page: Page): ChallengeInfo {
  const candidates: unknown[] = [];
  const pushed = new Set<string>();
  const add = (raw: unknown) => { if (raw !== null && typeof raw === "object") { const key = JSON.stringify(raw); if (!pushed.has(key)) { pushed.add(key); candidates.push(raw); } } };
  for (const header of ["payment-required", "x-payment"]) {
    const value = page.headers[header];
    if (value) add(decodePaymentRequired(value));
  }
  const type = page.contentType.toLowerCase();
  if (page.status === 402 && (type.includes("json") || type === "")) {
    try { add(JSON.parse(page.body)); } catch { /* a plain-text or HTML body is not a challenge */ }
  }
  if (candidates.length === 0) return fail("no payment requirements found in the PAYMENT-REQUIRED / X-PAYMENT headers or the JSON body");
  let firstFailure: ChallengeInfo | null = null;
  for (const candidate of candidates) {
    const info = checkRequirements(candidate);
    if (info.ok) return info;
    firstFailure ??= info; // report the first candidate's (header-first) specific problem
  }
  return firstFailure!;
}

function checkRequirements(raw: unknown): ChallengeInfo {
  const o = raw as Record<string, unknown>;
  const version = typeof o.x402Version === "number" ? o.x402Version : typeof o.version === "number" ? o.version : null;
  if (version === null) return fail("the challenge has no x402Version");
  const accepts = Array.isArray(o.accepts) ? o.accepts : null;
  if (!accepts || accepts.length === 0) return fail("the challenge has an empty or missing accepts array");
  const a = accepts[0] as Record<string, unknown>;
  const scheme = typeof a.scheme === "string" ? a.scheme : null;
  if (!scheme) return fail("accepts[0].scheme is missing");
  const network = typeof a.network === "string" ? a.network : null;
  if (!network) return fail("accepts[0].network is missing (CAIP-2 id, e.g. eip155:8453)");
  const amount = typeof a.amount === "string" ? a.amount : typeof a.maxAmountRequired === "string" ? a.maxAmountRequired : null;
  if (amount === null || !/^\d+$/.test(amount) || Number(amount) <= 0) return fail("accepts[0].amount is missing or not a positive token amount in atomic units");
  const payTo = typeof a.payTo === "string" ? a.payTo : null;
  if (!payTo || !EVM_ADDRESS.test(payTo)) return fail("accepts[0].payTo is missing or not a 0x EVM address");
  return { ok: true, detail: "", x402Version: version, network, amount, payTo };
}

/** Validate an /openapi.json response: reachable, JSON, OpenAPI 3.x, info.title, non-empty paths. */
export function validateOpenapiDoc(page: Page | null): OpenapiCheck {
  if (!page) return { ok: false, detail: "GET /openapi.json did not answer", hasPaymentInfo: false };
  if (page.status !== 200) return { ok: false, detail: `GET /openapi.json returned HTTP ${page.status}`, hasPaymentInfo: false };
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(page.body) as Record<string, unknown>; } catch { return { ok: false, detail: "GET /openapi.json did not return valid JSON", hasPaymentInfo: false }; }
  if (typeof doc.openapi !== "string" || !/^3\./.test(doc.openapi)) return { ok: false, detail: "openapi.json has no OpenAPI 3.x `openapi` version field", hasPaymentInfo: false };
  const info = doc.info as Record<string, unknown> | undefined;
  if (!info || typeof info.title !== "string") return { ok: false, detail: "openapi.json has no info.title", hasPaymentInfo: false };
  const paths = doc.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== "object" || Object.keys(paths).length === 0) return { ok: false, detail: "openapi.json has no paths", hasPaymentInfo: false };
  return { ok: true, detail: "", hasPaymentInfo: page.body.includes("x-payment-info") };
}

/** Run the full deep check against one URL. Never throws: every failure is a field in the result. */
export async function deepcheck(url: string, net: Net): Promise<DeepcheckResult> {
  const started = Date.now();
  const base: Omit<DeepcheckResult, "httpStatus" | "has402Challenge" | "challengeValid" | "challenge" | "openapiOk" | "openapiDetail" | "failingAssertion" | "fixSuggestion" | "ms"> & { ms: number } = {
    url, finalUrl: null, checkedAt: new Date().toISOString(), ms: 0,
  };
  const done = (r: Omit<DeepcheckResult, "url" | "checkedAt" | "ms" | "finalUrl"> & { finalUrl: string | null }): DeepcheckResult => ({ ...base, ...r, ms: Date.now() - started });

  const page = await net.page(url);
  if (!page) {
    return done({
      finalUrl: null, httpStatus: null, has402Challenge: false, challengeValid: false, challenge: null, openapiOk: false, openapiDetail: null,
      error: "the endpoint did not answer (timeout, DNS failure or connection refused)",
      failingAssertion: "the endpoint did not answer (timeout, DNS failure or connection refused)",
      fixSuggestion: "Make sure the host resolves and serves HTTPS on 443; test `curl -v <url>` from a public network. Cloudflare Workers and browser agents cannot reach hosts that only answer on an intranet or with a self-signed certificate.",
    });
  }

  const challenge = page.status === 402 ? parseChallenge(page) : fail("the endpoint did not return 402, so there is no challenge");
  // A 402 with at least a challenge attempt (header or parseable body) counts as "has challenge";
  // `challengeValid` then says whether it was actually usable.
  const has402Challenge = page.status === 402 && (challenge.ok || page.headers["payment-required"] !== undefined || page.headers["x-payment"] !== undefined);

  const origin = new URL(page.finalUrl || url).origin;
  const spec = validateOpenapiDoc(await net.page(`${origin}/openapi.json`));

  const failing = pickFailure(page, challenge, has402Challenge, spec);
  return done({
    finalUrl: page.finalUrl, httpStatus: page.status, has402Challenge, challengeValid: challenge.ok,
    challenge: challenge.ok ? { x402Version: challenge.x402Version!, network: challenge.network!, amount: challenge.amount!, payTo: challenge.payTo! } : null,
    openapiOk: spec.ok, openapiDetail: spec.ok ? null : spec.detail,
    failingAssertion: failing[0], fixSuggestion: failing[1],
  });
}

/** The first failing assertion in priority order, with its concrete fix. */
function pickFailure(page: Page, challenge: ChallengeInfo, has402Challenge: boolean, spec: OpenapiCheck): [string, string] | [null, null] {
  if (page.status >= 400 && page.status !== 402) {
    return [`the endpoint returned HTTP ${page.status} for an unpaid GET`,
      page.status >= 500
        ? "Fix the server error first: an endpoint that 500s cannot be evaluated or bought. Log the failing request server-side; the deep check sent no unusual headers."
        : "Serve the real resource for an unpaid GET (404/410 reads as a missing endpoint). Agents probe the exact URL you advertise, so make sure it exists without authentication."];
  }
  if (page.status === 402 && !has402Challenge) {
    return ["the 402 response carries no x402 payment requirements",
      "On 402, return the payment requirements: x402 v2 wants them base64-encoded in the `PAYMENT-REQUIRED` response header (and any x402 client also accepts an application/json body with `x402Version` and an `accepts` array). Use a maintained middleware (e.g. @x402/hono's paymentMiddleware) instead of hand-writing the 402."];
  }
  if (page.status === 402 && !challenge.ok) {
    return [`the x402 payment challenge is invalid: ${challenge.detail}`,
      "Build the 402 from a middleware, not by hand: `accepts[0]` needs `scheme: \"exact\"`, a CAIP-2 `network` (e.g. eip155:8453 for Base), a positive `amount` in USDC atomic units (6 decimals; $0.01 = \"10000\") and a valid `payTo` 0x address. Verify with `curl -i <url>` and decode the PAYMENT-REQUIRED header (`base64 -d`)."];
  }
  if (page.status < 400 && !has402Challenge) {
    return ["the endpoint did not return 402, so it is not x402-monetized",
      "Wrap the route in a payment middleware (e.g. `paymentMiddleware` from @x402/hono, or the Express/Fastify equivalent): an unpaid GET must answer HTTP 402 with the payment requirements (base64 PAYMENT-REQUIRED header or JSON body with `x402Version` and `accepts`), and the paid retry must then serve the real resource."];
  }
  if (!spec.ok) {
    return [spec.detail,
      spec.detail.includes("did not answer") || spec.detail.includes("returned HTTP")
        ? "Publish an OpenAPI document at https://<origin>/openapi.json with HTTP 200 (CORS-exposed) so registries and agents can discover the API."
        : spec.detail.includes("JSON")
          ? "Serve valid JSON at /openapi.json (Content-Type: application/json); the current body does not parse."
          : "Complete the OpenAPI document: it needs an `openapi: \"3.x\"` version field, an `info.title` and a non-empty `paths` object."];
  }
  if (has402Challenge && !spec.hasPaymentInfo) {
    return ["openapi.json does not advertise x-payment-info",
      "Add `x-payment-info: { price: { mode: \"fixed\", currency: \"USD\", amount: \"0.01\" }, protocols: [{ x402: {} }] }` (and `security: []`) to each paid operation in /openapi.json so Agentcash/x402scan classify it as paid rather than free."];
  }
  return [null, null];
}
