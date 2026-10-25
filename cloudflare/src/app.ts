/**
 * Pay-per-call tools for AI agents: page reader (URL → clean Markdown), email
 * check (no SMTP) and domain intel (RDAP + DNS + homepage tech). Paid per call
 * in USDC over x402, straight to the operator's wallet. Operated by Automaton,
 * an AI agent (human-supervised).
 *
 * Charging rules (enforced by the x402 middleware): the payment is only
 * settled when the response status is below 400. Invalid input (400) and
 * upstream failures (502) are never charged.
 */
import { Hono, type Context, type Next } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { liveNet, validateDomain, validateTarget, type Net } from "./net.js";
import { readPage } from "./reader.js";
import { checkEmail, parseEmail } from "./email.js";
import { domainIntel } from "./domain.js";
import { deepcheck } from "./deepcheck.js";
import { edge, internalRequests, paymentRequiredResponse } from "./edge.js";

export interface Env {
  PAY_TO: string;
  NETWORK: string;
  PRICE_READ: string;
  PRICE_EMAIL: string;
  PRICE_DOMAIN: string;
  PRICE_DEEPCHECK: string;
  FACILITATOR_URL: string;
}

const CONTACT = "automaton-revenue@agentmail.to";
const OPERATOR = "Automaton, an AI agent (human-supervised)";
const SOURCE = "https://github.com/samvsnvsn/automaton-r2";
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1f6feb"/><path d="M9 22l7-12 7 12z" fill="#fff"/></svg>`;

interface Tool {
  path: "/read" | "/email" | "/domain" | "/deepcheck";
  param: "url" | "email" | "domain";
  /** JSON Schema format of the parameter; none for /domain, which also accepts a URL or an email. */
  paramFormat?: "uri" | "email";
  priceVar: keyof Pick<Env, "PRICE_READ" | "PRICE_EMAIL" | "PRICE_DOMAIN" | "PRICE_DEEPCHECK">;
  /** Bazaar keeps service names up to 32 characters. */
  serviceName: string;
  summary: string;
  description: string;
  example: string;
  paramDescription: string;
  /** The first 5 go to Bazaar (its cap); all of them go to OpenAPI. */
  tags: string[];
  output: Record<string, unknown>;
  /** JSON Schema of the 200 body (OpenAPI). */
  schema: Record<string, unknown>;
  validate(value: string | undefined): string | null;
}

const str = { type: "string" };
const nstr = { type: ["string", "null"] };
const int = { type: "integer" };
const bool = { type: "boolean" };
const strs = { type: "array", items: str };
const operator = { type: "string", description: "Who runs this API" };

const TOOLS: Tool[] = [
  {
    path: "/read", param: "url", paramFormat: "uri", priceVar: "PRICE_READ", serviceName: "Automaton Agent Tools",
    summary: "Read a web page as clean Markdown for LLMs (title, description, language, links)",
    description: "Fetches one public URL and returns the readable content as Markdown with navigation, footers, scripts, cookie banners and forms removed, plus title, description, language, canonical URL, word count and up to 100 resolved links. HTML and text pages; up to 100k characters.",
    example: "https://example.com", paramDescription: "Public http(s) URL of the page to read",
    tags: ["web-reader", "markdown", "scrape", "llm", "rag", "content-extraction"],
    output: { url: "https://example.com", finalUrl: "https://example.com/", status: 200, title: "Example Domain", markdown: "# Example Domain\n\nThis domain is for use in illustrative examples...", words: 28, truncated: false, links: [{ text: "More information...", href: "https://www.iana.org/domains/example" }] },
    schema: {
      type: "object",
      required: ["url", "finalUrl", "status", "markdown", "words", "truncated", "links"],
      properties: {
        url: str, finalUrl: { type: "string", description: "URL after redirects" }, status: int, contentType: str,
        title: nstr, description: nstr, lang: { type: ["string", "null"], description: "Page language (html lang)" }, canonical: nstr,
        markdown: { type: "string", description: "Readable content as Markdown (max 100k characters)" }, words: int,
        truncated: { type: "boolean", description: "True when the Markdown was cut at 100k characters" },
        links: { type: "array", maxItems: 100, items: { type: "object", properties: { text: str, href: str } } },
        fetchedMs: int, readAt: { type: "string", format: "date-time" }, operator,
      },
    },
    validate: (v) => { const t = validateTarget(v); return t.ok ? null : t.reason; },
  },
  {
    path: "/email", param: "email", paramFormat: "email", priceVar: "PRICE_EMAIL", serviceName: "Automaton Email Validation",
    summary: "Email validation and verification: syntax, MX record check, deliverability, disposable email detection, typo fix, SPF/DMARC lookup",
    description: "Email validation / email verification API for one address. Deliverability check at the domain level (MX record check, null MX, A-record fallback), syntax check, disposable email detection, free-provider and role-account detection, typo suggestion (gmial.com → gmail.com), mail provider, and SPF and DMARC lookup of the domain. Verdict: deliverable_domain, risky, undeliverable or invalid, with reasons. No SMTP handshake: no mail is sent and mailbox existence is not probed. No PII stored: the address and the result are not kept or logged.",
    example: "jane@gmial.com", paramDescription: "Email address to validate",
    tags: ["email-validation", "email-verification", "email-deliverability", "disposable-email", "mx-record-check", "spf-dmarc", "lead-qualification"],
    output: { email: "jane@gmial.com", verdict: "risky", reasons: ["domain accepts mail (1 MX)", "possible typo of gmail.com"], acceptsMail: true, disposable: false, freeProvider: false, roleAccount: false, suggestion: "jane@gmail.com", mailProvider: null, spf: false, dmarc: "none-published" },
    schema: {
      type: "object",
      required: ["email", "verdict", "reasons", "syntaxValid", "acceptsMail", "disposable", "freeProvider", "roleAccount"],
      properties: {
        email: str, normalized: { type: "string", description: "Address with the domain lower-cased" }, local: str, domain: str,
        verdict: { type: "string", enum: ["deliverable_domain", "risky", "undeliverable", "invalid"], description: "deliverable_domain means the domain accepts mail; the mailbox itself is not probed" },
        reasons: strs, syntaxValid: bool,
        mx: { type: "array", items: { type: "object", properties: { host: str, priority: int } } },
        acceptsMail: { type: ["boolean", "null"], description: "Domain accepts mail (MX, or A-record fallback); false for null MX" },
        nullMx: bool, disposable: { type: "boolean", description: "Throwaway / temporary mail service" },
        freeProvider: { type: "boolean", description: "Free webmail (gmail.com, outlook.com, ...)" },
        roleAccount: { type: "boolean", description: "Shared inbox such as info@, sales@, support@" },
        suggestion: { type: ["string", "null"], description: "Corrected address for a likely domain typo" },
        mailProvider: { type: ["string", "null"], description: "Mail host detected from MX (Google Workspace, Microsoft 365, ...)" },
        spf: { type: ["boolean", "null"], description: "Domain publishes an SPF record" },
        dmarc: { type: ["string", "null"], enum: ["none", "quarantine", "reject", "present", "none-published", null], description: "DMARC policy of the domain" },
        checkedAt: { type: "string", format: "date-time" }, operator,
      },
    },
    validate: (v) => { const p = parseEmail(v); return p.ok ? null : p.reason; },
  },
  {
    path: "/deepcheck", param: "url", paramFormat: "uri", priceVar: "PRICE_DEEPCHECK", serviceName: "Automaton Agent Tools",
    summary: "Deep-check an x402 API endpoint: HTTP status, valid 402 payment challenge, /openapi.json validity, with a fix per failure",
    description: "Monetization diagnostic for x402 API sellers. One public URL: fetches it unpaid and reports the HTTP status, whether the 402 response carries a valid x402 payment challenge (PAYMENT-REQUIRED / X-PAYMENT header or JSON body: version, accepts scheme/network/amount/payTo), whether /openapi.json is a valid OpenAPI 3.x document advertising x-payment-info, plus one failing assertion and one concrete fix suggestion. Only the URL is fetched: no payment is attempted, nothing is stored.",
    example: "https://api.example.com/paid-tool", paramDescription: "Public http(s) URL of the endpoint to deep-check",
    tags: ["x402", "diagnostics", "api-monetization", "openapi", "payment-verification", "developer-tools"],
    output: { url: "https://api.example.com/paid-tool", finalUrl: "https://api.example.com/paid-tool", httpStatus: 402, has402Challenge: true, challengeValid: true, challenge: { x402Version: 2, network: "eip155:8453", amount: "10000", payTo: "0x528eB355837529314A28ab87a3A479Ad857e8698" }, openapiOk: true, failingAssertion: null, fixSuggestion: null },
    schema: {
      type: "object",
      required: ["url", "httpStatus", "has402Challenge", "challengeValid", "openapiOk", "failingAssertion", "fixSuggestion"],
      properties: {
        url: str, finalUrl: { type: "string", description: "URL after redirects" },
        httpStatus: { type: ["integer", "null"], description: "Status of the unpaid GET; null when the endpoint did not answer" },
        has402Challenge: { type: "boolean", description: "The 402 response carries x402 payment requirements" },
        challengeValid: { type: "boolean", description: "The challenge parses and has version, accepts[0] scheme/network/amount/payTo" },
        challenge: { type: ["object", "null"], properties: { x402Version: int, network: str, amount: str, payTo: str }, description: "The parsed challenge when valid" },
        openapiOk: bool, openapiDetail: { type: ["string", "null"], description: "What is wrong with /openapi.json, when it is not ok" },
        failingAssertion: nstr, fixSuggestion: nstr,
        checkedAt: { type: "string", format: "date-time" }, operator,
      },
    },
    validate: (v) => { const t = validateTarget(v); return t.ok ? null : t.reason; },
  },
  {
    path: "/domain", param: "domain", priceVar: "PRICE_DOMAIN", serviceName: "Automaton Agent Tools",
    summary: "Domain intel: registrar, age and expiry (RDAP), DNS, mail/DNS provider, hosting and website technologies",
    description: "Public-source profile of one domain: RDAP registration (registrar, created, expires, age in days, status), DNS (A, AAAA, MX, NS, SPF, DMARC, verification TXT records), mail provider, DNS provider, hosting and technologies detected on the homepage (CMS, framework, CDN, analytics, payments).",
    example: "example.com", paramDescription: "Domain name (a URL or email is accepted and reduced to its domain)",
    tags: ["domain", "whois", "rdap", "dns", "tech-stack", "company-enrichment", "osint"],
    output: { domain: "example.com", registered: true, registration: { registrar: "RESERVED-Internet Assigned Numbers Authority", created: "1995-08-14T04:00:00Z", expires: "2026-08-13T04:00:00Z", ageDays: 11371 }, dns: { mx: [], ns: ["a.iana-servers.net", "b.iana-servers.net"], spf: "v=spf1 -all" }, mailProvider: null, dnsProvider: null, website: { status: 200, title: "Example Domain", technologies: [] } },
    schema: {
      type: "object",
      required: ["domain", "registered", "registration", "dns", "website"],
      properties: {
        domain: str, registered: { type: ["boolean", "null"] },
        registration: {
          type: ["object", "null"], description: "RDAP registration data",
          properties: { registrar: nstr, created: nstr, updated: nstr, expires: nstr, ageDays: { type: ["integer", "null"] }, status: strs, nameservers: strs },
        },
        dns: {
          type: "object",
          properties: { a: strs, aaaa: strs, mx: strs, ns: strs, txtCount: int, spf: nstr, dmarc: nstr, verifications: { type: "array", items: str, description: "Services verified via TXT records" } },
        },
        mailProvider: nstr, dnsProvider: nstr, hosting: nstr,
        website: {
          type: ["object", "null"], description: "Homepage fetch",
          properties: { url: str, status: int, title: nstr, description: nstr, server: nstr, technologies: { type: "array", items: str, description: "CMS, framework, CDN, analytics, payments" }, https: bool },
        },
        checkedAt: { type: "string", format: "date-time" }, operator,
      },
    },
    validate: (v) => { const d = validateDomain(v); return d.ok ? null : d.reason; },
  },
];

export function createApp(env: Env, facilitator?: FacilitatorClient, net: Net = liveNet): Hono {
  const client = facilitator ?? new HTTPFacilitatorClient({ url: env.FACILITATOR_URL });
  const server = new x402ResourceServer(client).register(env.NETWORK as `${string}:${string}`, new ExactEvmScheme());
  const app = new Hono();
  const price = (t: Tool) => env[t.priceVar];
  const chain = env.NETWORK === "eip155:8453" ? "Base" : env.NETWORK;
  const pricing = (t: Tool) => `${price(t)} per call in USDC on ${chain} via x402; no account or API key.`;

  // First, so CORS, the JSON 402 body and the request log wrap every route and the paywall's 402.
  app.use("*", edge);

  const docs = {
    name: "Automaton Agent Tools (pay per call)",
    description: "Small, honest tools for AI agents, paid per call in USDC over x402: validate an email address, read a page as Markdown, profile a domain, deep-check an x402 endpoint.",
    endpoints: TOOLS.map((t) => ({ call: `GET ${t.path}?${t.param}=${encodeURIComponent(t.example)}`, price: price(t), summary: t.summary })),
    currency: "USDC", network: env.NETWORK, payTo: env.PAY_TO,
    protocol: "x402 v2 (HTTP 402 Payment Required; pay with any x402 client, e.g. @x402/fetch)",
    charging: "You are only charged for a completed result. Invalid input (400) and unreachable upstreams (502) are not charged.",
    operator: OPERATOR, contact: CONTACT, source: SOURCE,
    privacy: "Inputs and results are not stored.",
  };

  app.get("/", (c) => c.json(docs));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/favicon.ico", () => new Response(FAVICON, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } }));
  app.get("/llms.txt", (c) => c.text([`# ${docs.name}`, "", docs.description, "", ...docs.endpoints.map((e) => `- ${e.call} (${e.price} USDC): ${e.summary}`), "", docs.charging, `Operator: ${OPERATOR}. Contact: ${CONTACT}.`].join("\n")));

  // Agentcash Discovery v1 profile: x402scan and other registries list an origin from its /openapi.json.
  // Paid operations keep `security: []` (no API key): with `x-payment-info` that classifies them as paid.
  app.get("/openapi.json", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      openapi: "3.1.0",
      info: {
        title: "Automaton Agent Tools", version: "1.0.0", description: docs.description,
        contact: { name: OPERATOR, email: CONTACT, url: SOURCE },
        "x-guidance": `Call GET /email?email=, GET /read?url=, GET /domain?domain= or GET /deepcheck?url= with any x402 client; the first unpaid call answers 402 with the price, then retry with the payment. ${docs.charging} ${docs.privacy}`,
      },
      servers: [{ url: origin }],
      "x-agentcash-guidance": { llmsTxtUrl: `${origin}/llms.txt` },
      paths: Object.fromEntries(TOOLS.map((t) => [t.path, {
        get: {
          operationId: t.path.slice(1), summary: t.summary, description: `${t.description} ${pricing(t)}`, tags: t.tags, security: [],
          "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: price(t).replace(/^\$/, "") }, protocols: [{ x402: {} }] },
          parameters: [{ name: t.param, in: "query", required: true, description: t.paramDescription, schema: { type: "string", ...(t.paramFormat ? { format: t.paramFormat } : {}), description: t.paramDescription }, example: t.example }],
          responses: {
            "200": { description: "Result", content: { "application/json": { schema: t.schema, example: t.output } } },
            "400": { description: "Invalid input (not charged)" },
            "402": paymentRequiredResponse({ url: `${origin}${t.path}`, description: t.summary, price: price(t), network: env.NETWORK, payTo: env.PAY_TO }),
            "502": { description: "Upstream unreachable (not charged)" },
          },
        },
      }])),
    });
  });

  for (const t of TOOLS) {
    // HEAD never runs a tool (Hono would route it to the GET handler, past the GET-only paywall):
    // it answers what an unpaid GET answers, 402 with the payment requirements and no body.
    app.use(t.path, async (c: Context, next: Next) => {
      if (c.req.method !== "HEAD") return next();
      let ctx: typeof c.executionCtx | undefined;
      try { ctx = c.executionCtx; } catch { ctx = undefined; }
      const unpaid = new Request(c.req.url, { method: "GET" });
      internalRequests.add(unpaid);
      const res = await app.fetch(unpaid, c.env, ctx);
      return new Response(null, { status: res.status, headers: res.headers });
    });
    // Validate before the paywall so bad input is never charged; a missing parameter still meets
    // the paywall (the bare resource URL answers 402) and the handler then returns 400, never settled.
    app.use(t.path, async (c: Context, next: Next) => {
      const value = c.req.query(t.param);
      if (value === undefined) return next();
      const reason = t.validate(value);
      if (reason) return c.json({ error: reason, usage: `GET ${t.path}?${t.param}=${t.example}`, charged: false }, 400);
      await next();
    });
  }

  app.use(paymentMiddleware(
    Object.fromEntries(TOOLS.map((t) => [`GET ${t.path}`, {
      accepts: [{ scheme: "exact", price: price(t), network: env.NETWORK as `${string}:${string}`, payTo: env.PAY_TO, maxTimeoutSeconds: 120 }],
      description: `${t.summary}. ${pricing(t)}`, mimeType: "application/json", serviceName: t.serviceName, tags: t.tags.slice(0, 5),
      extensions: declareDiscoveryExtension({
        input: { [t.param]: t.example },
        inputSchema: { properties: { [t.param]: { type: "string", description: t.paramDescription } }, required: [t.param] },
        output: { example: t.output },
      }),
    }])),
    server,
  ));

  const finish = (c: Context, result: object) => {
    if ("error" in result) return c.json({ ...result, charged: false }, 502);
    return c.json({ ...result, operator: OPERATOR });
  };
  app.get("/read", async (c) => {
    const target = validateTarget(c.req.query("url"));
    if (!target.ok) return c.json({ error: target.reason, charged: false }, 400);
    return finish(c, await readPage(target.url.toString(), net));
  });
  app.get("/email", async (c) => {
    const email = c.req.query("email");
    const parsed = parseEmail(email);
    if (!parsed.ok) return c.json({ error: parsed.reason, charged: false }, 400);
    return finish(c, await checkEmail(email!, net));
  });
  app.get("/domain", async (c) => {
    const domain = validateDomain(c.req.query("domain"));
    if (!domain.ok) return c.json({ error: domain.reason, charged: false }, 400);
    return finish(c, await domainIntel(domain.domain, net));
  });
  app.get("/deepcheck", async (c) => {
    const target = validateTarget(c.req.query("url"));
    if (!target.ok) return c.json({ error: target.reason, charged: false }, 400);
    return finish(c, await deepcheck(target.url.toString(), net));
  });

  return app;
}
