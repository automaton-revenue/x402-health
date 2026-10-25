/**
 * Email check without sending mail: syntax, domain mail routing (MX, or the
 * A-record fallback of RFC 5321), disposable/free/role classification, typo
 * suggestions and the domain's SPF/DMARC posture. No SMTP probing (Workers
 * cannot open port 25, and probing mailboxes annoys receivers), so a "valid"
 * verdict means "this domain accepts mail", never "this mailbox exists".
 */
import { validateDomain, type Net } from "./net.js";

export type Verdict = "deliverable_domain" | "risky" | "undeliverable" | "invalid";

export interface EmailResult {
  email: string; normalized: string; local: string; domain: string;
  verdict: Verdict; reasons: string[];
  syntaxValid: boolean; mx: { host: string; priority: number }[]; acceptsMail: boolean | null; nullMx: boolean;
  disposable: boolean; freeProvider: boolean; roleAccount: boolean;
  suggestion: string | null; mailProvider: string | null;
  spf: boolean | null; dmarc: string | null;
  checkedAt: string;
}

// Widely used throwaway-mail domains (the long tail changes daily; this list covers the common services).
export const DISPOSABLE = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "33mail.com", "anonaddy.me", "burnermail.io", "discard.email", "dispostable.com",
  "dropmail.me", "emailondeck.com", "fakeinbox.com", "fakemail.net", "getairmail.com", "getnada.com", "guerrillamail.biz", "guerrillamail.com",
  "guerrillamail.de", "guerrillamail.info", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "harakirimail.com", "inboxbear.com",
  "inboxkitten.com", "mail.tm", "mail-temp.com", "mailcatch.com", "maildrop.cc", "mailinator.com", "mailinator.net", "mailinator2.com",
  "mailnesia.com", "mailpoof.com", "mailsac.com", "mintemail.com", "moakt.com", "mohmal.com", "mytemp.email", "nada.email", "sharklasers.com",
  "spam4.me", "spambox.us", "spamgourmet.com", "temp-mail.io", "temp-mail.org", "tempail.com", "tempmail.com", "tempmail.dev", "tempmail.net",
  "tempmailo.com", "tempr.email", "throwawaymail.com", "tmail.ws", "tmpmail.net", "tmpmail.org", "trashmail.com", "trashmail.de", "trashmail.net",
  "yopmail.com", "yopmail.fr", "yopmail.net", "emailfake.com", "fakemailgenerator.com", "minuteinbox.com", "mail7.io", "linshiyouxiang.net",
  "byom.de", "trbvm.com", "grr.la", "pokemail.net", "spamdecoy.net", "mailforspam.com", "incognitomail.org", "jetable.org", "mvrht.net",
  "emltmp.com", "tempinbox.com", "fexbox.org", "rootfest.net", "zeroe.ml", "cuvox.de", "armyspy.com", "dayrep.com", "einrot.com", "fleckens.hu",
  "gustr.com", "jourrapide.com", "rhyta.com", "superrito.com", "teleworm.us",
]);

export const FREE_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "ymail.com", "outlook.com", "hotmail.com", "hotmail.co.uk",
  "hotmail.fr", "hotmail.de", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "126.com",
  "wp.pl", "o2.pl", "onet.pl", "interia.pl", "op.pl", "tutanota.com", "tuta.io", "fastmail.com", "hey.com", "libero.it", "orange.fr", "free.fr",
  "laposte.net", "t-online.de", "seznam.cz", "naver.com", "rediffmail.com",
]);

const ROLE_LOCALS = new Set([
  "admin", "administrator", "billing", "contact", "enquiries", "help", "hello", "hi", "hostmaster", "info", "jobs", "careers", "legal", "mail",
  "marketing", "media", "noreply", "no-reply", "donotreply", "do-not-reply", "office", "postmaster", "press", "privacy", "root", "sales",
  "security", "support", "team", "abuse", "webmaster", "accounts", "accounting", "hr", "orders", "service", "feedback", "newsletter",
]);

const POPULAR = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "protonmail.com", "gmx.com", "live.com", "googlemail.com", "proton.me", "wp.pl", "onet.pl", "interia.pl", "o2.pl", "yandex.com", "mail.ru", "web.de"];

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

/** "gmial.com" → "gmail.com"; only for near-misses of very common mail domains. */
export function suggestDomain(domain: string): string | null {
  if (POPULAR.includes(domain)) return null;
  let best: string | null = null;
  let bestD = 3;
  for (const candidate of POPULAR) {
    const d = distance(domain, candidate);
    if (d < bestD && d <= (candidate.length > 8 ? 2 : 1)) { best = candidate; bestD = d; }
  }
  return best;
}

export function mailProviderOf(mxHosts: string[]): string | null {
  const joined = mxHosts.join(" ").toLowerCase();
  const providers: [RegExp, string][] = [
    [/google\.com|googlemail\.com/, "Google Workspace"], [/outlook\.com|protection\.outlook/, "Microsoft 365"], [/zoho\./, "Zoho Mail"],
    [/protonmail\.ch|proton\.me/, "Proton Mail"], [/messagingengine\.com/, "Fastmail"], [/yahoodns\.net/, "Yahoo"], [/icloud\.com|apple\.com/, "iCloud"],
    [/mimecast\./, "Mimecast"], [/pphosted\.com/, "Proofpoint"], [/secureserver\.net/, "GoDaddy"], [/ovh\.net/, "OVH"], [/mailgun\.org/, "Mailgun"],
    [/sendgrid\.net/, "SendGrid"], [/amazonaws\.com|amazonses/, "Amazon SES/WorkMail"], [/yandex\./, "Yandex"], [/home\.pl/, "home.pl"],
    [/emailsrvr\.com/, "Rackspace"], [/improvmx\.com/, "ImprovMX"], [/forwardemail\.net/, "Forward Email"], [/mx\.cloudflare\.net/, "Cloudflare Email Routing"],
  ];
  for (const [re, name] of providers) if (re.test(joined)) return name;
  return null;
}

const SYNTAX = /^(?!\.)(?!.*\.\.)[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}(?<!\.)@[^@\s]+$/i;

export function parseEmail(raw: string | undefined | null): { ok: true; email: string; local: string; domain: string } | { ok: false; reason: string } {
  const email = (raw ?? "").trim();
  if (!email) return { ok: false, reason: "email is required" };
  if (email.length > 254) return { ok: false, reason: "email longer than 254 characters" };
  if (!SYNTAX.test(email)) return { ok: false, reason: "not a syntactically valid email address" };
  const at = email.lastIndexOf("@");
  const domain = validateDomain(email.slice(at + 1));
  if (!domain.ok) return { ok: false, reason: `invalid domain: ${domain.reason}` };
  return { ok: true, email, local: email.slice(0, at), domain: domain.domain };
}

export async function checkEmail(raw: string, net: Net): Promise<EmailResult | { error: string }> {
  const parsed = parseEmail(raw);
  const now = new Date().toISOString();
  if (!parsed.ok) {
    return {
      email: raw, normalized: raw.trim().toLowerCase(), local: "", domain: "", verdict: "invalid", reasons: [parsed.reason],
      syntaxValid: false, mx: [], acceptsMail: null, nullMx: false, disposable: false, freeProvider: false, roleAccount: false,
      suggestion: null, mailProvider: null, spf: null, dmarc: null, checkedAt: now,
    };
  }
  const { local, domain } = parsed;
  const [mxAnswers, aAnswers, txt, dmarcTxt] = await Promise.all([net.dns(domain, "MX"), net.dns(domain, "A"), net.dns(domain, "TXT"), net.dns(`_dmarc.${domain}`, "TXT")]);
  if (mxAnswers === null) return { error: "DNS lookup failed; nothing was checked" };

  const mx = mxAnswers.map((a) => { const [p, ...host] = a.data.split(/\s+/); return { priority: Number(p), host: host.join(" ").replace(/\.$/, "").toLowerCase() }; })
    .sort((x, y) => x.priority - y.priority);
  const nullMx = mx.length === 1 && (mx[0].host === "" || mx[0].host === ".");
  const acceptsMail = nullMx ? false : mx.length > 0 ? true : (aAnswers?.length ?? 0) > 0;
  const unquote = (s: string) => s.replace(/^"|"$/g, "").replace(/"\s*"/g, "");
  const spf = txt === null ? null : txt.some((t) => /^v=spf1\b/i.test(unquote(t.data)));
  const dmarcRecord = dmarcTxt?.map((t) => unquote(t.data)).find((t) => /^v=DMARC1/i.test(t)) ?? null;
  const dmarc = dmarcRecord ? (/\bp=(none|quarantine|reject)\b/i.exec(dmarcRecord)?.[1]?.toLowerCase() ?? "present") : (dmarcTxt === null ? null : "none-published");

  const disposable = DISPOSABLE.has(domain) || [...DISPOSABLE].some((d) => domain.endsWith(`.${d}`));
  const freeProvider = FREE_PROVIDERS.has(domain);
  const roleAccount = ROLE_LOCALS.has(local.toLowerCase().split("+")[0]);
  const suggestion = suggestDomain(domain);

  const reasons: string[] = [];
  let verdict: Verdict = "deliverable_domain";
  if (!acceptsMail) { verdict = "undeliverable"; reasons.push(nullMx ? "domain publishes a null MX (accepts no mail)" : "domain has no MX or A record"); }
  else {
    reasons.push(mx.length ? `domain accepts mail (${mx.length} MX)` : "no MX; mail falls back to the A record");
    if (disposable) { verdict = "risky"; reasons.push("disposable / throwaway mail service"); }
    if (suggestion) { verdict = "risky"; reasons.push(`possible typo of ${suggestion}`); }
    if (roleAccount) reasons.push("role account (shared inbox, not a person)");
    if (!mx.length) { verdict = "risky"; }
  }
  reasons.push("mailbox existence is not probed (no SMTP)");

  return {
    email: raw, normalized: `${local}@${domain}`, local, domain, verdict, reasons,
    syntaxValid: true, mx, acceptsMail, nullMx, disposable, freeProvider, roleAccount,
    suggestion: suggestion ? `${local}@${suggestion}` : null, mailProvider: mailProviderOf(mx.map((m) => m.host)),
    spf, dmarc, checkedAt: now,
  };
}
