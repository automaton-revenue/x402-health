/**
 * Buyer-agent compatibility on every response, registered before any route or
 * the x402 paywall so it also wraps the 402 the payment middleware produces:
 * - CORS, so browser and web-based agents can read the x402 headers;
 * - a JSON body on 402 that mirrors the base64 PAYMENT-REQUIRED header
 *   (x402 v2 sends `{}`), for v1-style clients and LLMs reading the response;
 * - one structured log line per request for Workers Logs. Only the path, never
 *   query values, so no URLs or email addresses are logged.
 */
import type { Context, Next } from "hono";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, Content-Type",
};
export const PREFLIGHT_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  // @x402/fetch also sends Access-Control-Expose-Headers as a request header on the paid retry.
  "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type, Authorization, Access-Control-Expose-Headers",
  "Access-Control-Max-Age": "86400",
};

/** Preflight answer: allows whatever headers the browser asks for (fallback: the static list). */
export function preflight(requestHeaders: string | undefined): Response {
  const headers = new Headers(PREFLIGHT_HEADERS);
  if (requestHeaders?.trim()) headers.set("Access-Control-Allow-Headers", requestHeaders);
  headers.set("Vary", "Access-Control-Request-Headers");
  return new Response(null, { status: 204, headers });
}

/** A real charge: the facilitator settled and the response succeeded (a failed settlement is a 402 that also carries PAYMENT-RESPONSE). */
export function isSettled(res: Response): boolean {
  return res.status < 400 && res.headers.has("PAYMENT-RESPONSE");
}

const USDC: Record<string, string> = { "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };

/** "$0.002" → "2000": x402 v2 runtime amounts are USDC atomic units (6 decimals). */
export function usdcAtomic(price: string): string {
  return String(Math.round(Number(price.replace(/^\$/, "")) * 1e6));
}

const PAYMENT_REQUIRED_SCHEMA = {
  type: "object",
  required: ["x402Version", "resource", "accepts"],
  properties: {
    x402Version: { type: "integer", const: 2 },
    error: { type: "string" },
    resource: { type: "object", properties: { url: { type: "string", format: "uri" }, description: { type: "string" }, mimeType: { type: "string" }, serviceName: { type: "string" }, tags: { type: "array", items: { type: "string" } } } },
    accepts: {
      type: "array",
      items: {
        type: "object",
        required: ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"],
        properties: {
          scheme: { type: "string", const: "exact" },
          network: { type: "string", description: "CAIP-2 network id" },
          amount: { type: "string", description: "Token atomic units (USDC: 6 decimals)" },
          asset: { type: "string", description: "Token contract address" },
          payTo: { type: "string" },
          maxTimeoutSeconds: { type: "integer" },
          extra: { type: "object" },
        },
      },
    },
    extensions: { type: "object", description: "Includes `bazaar`: input/output schema and example" },
  },
};

/** OpenAPI `responses.402` for a paid operation: what the edge middleware returns as the 402 JSON body. */
export function paymentRequiredResponse(o: { url: string; description: string; price: string; network: string; payTo: string }): Record<string, unknown> {
  return {
    description: "Payment Required (x402 v2). The requirements are in the base64 PAYMENT-REQUIRED header and, decoded, in this JSON body. Pay with any x402 client and retry with the PAYMENT-SIGNATURE header.",
    headers: { "PAYMENT-REQUIRED": { description: "Base64 of the JSON body", schema: { type: "string" } } },
    content: {
      "application/json": {
        schema: PAYMENT_REQUIRED_SCHEMA,
        example: {
          x402Version: 2, error: "Payment required",
          resource: { url: o.url, description: o.description, mimeType: "application/json" },
          accepts: [{ scheme: "exact", network: o.network, amount: usdcAtomic(o.price), asset: USDC[o.network] ?? "USDC", payTo: o.payTo, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }],
        },
      },
    },
  };
}

/** Requests the app sends to itself (HEAD answered from an unpaid GET): wrapped, but not logged twice. */
export const internalRequests = new WeakSet<Request>();

/** The PAYMENT-REQUIRED header is base64 of UTF-8 JSON. */
export function decodePaymentRequired(header: string): unknown {
  try {
    const bytes = Uint8Array.from(atob(header), (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function withJson402Body(res: Response, method: string): Promise<Response> {
  if (res.status !== 402 || method === "HEAD") return res;
  const header = res.headers.get("PAYMENT-REQUIRED");
  const type = res.headers.get("Content-Type") ?? "";
  // The HTML paywall served to web browsers stays as it is.
  if (!header || (type !== "" && !type.includes("application/json"))) return res;
  const text = (await res.clone().text()).trim();
  if (text !== "" && text !== "{}") return res;
  const required = decodePaymentRequired(header);
  if (required === null || typeof required !== "object") return res;
  const headers = new Headers(res.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Response(JSON.stringify(required), { status: 402, headers });
}

export async function edge(c: Context, next: Next): Promise<Response | void> {
  const started = Date.now();
  let res: Response;
  if (c.req.method === "OPTIONS") {
    res = preflight(c.req.header("Access-Control-Request-Headers"));
  } else {
    await next();
    res = await withJson402Body(c.res, c.req.method);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  if (!internalRequests.has(c.req.raw)) {
    console.log(JSON.stringify({
      evt: "req", path: c.req.path.slice(0, 100), method: c.req.method, status: res.status,
      paid: c.req.header("PAYMENT-SIGNATURE") !== undefined || c.req.header("X-PAYMENT") !== undefined,
      settled: isSettled(res),
      ua: (c.req.header("User-Agent") ?? "").slice(0, 60), ms: Date.now() - started,
    }));
  }
  if (c.req.method === "OPTIONS") return res;
  // Clear first: Hono's setter would otherwise copy the old headers (e.g. a stale Content-Length) onto `res`.
  c.res = undefined;
  c.res = res;
}
