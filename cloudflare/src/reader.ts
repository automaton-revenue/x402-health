/**
 * Page reader: one public URL in, the readable content out as Markdown plus
 * metadata (title, description, language, links). Boilerplate (scripts,
 * styles, navigation, footers, cookie banners, forms) is removed so an LLM
 * gets the article text, not the page chrome.
 */
import type { Net } from "./net.js";

export interface ReadResult {
  url: string; finalUrl: string; status: number; contentType: string;
  title: string | null; description: string | null; lang: string | null; canonical: string | null;
  markdown: string; words: number; truncated: boolean;
  links: { text: string; href: string }[];
  fetchedMs: number; readAt: string;
}

export const MAX_MARKDOWN = 100_000;
const MAX_LINKS = 100;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", bull: "•", middot: "·", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").trim() : null;
};

const meta = (html: string, key: string): string | null => {
  const re = /<meta\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    if ((attr(tag, "name") ?? attr(tag, "property") ?? "").toLowerCase() === key) return attr(tag, "content");
  }
  return null;
};

function resolve(href: string, base: string): string | null {
  if (!href || /^(javascript|mailto|tel|data):/i.test(href) || href.startsWith("#")) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}

/** Narrow to the main content when the page marks it (<main>, <article>, role=main). */
function mainRegion(html: string): string {
  for (const re of [/<main\b[^>]*>([\s\S]*?)<\/main>/i, /<[^>]+role\s*=\s*["']?main["']?[^>]*>([\s\S]*)/i, /<article\b[^>]*>([\s\S]*?)<\/article>/i]) {
    const m = re.exec(html);
    if (m && m[1].replace(/<[^>]+>/g, "").trim().length > 200) return m[1];
  }
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return body ? body[1] : html;
}

export function htmlToMarkdown(html: string, base: string): { markdown: string; links: { text: string; href: string }[] } {
  const links: { text: string; href: string }[] = [];
  let s = mainRegion(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|form|select|button|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(header)\b[^>]*>[\s\S]*?<\/header>/gi, (block) => (/<h1\b/i.test(block) ? block : ""))
    .replace(/<div\b[^>]*(cookie|consent|newsletter|popup|modal|banner|sidebar|share|social)[^>]*>[\s\S]*?<\/div>/gi, "");

  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_w, code: string) => `\n\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_w, code: string) => `\`${decodeEntities(code.replace(/<[^>]+>/g, "")).trim()}\``);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_w, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}\n\n`);
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_w, attrs: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const href = resolve(attr(`<a ${attrs}>`, "href") ?? "", base);
    if (!href || !text) return text;
    if (links.length < MAX_LINKS && !links.some((l) => l.href === href)) links.push({ text: text.slice(0, 200), href });
    return `[${text}](${href})`;
  });
  s = s.replace(/<img\b[^>]*>/gi, (tag) => { const alt = attr(tag, "alt"); return alt ? `[image: ${alt}]` : ""; });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**").replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_w, q: string) => `\n\n> ${q.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}\n\n`);
  s = s.replace(/<tr\b[^>]*>/gi, "\n| ").replace(/<\/t[dh]>/gi, " | ");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(p|div|section|article|ul|ol|table|tbody|thead|figure|figcaption|dl|dt|dd|hr)\b[^>]*>/gi, "\n\n");
  s = decodeEntities(s.replace(/<[^>]+>/g, ""));
  const markdown = s
    .split("\n").map((line) => line.replace(/[ \t ]+/g, " ").trimEnd()).map((line) => (/^\s*-\s*$/.test(line) ? "" : line))
    .join("\n").replace(/\n[ \t]+(?=\S)/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, links };
}

export async function readPage(target: string, net: Net): Promise<ReadResult | { error: string; status: number | null }> {
  const page = await net.page(target);
  if (!page) return { error: "the site did not answer; nothing was read", status: null };
  if (page.status >= 400) return { error: `the site answered HTTP ${page.status}`, status: page.status };
  const isHtml = /html|xml/i.test(page.contentType) || /^\s*<(!doctype|html)/i.test(page.body);
  const isText = /^text\/|json|markdown/i.test(page.contentType);
  if (!isHtml && !isText) return { error: `unsupported content type ${page.contentType || "unknown"} (HTML and text only)`, status: page.status };

  let title: string | null = null, description: string | null = null, lang: string | null = null, canonical: string | null = null;
  let markdown: string, links: { text: string; href: string }[] = [];
  if (isHtml) {
    const html = page.body;
    title = meta(html, "og:title") ?? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)![1]).replace(/\s+/g, " ").trim() : null);
    description = meta(html, "description") ?? meta(html, "og:description");
    lang = /<html\b[^>]*>/i.exec(html) ? attr(/<html\b[^>]*>/i.exec(html)![0], "lang") : null;
    const canon = /<link\b[^>]*rel\s*=\s*["']?canonical[^>]*>/i.exec(html);
    canonical = canon ? resolve(attr(canon[0], "href") ?? "", page.finalUrl) : null;
    ({ markdown, links } = htmlToMarkdown(html, page.finalUrl));
  } else {
    markdown = page.body.trim();
  }
  const truncated = markdown.length > MAX_MARKDOWN;
  if (truncated) markdown = markdown.slice(0, MAX_MARKDOWN);
  return {
    url: target, finalUrl: page.finalUrl, status: page.status, contentType: page.contentType,
    title: title || null, description: description || null, lang: lang || null, canonical,
    markdown, words: markdown.split(/\s+/).filter(Boolean).length, truncated, links,
    fetchedMs: page.ms, readAt: new Date().toISOString(),
  };
}
