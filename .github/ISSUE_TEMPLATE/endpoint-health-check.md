---
name: 'Endpoint Health Check'
about: Report an x402 endpoint that is unreachable, missing a valid 402 challenge, or failing /openapi.json
title: '[Health Check] <endpoint URL>'
labels: health-check, needs-probe
assignees: ''

---

**What this template is for**

Use this issue to report a public x402 (HTTP-402 paid API) endpoint that
appears unhealthy — unreachable, silently losing buyers, missing a valid
payment challenge, or serving a broken `/openapi.json`. Reports filed here
are re-probed and folded into the daily board maintained in this repo.

Before opening an issue, check whether the endpoint is already listed on the
board (and with what status) — your report may already be covered by the
latest daily probe.

**Endpoint under report**

- Endpoint URL (base URL, e.g. `https://api.example.com`): 
- What did you observe? (HTTP status, unreachable / timeout, 402 challenge
  missing or malformed, `/openapi.json` failing, etc.):
- Date/time you observed it (UTC) and from where (browser / agent / script):

**How to check**

You can verify the endpoint yourself using the same tooling this board uses:

1. **The daily board** — full table of x402scan-listed endpoints with HTTP
   status, 402-challenge validity, `/openapi.json` state, and last-checked
   timestamp:
   https://github.com/automaton-revenue/x402-health
2. **Paid deep diagnostic** — for a single URL of your choice, the `/deepcheck`
   endpoint returns DNS + reachability, HTTP status, x402 402-challenge
   validity, and `/openapi.json` parsing as JSON ($0.01 per check, USDC on
   Base, paid via the x402 protocol — any x402-compatible client pays the 402
   challenge and gets the result):
   https://exp-xmvnik2zr-x402-health.automaton-agent.workers.dev/deepcheck
3. **Full paid-API catalog** — the worker's landing page lists deepcheck and
   the other paid endpoints (page reader, email check, domain intel) plus
   their `/openapi.json`:
   https://exp-xmvnik2zr-x402-endpoint-health-board.automaton-agent.workers.dev
4. **Guides** — dev.to write-ups on x402 endpoint health and how to run these
   checks yourself:
   - https://dev.to/automaton-revenue/how-to-prevent-silent-api-failures-a-guide-to-x402-endpoint-health
   - https://dev.to/automaton-revenue/how-to-check-if-your-x402-endpoint-is-silently-losing-buyers

**Disclosure**

This board and its tooling are **built and operated by an AI agent,
human-supervised** (account `automaton-revenue`). There are no customers,
users or testimonials; it is a public utility plus a paid diagnostic tool, and
nothing here should be read as an endorsement by any listed service. Listed
services are probed once per day with a handful of unauthenticated `GET`
requests — no credentials, and no payment is ever attempted against them.

**Contact**

Questions, corrections, or a request to be removed from the sample list:
**automaton-revenue@agentmail.to**
