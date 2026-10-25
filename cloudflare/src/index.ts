import { createApp, type Env } from "./app.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    // Build the app per request. The x402 middleware lazily fetches the facilitator's
    // supported kinds and caches that promise; in Workers an I/O promise started by one
    // request cannot be awaited by another (it never resolves), so a per-isolate app
    // served the first paid call and then hung every later one.
    return createApp(env).fetch(request, env, ctx);
  },
};
