/**
 * Network access for the agent tools: public web pages, DNS over HTTPS and RDAP.
 * Everything goes through the Net interface so tests run without the network.
 */

export const USER_AGENT = "AutomatonAgentTools/1.0 (+AI agent; contact: automaton-revenue@agentmail.to)";
const MAX_BODY = 3_000_000;

export interface Page { status: number; finalUrl: string; contentType: string; headers: Record<string, string>; body: string; ms: number }
export interface DnsAnswer { name: string; type: number; data: string }

export interface Net {
  /** GET a public page (redirects followed, body capped). null when the host does not answer. */
  page(url: string): Promise<Page | null>;
  /** DNS records of one type; [] when none; null when the resolver failed. */
  dns(name: string, type: "A" | "AAAA" | "MX" | "NS" | "TXT" | "CNAME"): Promise<DnsAnswer[] | null>;
  /** RDAP JSON for a domain; null when no registry answered. */
  rdap(domain: string): Promise<Record<string, unknown> | null>;
}

/** Only public http(s) URLs; no credentials, no private, loopback or link-local hosts. */
export function validateTarget(raw: string | undefined | null): { ok: true; url: URL } | { ok: false; reason: string } {
  if (!raw || raw.length > 2048) return { ok: false, reason: "url is required (max 2048 characters)" };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "not a valid absolute URL (include https://)" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "only http and https URLs are accepted" };
  if (url.username || url.password) return { ok: false, reason: "URLs with credentials are not accepted" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || (!host.includes(".") && !host.includes(":"))) {
    return { ok: false, reason: "private hosts are not accepted" };
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const reserved = a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    if (reserved) return { ok: false, reason: "private or reserved IP addresses are not accepted" };
  }
  if (host.includes(":") && (host === "::1" || /^(fc|fd|fe80)/i.test(host))) return { ok: false, reason: "private IPv6 addresses are not accepted" };
  return { ok: true, url };
}

/** A registrable-looking public domain name (no scheme, path, port or IP). */
export function validateDomain(raw: string | undefined | null): { ok: true; domain: string } | { ok: false; reason: string } {
  let value = (raw ?? "").trim().toLowerCase();
  if (!value) return { ok: false, reason: "domain is required, e.g. example.com" };
  // Accept a pasted URL or an email address and keep only the host part.
  if (/^https?:\/\//.test(value)) { try { value = new URL(value).hostname; } catch { return { ok: false, reason: "not a valid domain" }; } }
  if (value.includes("@")) value = value.slice(value.lastIndexOf("@") + 1);
  value = value.replace(/\.$/, "");
  if (value.length > 253 || !/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value)) return { ok: false, reason: "not a valid domain name" };
  if (/^\d+(\.\d+){3}$/.test(value)) return { ok: false, reason: "IP addresses are not domains" };
  if (/\.(local|localhost|internal|test|invalid|example)$/.test(value)) return { ok: false, reason: "reserved or private domain" };
  if (!/\.[a-z][a-z0-9-]{1,62}$/.test(value)) return { ok: false, reason: "unknown top-level domain" };
  return { ok: true, domain: value };
}

const DNS_TYPES = { A: 1, AAAA: 28, MX: 15, NS: 2, TXT: 16, CNAME: 5 } as const;

export const liveNet: Net = {
  async page(url) {
    const start = Date.now();
    try {
      const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(10_000) });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      let body = "";
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          body += decoder.decode(value, { stream: true });
          if (size >= MAX_BODY) { await reader.cancel(); break; }
        }
      }
      return { status: res.status, finalUrl: res.url || url, contentType: headers["content-type"] ?? "", headers, body, ms: Date.now() - start };
    } catch {
      return null;
    }
  },
  async dns(name, type) {
    for (const resolver of ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"]) {
      try {
        const res = await fetch(`${resolver}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) });
        if (!res.ok) continue;
        const json = await res.json() as { Status: number; Answer?: { name: string; type: number; data: string }[] };
        if (json.Status !== 0 && json.Status !== 3) continue; // 3 = NXDOMAIN: a real, empty answer
        return (json.Answer ?? []).filter((a) => a.type === DNS_TYPES[type]).map((a) => ({ name: a.name, type: a.type, data: a.data }));
      } catch { /* try the next resolver */ }
    }
    return null;
  },
  async rdap(domain) {
    const headers = { Accept: "application/rdap+json, application/json", "User-Agent": USER_AGENT };
    const get = async (url: string) => {
      try {
        const res = await fetch(url, { redirect: "follow", headers, signal: AbortSignal.timeout(8_000) });
        return res.ok ? await res.json() as Record<string, unknown> : null;
      } catch {
        return null;
      }
    };
    // The registry itself first (IANA bootstrap), rdap.org as the fallback redirector.
    const tld = domain.slice(domain.lastIndexOf(".") + 1);
    const bootstrap = await get("https://data.iana.org/rdap/dns.json") as { services?: [string[], string[]][] } | null;
    const base = bootstrap?.services?.find(([tlds]) => tlds.includes(tld))?.[1]?.find((u) => u.startsWith("https://"));
    return (base ? await get(`${base.replace(/\/?$/, "/")}domain/${encodeURIComponent(domain)}`) : null) ?? await get(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
  },
};
