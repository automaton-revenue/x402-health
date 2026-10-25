import { describe, expect, it } from "vitest";
import { htmlToMarkdown, readPage } from "../src/reader.js";
import { checkEmail, parseEmail, suggestDomain } from "../src/email.js";
import { detectTechnologies, domainIntel } from "../src/domain.js";
import { validateDomain, type DnsAnswer, type Net, type Page } from "../src/net.js";

type Records = Record<string, DnsAnswer[] | null>;
function fakeNet(opts: { pages?: Record<string, Partial<Page> | null>; dns?: Records; rdap?: Record<string, unknown> | null } = {}): Net {
  return {
    async page(url) {
      const p = opts.pages?.[url];
      if (!p) return null;
      return { status: 200, finalUrl: url, contentType: "text/html; charset=utf-8", headers: {}, body: "", ms: 12, ...p };
    },
    async dns(name, type) { const key = `${name} ${type}`; return opts.dns && key in opts.dns ? opts.dns[key] : []; },
    async rdap() { return opts.rdap ?? null; },
  };
}
const rr = (name: string, type: number, data: string): DnsAnswer => ({ name, type, data });

const ARTICLE = `<!doctype html><html lang="en"><head><title>Tiny &amp; Fast</title><meta name="description" content="A test page">
<link rel="canonical" href="/post"><script>var x = 1;</script><style>p{}</style></head>
<body><nav><a href="/home">Home</a></nav><div class="cookie-banner">We use cookies</div>
<main><h1>Tiny &amp; Fast</h1><p>First paragraph with a <a href="/docs">docs link</a> and <strong>bold</strong> text, long enough to be the main region of this page for sure, really.</p>
<ul><li>one</li><li>two</li></ul><pre><code>npm i x</code></pre><img src="a.png" alt="diagram"></main><footer>© 2026 Footer</footer></body></html>`;

describe("page reader", () => {
  it("returns the main content as Markdown without navigation, scripts, banners or footer", async () => {
    const net = fakeNet({ pages: { "https://blog.example.org/post": { body: ARTICLE } } });
    const r = await readPage("https://blog.example.org/post", net);
    if ("error" in r) throw new Error(r.error);
    expect(r.title).toBe("Tiny & Fast");
    expect(r.description).toBe("A test page");
    expect(r.lang).toBe("en");
    expect(r.canonical).toBe("https://blog.example.org/post");
    expect(r.markdown).toContain("# Tiny & Fast");
    expect(r.markdown).toContain("[docs link](https://blog.example.org/docs)");
    expect(r.markdown).toContain("**bold**");
    expect(r.markdown).toContain("- one");
    expect(r.markdown).toContain("```\nnpm i x\n```");
    expect(r.markdown).toContain("[image: diagram]");
    for (const junk of ["var x", "Home", "cookies", "Footer"]) expect(r.markdown).not.toContain(junk);
    expect(r.links).toEqual([{ text: "docs link", href: "https://blog.example.org/docs" }]);
    expect(r.words).toBeGreaterThan(10);
  });

  it("reports unreachable sites, HTTP errors and binary content as errors (never charged)", async () => {
    expect(await readPage("https://down.example.org/", fakeNet())).toMatchObject({ error: expect.stringMatching(/did not answer/) });
    expect(await readPage("https://x.example.org/", fakeNet({ pages: { "https://x.example.org/": { status: 404 } } }))).toMatchObject({ status: 404 });
    expect(await readPage("https://x.example.org/f.pdf", fakeNet({ pages: { "https://x.example.org/f.pdf": { contentType: "application/pdf", body: "%PDF" } } }))).toMatchObject({ error: expect.stringMatching(/unsupported/) });
  });

  it("decodes numeric entities and keeps plain text pages as-is", async () => {
    expect(htmlToMarkdown("<body><p>caf&#233; &#x2014; ok</p></body>", "https://a.example.org/").markdown).toBe("café — ok");
    const r = await readPage("https://a.example.org/robots.txt", fakeNet({ pages: { "https://a.example.org/robots.txt": { contentType: "text/plain", body: "User-agent: *\n" } } }));
    expect(r).toMatchObject({ markdown: "User-agent: *" });
  });
});

describe("email check", () => {
  it("parses syntax strictly", () => {
    expect(parseEmail("a.b+tag@example.org").ok).toBe(true);
    for (const bad of ["", "no-at", "a..b@x.org", ".a@x.org", "a@x", "a@-x.org", "a b@x.org"]) expect(parseEmail(bad).ok).toBe(false);
  });

  it("suggests common-domain typos only for near misses", () => {
    expect(suggestDomain("gmial.com")).toBe("gmail.com");
    expect(suggestDomain("hotmial.com")).toBe("hotmail.com");
    expect(suggestDomain("gmail.com")).toBeNull();
    expect(suggestDomain("acme-corp.com")).toBeNull();
  });

  it("deliverable domain with MX, provider, SPF and DMARC", async () => {
    const net = fakeNet({ dns: {
      "acme.io MX": [rr("acme.io", 15, "1 aspmx.l.google.com."), rr("acme.io", 15, "5 alt1.aspmx.l.google.com.")],
      "acme.io TXT": [rr("acme.io", 16, '"v=spf1 include:_spf.google.com ~all"')],
      "_dmarc.acme.io TXT": [rr("_dmarc.acme.io", 16, '"v=DMARC1; p=reject; rua=mailto:d@acme.io"')],
    } });
    const r = await checkEmail("Jane@acme.io", net);
    if ("error" in r) throw new Error(r.error);
    expect(r.verdict).toBe("deliverable_domain");
    expect(r.mx[0]).toEqual({ priority: 1, host: "aspmx.l.google.com" });
    expect(r.mailProvider).toBe("Google Workspace");
    expect(r.spf).toBe(true);
    expect(r.dmarc).toBe("reject");
    expect(r.roleAccount).toBe(false);
  });

  it("flags disposable, role, typo and no-mail domains", async () => {
    const mx = (d: string) => ({ [`${d} MX`]: [rr(d, 15, `10 mx.${d}.`)] });
    const net = fakeNet({ dns: { ...mx("mailinator.com"), ...mx("gmial.com"), ...mx("shop.example.net"), "nomail.example.net MX": [rr("nomail.example.net", 15, "0 .")] } });
    expect(await checkEmail("x@mailinator.com", net)).toMatchObject({ verdict: "risky", disposable: true });
    expect(await checkEmail("jane@gmial.com", net)).toMatchObject({ verdict: "risky", suggestion: "jane@gmail.com" });
    expect(await checkEmail("info@shop.example.net", net)).toMatchObject({ verdict: "deliverable_domain", roleAccount: true });
    expect(await checkEmail("a@nomail.example.net", net)).toMatchObject({ verdict: "undeliverable", nullMx: true });
    expect(await checkEmail("a@ghost.example.net", net)).toMatchObject({ verdict: "undeliverable", acceptsMail: false });
  });

  it("a resolver failure is an error, not a verdict", async () => {
    const net = fakeNet({ dns: { "acme.io MX": null } });
    expect(await checkEmail("a@acme.io", net)).toEqual({ error: expect.stringMatching(/DNS/) });
  });
});

describe("domain intel", () => {
  it("validates domains and reduces URLs/emails to the domain", () => {
    expect(validateDomain("https://Shop.Acme.io/path")).toEqual({ ok: true, domain: "shop.acme.io" });
    expect(validateDomain("jane@acme.io")).toEqual({ ok: true, domain: "acme.io" });
    for (const bad of ["", "localhost", "1.2.3.4", "a..b.com", "-a.com", "x.local", "nodot"]) expect(validateDomain(bad).ok).toBe(false);
  });

  it("detects technologies from headers and HTML", () => {
    const tech = detectTechnologies({ server: "cloudflare", "cf-ray": "1", "x-powered-by": "PHP/8.2" }, '<link href="/wp-content/themes/x.css"><script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC"></script><script src="https://js.stripe.com/v3"></script>');
    expect(tech).toEqual(expect.arrayContaining(["Cloudflare", "PHP", "WordPress", "Google Tag Manager", "Stripe"]));
  });

  it("combines RDAP, DNS and homepage into one profile", async () => {
    const rdap = {
      events: [{ eventAction: "registration", eventDate: "2015-03-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-03-01T00:00:00Z" }],
      entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Namecheap, Inc."]]] }],
      status: ["client transfer prohibited"], nameservers: [{ ldhName: "ADA.NS.CLOUDFLARE.COM" }],
    };
    const net = fakeNet({
      rdap,
      dns: {
        "acme.io A": [rr("acme.io", 1, "104.21.1.1")], "acme.io NS": [rr("acme.io", 2, "ada.ns.cloudflare.com.")],
        "acme.io MX": [rr("acme.io", 15, "0 acme-io.mail.protection.outlook.com.")],
        "acme.io TXT": [rr("acme.io", 16, '"v=spf1 include:spf.protection.outlook.com -all"'), rr("acme.io", 16, '"google-site-verification=abc"'), rr("acme.io", 16, '"MS=ms123"')],
      },
      pages: { "https://acme.io/": { finalUrl: "https://acme.io/", headers: { server: "Vercel", "x-vercel-id": "1" }, body: '<title>Acme</title><meta name="description" content="We make things"><script src="/_next/static/x.js"></script>' } },
    });
    const r = await domainIntel("acme.io", net);
    if ("error" in r) throw new Error(r.error);
    expect(r.registered).toBe(true);
    expect(r.registration).toMatchObject({ registrar: "Namecheap, Inc.", created: "2015-03-01T00:00:00Z", expires: "2027-03-01T00:00:00Z" });
    expect(r.registration!.ageDays).toBeGreaterThan(3000);
    expect(r.dns.spf).toMatch(/^v=spf1/);
    expect(r.dns.verifications).toEqual(expect.arrayContaining(["google", "microsoft"]));
    expect(r.mailProvider).toBe("Microsoft 365");
    expect(r.dnsProvider).toBe("Cloudflare");
    expect(r.hosting).toBe("Vercel");
    expect(r.website).toMatchObject({ title: "Acme", description: "We make things", https: true });
    expect(r.website!.technologies).toEqual(expect.arrayContaining(["Vercel", "Next.js"]));
  });

  it("everything failing is an error (never charged)", async () => {
    const net: Net = { page: async () => null, dns: async () => null, rdap: async () => null };
    expect(await domainIntel("acme.io", net)).toEqual({ error: expect.stringMatching(/nothing was checked/) });
  });
});
