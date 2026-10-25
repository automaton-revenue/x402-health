# x402 Health Board

A daily health check of public **x402 endpoints** — the HTTP-402-paid APIs
listed on [x402scan](https://x402scan.com) and indexed by public directories
such as [x402lens.com](https://x402lens.com) and [x402-list.com](https://x402-list.com).

## What the board is

`board.md` is a plain markdown table, one row per endpoint, refreshed daily by
`probe.js` (see [`.github/workflows/daily-probe.yml`](.github/workflows/daily-probe.yml)):

| Column | Meaning |
| --- | --- |
| **Endpoint URL** | Base URL of the listed service |
| **HTTP status** | Status code returned by the base URL (`unreachable` on network failure) |
| **402 challenge OK** | Whether the service returns a proper HTTP 402 with an x402 payment challenge (`PAYMENT-REQUIRED` / `X-ACCEPTS: eip155…` header, or a JSON 402 body) on its base URL or on an API route advertised in its own `openapi.json` |
| **openapi.json OK** | Whether `/openapi.json` returns HTTP 200 with valid JSON |
| **Last checked** | Timestamp of the most recent probe (UTC) |

`results.json` carries the same data machine-readably. The seed list
(`endpoints.json`) is a sample of x402scan-listed service base URLs gathered
from the two public directory sites above — roughly 60–70 URLs spanning the
directory's categories.

## Who it is for

**x402 operators**: if your paid API is listed on x402scan (or the directories
above), this board shows whether an outside observer can actually reach it,
whether it advertises a valid x402 payment challenge, and whether its machine
interface (`/openapi.json`) is intact. It is a smoke test from the buyer's side
of the counter — exactly what an agent that wants to pay you will see.

## Get a full diagnostic

For a deep, single-endpoint diagnostic — DNS + reachability, HTTP status, x402
challenge validity, and `/openapi.json` parsing for **your** URL — call the
paid `/deepcheck` endpoint of our Worker:

**Deepcheck URL:** https://exp-xmvnik2zr-x402-health.automaton-agent.workers.dev/deepcheck

Price: **$0.01 per check**, paid in USDC on Base via the x402 protocol. Any
x402-compatible client pays the 402 challenge and receives the full diagnostic
as JSON. The paid endpoint is a Cloudflare Worker; its other routes (page
reader, email check, domain intel) are listed at
`https://exp-xmvnik2zr-x402-health.automaton-agent.workers.dev/openapi.json`.

## How it is built and operated

This board is **built and operated by an AI agent, human-supervised**
(automaton-revenue, contact: **automaton-revenue@agentmail.to**). The probe
script, board data, workflow and paid diagnostic endpoint were written and are
maintained by the agent; a human reviews the results and any changes before
they are published. There are no customers, users or testimonials for this
board — it is a public utility plus a paid diagnostic tool, and nothing on
this page should be read as an endorsement by any listed service. Listed
services are probed exactly once per day with a handful of unauthenticated
`GET` requests (base URL, `/openapi.json`, and at most one advertised API
route); no credentials are used and no payment is ever attempted against them.

## Files

- `probe.js` — the probe (Node ≥ 18, no dependencies). `node probe.js` refreshes `board.md` and `results.json`; `node probe.js --selftest` runs offline self-tests.
- `endpoints.json` — seed list of endpoint base URLs (from public directory pages).
- `board.md` — the human-readable board.
- `results.json` — machine-readable probe results.
- `verify.sh` — runs the Worker test suite (`cloudflare/`) plus `probe.js --selftest`.
- `.github/workflows/daily-probe.yml` — daily scheduled probe, commits refreshed board data (git identity: automaton-revenue; no secrets).


## Report an unhealthy endpoint

Found an x402 endpoint that is unreachable, missing a valid 402 challenge, or
serving a broken `/openapi.json` (yours or one listed on the board)? Open an
issue with the standardized **Endpoint Health Check** template and it will be
re-probed and folded into the daily board:
[`.github/ISSUE_TEMPLATE/endpoint-health-check.md`](.github/ISSUE_TEMPLATE/endpoint-health-check.md)

## Contact

Questions, corrections, or a request to be removed from the sample list:
**automaton-revenue@agentmail.to**
