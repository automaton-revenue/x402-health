# x402 agent tools API

Pay-per-call tools for AI agents on Cloudflare Workers, operated by Automaton, an AI agent (human-supervised).

- Live: https://agent-tools-x402.automaton-agent.workers.dev (after `npx wrangler@4 deploy`)
- Paid in USDC on Base mainnet (`eip155:8453`) to the treasury `0x528eB355837529314A28ab87a3A479Ad857e8698`, facilitator `https://facilitator.payai.network`.
- Discovery: `/openapi.json` (Agentcash Discovery v1, used by x402scan: 200 + 402 schemas, `x-payment-info`, `x-agentcash-guidance.llmsTxtUrl`), `/llms.txt`, Bazaar extension on every route (service name max 32 chars, first 5 tags kept).

| Call | Price | Returns |
|---|---|---|
| `GET /read?url=` | $0.003 | Page as clean Markdown + title, description, language, canonical, links |
| `GET /email?email=` | $0.002 | Syntax, MX/null MX, disposable, free provider, role account, typo suggestion, mail provider, SPF/DMARC; no SMTP probing |
| `GET /domain?domain=` | $0.01 | RDAP registration (registrar, created, expires, age), DNS, mail/DNS provider, hosting, homepage technologies |

Charging: the middleware settles only when the status is below 400. Invalid input (400) and upstream failures (502) are never charged. Inputs and results are not stored.

## Buyer-agent compatibility (`src/edge.ts`)

- CORS on every response, 402 included: `Access-Control-Allow-Origin: *`, and the x402 headers are exposed. `OPTIONS` on any path answers 204 and allows the headers the browser asks for in `Access-Control-Request-Headers`. Without that header it allows `PAYMENT-SIGNATURE`, `X-PAYMENT`, `Content-Type`, `Authorization` and `Access-Control-Expose-Headers`, which @x402/fetch sends on the paid retry.
- 402 body: x402 v2 puts the requirements only in the base64 `PAYMENT-REQUIRED` header and sends `{}`. The worker returns the decoded header as the JSON body too, for v1-style clients and LLMs reading the response. `HEAD` stays bodiless.
- OpenAPI paid operations keep `security: []`. AgentCash Discovery classifies `security: []` plus `x-payment-info` as "paid" (no API key). An API-key scheme would turn that into "apiKey+paid".

## Logs

Workers Logs is on (`[observability]` in `wrangler.toml`). Invocation logs are off (`invocation_logs = false`) because they record the full request URL, query included. Each request writes one JSON line with no query values, so no URLs or emails:

```
{"evt":"req","path":"/email","method":"GET","status":200,"paid":true,"settled":true,"ua":"<first 60 chars>","ms":42}
```

`paid` means the request carried `PAYMENT-SIGNATURE` or `X-PAYMENT`. `settled` means a status below 400 with a `PAYMENT-RESPONSE` header, which is a real charge. A failed settlement also carries `PAYMENT-RESPONSE`, but as a 402, so it counts as not settled. Query in the Cloudflare dashboard under Workers & Pages, agent-tools-x402, Logs, filtering on `evt = req` and `settled = true`. Or stream live (this real-time stream does show the full request URL; it is not stored):

```
npx wrangler@4 tail agent-tools-x402 --format json
```

## Develop

```
npm test            # unit + paid-path tests (fake facilitator, no funds move)
npx tsc --noEmit
npx wrangler@4 deploy   # needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
```
