/**
 * Domain intel from public sources only: RDAP registration data (registrar,
 * created/expires, age, status), DNS (A/AAAA/MX/NS/TXT, SPF, DMARC, mail and
 * DNS providers) and the homepage (title, description, server and detected
 * technologies). No private data, no scraping beyond one homepage request.
 */
import { mailProviderOf } from "./email.js";
import type { Net } from "./net.js";

export interface DomainResult {
  domain: string; registered: boolean | null;
  registration: { registrar: string | null; created: string | null; updated: string | null; expires: string | null; ageDays: number | null; status: string[]; nameservers: string[] } | null;
  dns: { a: string[]; aaaa: string[]; mx: string[]; ns: string[]; txtCount: number; spf: string | null; dmarc: string | null; verifications: string[] };
  mailProvider: string | null; dnsProvider: string | null; hosting: string | null;
  website: { url: string; status: number; title: string | null; description: string | null; server: string | null; technologies: string[]; https: boolean } | null;
  checkedAt: string;
}

function eventDate(rdap: Record<string, unknown>, action: string): string | null {
  const events = Array.isArray(rdap.events) ? rdap.events as { eventAction?: string; eventDate?: string }[] : [];
  return events.find((e) => e.eventAction === action)?.eventDate ?? null;
}

function registrarOf(rdap: Record<string, unknown>): string | null {
  const entities = Array.isArray(rdap.entities) ? rdap.entities as { roles?: string[]; vcardArray?: unknown[]; handle?: string }[] : [];
  const reg = entities.find((e) => e.roles?.includes("registrar"));
  if (!reg) return null;
  const card = Array.isArray(reg.vcardArray?.[1]) ? reg.vcardArray![1] as unknown[][] : [];
  const fn = card.find((f) => f[0] === "fn");
  return (fn?.[3] as string | undefined) ?? reg.handle ?? null;
}

export function dnsProviderOf(ns: string[]): string | null {
  const joined = ns.join(" ").toLowerCase();
  const map: [RegExp, string][] = [
    [/cloudflare\.com/, "Cloudflare"], [/awsdns/, "Amazon Route 53"], [/googledomains\.com|google\.com/, "Google Cloud DNS"], [/azure-dns/, "Azure DNS"],
    [/domaincontrol\.com/, "GoDaddy"], [/registrar-servers\.com/, "Namecheap"], [/nsone\.net/, "NS1"], [/dnsimple/, "DNSimple"], [/vercel-dns/, "Vercel"],
    [/netlify/, "Netlify"], [/digitalocean\.com/, "DigitalOcean"], [/hetzner/, "Hetzner"], [/ovh\.net/, "OVH"], [/linode/, "Akamai Linode"],
    [/wixdns\.net/, "Wix"], [/squarespacedns|squarespace/, "Squarespace"], [/shopify/, "Shopify"], [/home\.pl/, "home.pl"], [/ultradns/, "UltraDNS"], [/akam/, "Akamai"],
  ];
  for (const [re, name] of map) if (re.test(joined)) return name;
  return null;
}

/** Technology fingerprints from response headers and HTML markers (homepage only). */
export function detectTechnologies(headers: Record<string, string>, html: string): string[] {
  const h = (k: string) => headers[k] ?? "";
  const found = new Set<string>();
  const add = (cond: boolean, name: string) => { if (cond) found.add(name); };
  add(/cloudflare/i.test(h("server")) || "cf-ray" in headers, "Cloudflare");
  add(/vercel/i.test(h("server")) || "x-vercel-id" in headers, "Vercel");
  add(/netlify/i.test(h("server")) || "x-nf-request-id" in headers, "Netlify");
  add("x-amz-cf-id" in headers, "Amazon CloudFront");
  add(/github\.com/i.test(h("server")), "GitHub Pages");
  add(/nginx/i.test(h("server")), "nginx");
  add(/apache/i.test(h("server")), "Apache");
  add(/litespeed/i.test(h("server")), "LiteSpeed");
  add(/microsoft-iis/i.test(h("server")), "IIS");
  add(/php/i.test(h("x-powered-by")), "PHP");
  add(/express/i.test(h("x-powered-by")), "Express");
  add(/asp\.net/i.test(h("x-powered-by")) || "x-aspnet-version" in headers, "ASP.NET");
  add(/next\.js/i.test(h("x-powered-by")) || /\/_next\/static\//.test(html), "Next.js");
  add(/wp-content\/|wp-includes\//.test(html), "WordPress");
  add(/woocommerce/i.test(html), "WooCommerce");
  add(/cdn\.shopify\.com|Shopify\.theme/.test(html), "Shopify");
  add(/static\.wixstatic\.com|wix\.com/.test(html), "Wix");
  add(/squarespace\.com|static1\.squarespace/.test(html), "Squarespace");
  add(/webflow\.(com|io)|data-wf-page/.test(html), "Webflow");
  add(/framerusercontent\.com|framer\.com/.test(html), "Framer");
  add(/ghost\.(io|org)|content="Ghost/.test(html), "Ghost");
  add(/Drupal|drupal\.js/.test(html), "Drupal");
  add(/\/media\/jui\/|Joomla/.test(html), "Joomla");
  add(/__NUXT__|\/_nuxt\//.test(html), "Nuxt");
  add(/___gatsby|gatsby-/.test(html), "Gatsby");
  add(/astro-island|\/_astro\//.test(html), "Astro");
  add(/data-reactroot|react-dom|__REACT/.test(html), "React");
  add(/ng-version=|ng-app/.test(html), "Angular");
  add(/data-v-[0-9a-f]{6,}|vue(\.min)?\.js/.test(html), "Vue");
  add(/jquery(\.min)?\.js|jQuery/.test(html), "jQuery");
  add(/bootstrap(\.min)?\.(css|js)/.test(html), "Bootstrap");
  add(/tailwind|class="[^"]*\b(?:flex|grid) [^"]*\b(?:px|py|mt|mb)-\d/.test(html), "Tailwind CSS");
  add(/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/.test(html), "Google Tag Manager");
  add(/googletagmanager\.com\/gtag\/js|google-analytics\.com/.test(html), "Google Analytics");
  add(/plausible\.io\/js/.test(html), "Plausible");
  add(/connect\.facebook\.net/.test(html), "Meta Pixel");
  add(/js\.hs-scripts\.com|hubspot/i.test(html), "HubSpot");
  add(/widget\.intercom\.io|intercomSettings/.test(html), "Intercom");
  add(/js\.stripe\.com/.test(html), "Stripe");
  add(/hcaptcha\.com|google\.com\/recaptcha/.test(html), "CAPTCHA");
  add(/cdn\.cookielaw\.org|cookiebot/i.test(html), "Cookie consent (OneTrust/Cookiebot)");
  return [...found].sort();
}

export async function domainIntel(domain: string, net: Net): Promise<DomainResult | { error: string }> {
  const [rdap, a, aaaa, mx, ns, txt, dmarcTxt] = await Promise.all([
    net.rdap(domain), net.dns(domain, "A"), net.dns(domain, "AAAA"), net.dns(domain, "MX"), net.dns(domain, "NS"), net.dns(domain, "TXT"), net.dns(`_dmarc.${domain}`, "TXT"),
  ]);
  if (a === null && ns === null && rdap === null) return { error: "neither DNS nor the registry answered; nothing was checked" };

  const unquote = (s: string) => s.replace(/^"|"$/g, "").replace(/"\s*"/g, "");
  const txtValues = (txt ?? []).map((t) => unquote(t.data));
  const mxHosts = (mx ?? []).map((m) => m.data.split(/\s+/).slice(1).join(" ").replace(/\.$/, "").toLowerCase()).filter(Boolean);
  const nsHosts = (ns ?? []).map((n) => n.data.replace(/\.$/, "").toLowerCase());
  const verifications = txtValues.map((t) => /^([a-z0-9-]+?)-(?:site-|domain-)?verification=/i.exec(t)?.[1]?.toLowerCase() ?? (/^MS=/i.test(t) ? "microsoft" : null)).filter((v): v is string => !!v);

  let registration: DomainResult["registration"] = null;
  if (rdap) {
    const created = eventDate(rdap, "registration");
    const nsFromRdap = Array.isArray(rdap.nameservers) ? (rdap.nameservers as { ldhName?: string }[]).map((n) => (n.ldhName ?? "").toLowerCase()).filter(Boolean) : [];
    registration = {
      registrar: registrarOf(rdap), created, updated: eventDate(rdap, "last changed"), expires: eventDate(rdap, "expiration"),
      ageDays: created ? Math.floor((Date.now() - Date.parse(created)) / 86_400_000) : null,
      status: Array.isArray(rdap.status) ? rdap.status as string[] : [], nameservers: nsFromRdap,
    };
  }

  let website: DomainResult["website"] = null;
  let page = await net.page(`https://${domain}/`);
  let https = !!page;
  if (!page) { page = await net.page(`http://${domain}/`); https = false; }
  if (page) {
    const html = page.body.slice(0, 1_000_000);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
    const desc = /<meta[^>]+name\s*=\s*["']?description["']?[^>]*content\s*=\s*["']([^"']*)["']/i.exec(html)?.[1]?.trim() || null;
    website = { url: page.finalUrl, status: page.status, title, description: desc, server: page.headers["server"] ?? null, technologies: detectTechnologies(page.headers, html), https: https && page.finalUrl.startsWith("https:") };
  }

  const tech = website?.technologies ?? [];
  const hosting = ["Vercel", "Netlify", "GitHub Pages", "Shopify", "Wix", "Squarespace", "Webflow", "Framer", "Amazon CloudFront", "Cloudflare"].find((t) => tech.includes(t)) ?? null;

  return {
    domain,
    registered: rdap ? true : (a?.length || ns?.length ? true : (a !== null && ns !== null ? false : null)),
    registration,
    dns: {
      a: (a ?? []).map((r) => r.data), aaaa: (aaaa ?? []).map((r) => r.data), mx: mxHosts, ns: nsHosts, txtCount: txtValues.length,
      spf: txtValues.find((t) => /^v=spf1\b/i.test(t)) ?? null,
      dmarc: (dmarcTxt ?? []).map((t) => unquote(t.data)).find((t) => /^v=DMARC1/i.test(t)) ?? null,
      verifications: [...new Set(verifications)],
    },
    mailProvider: mailProviderOf(mxHosts), dnsProvider: dnsProviderOf(nsHosts.length ? nsHosts : registration?.nameservers ?? []), hosting,
    website, checkedAt: new Date().toISOString(),
  };
}
