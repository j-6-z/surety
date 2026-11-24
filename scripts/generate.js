// Builds the static, search-friendly part of the site into public/:
//
//   content/articles/*.md  ->  public/articles/<slug>/index.html   one page per article
//                              public/articles/index.html          the article list
//                              public/sitemap.xml, robots.txt, rss.xml
//
//   node scripts/generate.js            (also runs as `npm run build`, and on every Vercel deploy)
//
// To publish an article: add a Markdown file to content/articles/ that starts with
//   ---
//   title: ...
//   description: ...        (one or two sentences; this is the search-result snippet)
//   date: 2026-11-24
//   ---
// then run this and push. A file with `draft: true` is skipped.
//
// Scheduling: an article dated in the future is held back until that day. The
// held-back list is written to site/schedule.json, and the daily cron route
// (/cron/publish, see site/cron.js) triggers a rebuild on the day one is due.
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const { esc, head, SITE_NAME } = require("../site/theme");
const { nav, navCss } = require("../site/nav");
const { footer, footerCss } = require("../site/footer");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "content", "articles");
const PAGES_SRC = path.join(ROOT, "content", "pages");
const OUT = path.join(ROOT, "public");
const SITE_URL = (process.env.SITE_URL || process.env.PUBLIC_URL || "https://www.surety.buzz").replace(/\/+$/, "");
// Addresses the server answers itself (not files), listed so search engines find them.
const APP_PAGES = ["/", "/bond/", "/providers/"];

const ARTICLE_CSS = `
.post{max-width:720px;padding:34px 0 0}
.post header h1{font-size:clamp(34px,4.6vw,54px);line-height:1.04;letter-spacing:-.03em;margin:0 0 16px;font-weight:700}
.post .standfirst{font-size:21px;line-height:1.45;color:#3B3558;margin:0 0 14px}
.post .meta{color:var(--muted);font-size:15.5px;margin:0 0 34px;padding-bottom:22px;border-bottom:1px solid var(--line)}
.prose{font-size:19px;line-height:1.65}
.prose h2{font-size:28px;letter-spacing:-.02em;line-height:1.15;margin:44px 0 12px}
.prose h3{font-size:22px;letter-spacing:-.01em;margin:32px 0 8px}
.prose p{margin:0 0 20px}
.prose ul,.prose ol{margin:0 0 22px;padding-left:24px}
.prose li{margin-bottom:8px}
.prose code{background:#E9E4FA;padding:2px 6px;border-radius:5px;overflow-wrap:anywhere}
.prose pre{background:var(--night);color:#E9E4FF;padding:20px;border-radius:14px;overflow-x:auto;margin:0 0 24px;font-size:15px;line-height:1.6}
.prose pre code{background:none;padding:0;font-size:1em;overflow-wrap:normal}
.prose .tbl{overflow-x:auto;margin:0 0 24px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.prose table{width:100%;font-size:16.5px;line-height:1.45}
.prose th,.prose td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
.prose th{font-weight:500;color:var(--muted);font-size:15px;white-space:nowrap}
.prose tr:last-child td{border-bottom:0}
.prose td:first-child{white-space:nowrap}
.prose td code{background:none;padding:0}
.prose strong{font-weight:700}
@media (max-width:520px){.prose{font-size:17.5px}.prose h2{font-size:25px;margin-top:38px}.post .standfirst,.index .standfirst{font-size:19px}.prose td:first-child{white-space:normal}.demo-cta a{width:100%;text-align:center}}
.demo-cta{background:var(--night);color:#F3F0FF;border-radius:18px;padding:26px 28px;margin:48px 0 0;display:flex;flex-wrap:wrap;gap:16px 28px;align-items:center;justify-content:space-between}
.demo-cta p{margin:0;font-size:20px;font-weight:500;max-width:30ch;line-height:1.3}
.demo-cta a{background:var(--purple);color:#fff;text-decoration:none;font-weight:500;padding:13px 20px;border-radius:11px}
.demo-cta a:hover{background:#8169FF;color:#fff}
.more{margin:52px 0 0}
.more h2{font-size:20px;margin:0 0 6px}
.list{list-style:none;margin:0;padding:0}
.list li{padding:22px 0;border-bottom:1px solid var(--line)}
.list a.t{font-size:25px;font-weight:700;letter-spacing:-.02em;line-height:1.2;text-decoration:none;color:var(--ink)}
.list a.t:hover{color:var(--purple-deep)}
.list p{margin:6px 0 4px;color:#443E62;max-width:64ch}
.list small{color:var(--muted);font-size:15px}
.index{max-width:820px;padding:34px 0 0}
.index h1{font-size:clamp(38px,5vw,60px);line-height:1.02;letter-spacing:-.03em;margin:0 0 12px}
.index .standfirst{font-size:21px;color:#3B3558;margin:0 0 18px;max-width:54ch}
`;

// Headings get an id so other pages can link straight to a section.
const slugify = (t) => t.replace(/<[^>]+>/g, "").toLowerCase().replace(/&[a-z#0-9]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const render = (md) =>
  marked.parse(md)
    .replace(/<table>/g, '<div class="tbl"><table>').replace(/<\/table>/g, "</table></div>")
    .replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, n, inner) => `<h${n} id="${slugify(inner)}">${inner}</h${n}>`);
const plain = (html) => html.replace(/<\/(p|li|h\d|tr|td|th|div|pre)>|<br\s*\/?>/g, " ").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

function parse(file, src = SRC) {
  const raw = fs.readFileSync(path.join(src, file), "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing the --- header block`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  const isPage = src !== SRC && path.basename(src) === "pages";
  for (const key of isPage ? ["title", "description"] : ["title", "description", "date"]) if (!meta[key]) throw new Error(`${file}: header needs "${key}"`);
  if (meta.date && (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date) || Number.isNaN(Date.parse(meta.date)))) throw new Error(`${file}: date must be YYYY-MM-DD`);
  if (meta.description.length > 170) console.warn(`  note: ${file} description is ${meta.description.length} characters; search results cut off around 160`);
  const slug = (meta.slug || file.replace(/\.md$/, "")).toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`${file}: slug "${slug}" must be lowercase words joined by hyphens`);
  const words = m[2].split(/\s+/).filter(Boolean).length;
  return { ...meta, slug, body: m[2], words, minutes: Math.max(1, Math.round(words / 220)), draft: meta.draft === "true", path: isPage ? `/${slug}/` : `/articles/${slug}/` };
}

const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

function page({ title, description, url, type, jsonLd, extra, main, current = "articles" }) {
  return `<!doctype html>
<html lang="en">
<head>
${head({ title, description, url, siteUrl: SITE_URL, type, jsonLd, extra, css: navCss + footerCss + ARTICLE_CSS })}
</head>
<body>
<div class="wrap">
${nav({ current })}
<main>
${main}
</main>
${footer()}
</div>
</body>
</html>
`;
}

function articlePage(a, all) {
  const url = SITE_URL + a.path;
  const others = all.filter((o) => o.slug !== a.slug).slice(0, 3);
  return page({
    title: `${a.title} | ${SITE_NAME}`,
    description: a.description,
    url,
    type: "article",
    extra: `<meta property="article:published_time" content="${a.date}">\n`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: a.title,
      description: a.description,
      datePublished: a.date,
      dateModified: a.updated || a.date,
      mainEntityOfPage: url,
      image: `${SITE_URL}/og.png`,
      author: { "@type": "Organization", name: SITE_NAME, url: `${SITE_URL}/` },
      publisher: { "@type": "Organization", name: SITE_NAME, url: `${SITE_URL}/` },
    },
    main: `<article class="post">
  <header>
    <h1>${esc(a.title)}</h1>
    <p class="standfirst">${esc(a.description)}</p>
    <p class="meta"><time datetime="${a.date}">${longDate(a.date)}</time>, ${a.minutes} minute read</p>
  </header>
  <div class="prose">
${render(a.body)}
  </div>
  <aside class="demo-cta"><p>Watch a refund happen on-chain, no wallet needed.</p><a href="/#demo">Run the live demo</a></aside>
  ${others.length ? `<section class="more"><h2>Keep reading</h2><ul class="list">${others.map(listItem).join("")}</ul></section>` : ""}
</article>`,
  });
}

/// A standing page (How it works, Docs, FAQ) from content/pages/.
function standingPage(p) {
  const url = SITE_URL + p.path;
  let jsonLd = { "@context": "https://schema.org", "@type": "WebPage", name: p.title, description: p.description, url };
  if (p.type === "faq") {
    const items = p.body.split(/\n(?=## )/).filter((b) => b.startsWith("## ")).map((b) => {
      const nl = b.indexOf("\n");
      return { q: b.slice(3, nl).trim(), a: plain(marked.parse(b.slice(nl + 1))) };
    });
    jsonLd = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: items.map((i) => ({ "@type": "Question", name: i.q, acceptedAnswer: { "@type": "Answer", text: i.a } })),
    };
  }
  return page({
    title: `${p.title} | ${SITE_NAME}`,
    description: p.description,
    url,
    jsonLd,
    current: p.nav || "",
    main: `<article class="post">
  <header>
    <h1>${esc(p.title)}</h1>
    <p class="standfirst">${esc(p.description)}</p>
  </header>
  <div class="prose">
${render(p.body)}
  </div>
  <aside class="demo-cta"><p>Watch a refund happen on-chain, no wallet needed.</p><a href="/#demo">Run the live demo</a></aside>
</article>`,
  });
}

const listItem = (a) =>
  `<li><a class="t" href="${a.path}">${esc(a.title)}</a><p>${esc(a.description)}</p><small><time datetime="${a.date}">${longDate(a.date)}</time>, ${a.minutes} minute read</small></li>`;

function indexPage(all) {
  const description = "Plain-language writing on paying AI agents fairly: x402 payments, refunds, provider bonds, and how Surety works.";
  return page({
    title: `Articles | ${SITE_NAME}`,
    description,
    url: `${SITE_URL}/articles/`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Blog",
      name: `${SITE_NAME} articles`,
      url: `${SITE_URL}/articles/`,
      blogPost: all.map((a) => ({ "@type": "BlogPosting", headline: a.title, url: SITE_URL + a.path, datePublished: a.date })),
    },
    main: `<div class="index">
  <h1>Articles</h1>
  <p class="standfirst">${esc(description)}</p>
  ${all.length ? `<ul class="list">${all.map(listItem).join("")}</ul>` : "<p>No articles yet.</p>"}
</div>`,
  });
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function sitemap(all, pages = []) {
  const newest = all[0] ? all[0].date : new Date().toISOString().slice(0, 10);
  const entries = [
    ...APP_PAGES.map((p) => ({ loc: SITE_URL + p, lastmod: newest })),
    ...pages.map((p) => ({ loc: SITE_URL + p.path, lastmod: p.updated || newest })),
    { loc: `${SITE_URL}/articles/`, lastmod: newest },
    ...all.map((a) => ({ loc: SITE_URL + a.path, lastmod: a.updated || a.date })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url><loc>${xml(e.loc)}</loc><lastmod>${e.lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
}

function rss(all) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${SITE_NAME} articles</title>
  <link>${SITE_URL}/articles/</link>
  <description>Writing on x402 payments, refunds and provider bonds.</description>
  <language>en</language>
  <atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml"/>
${all.map((a) => `  <item>
    <title>${xml(a.title)}</title>
    <link>${SITE_URL}${a.path}</link>
    <guid isPermaLink="true">${SITE_URL}${a.path}</guid>
    <pubDate>${new Date(`${a.date}T12:00:00Z`).toUTCString()}</pubDate>
    <description>${xml(a.description)}</description>
  </item>`).join("\n")}
</channel>
</rss>
`;
}

// The relay and demo routes are for agents and visitors, not for search results.
const robots = () => `User-agent: *
Allow: /
Disallow: /call/
Disallow: /trust/
Disallow: /demo/

Sitemap: ${SITE_URL}/sitemap.xml
`;

/**
 * @param {object} [o]
 * @param {string} [o.src] @param {string} [o.out]   folders to read from and write to
 * @param {string} [o.pagesSrc]                      folder of standing pages (How it works, Docs, FAQ)
 * @param {string} [o.scheduleFile]                  where the held-back list is written
 * @param {string} [o.today]                         YYYY-MM-DD (UTC); articles dated after it are held back
 */
function build({ log = console.log, src = SRC, out = OUT, pagesSrc = PAGES_SRC, scheduleFile = path.join(ROOT, "site", "schedule.json"), today = new Date().toISOString().slice(0, 10) } = {}) {
  const write = (rel, text) => {
    const file = path.join(out, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const files = fs.existsSync(src) ? fs.readdirSync(src).filter((f) => f.endsWith(".md")) : [];
  const ready = files.map((f) => parse(f, src)).filter((a) => !a.draft);
  const scheduled = ready.filter((a) => a.date > today).map((a) => ({ slug: a.slug, date: a.date })).sort((a, b) => (a.date < b.date ? -1 : 1));
  const all = ready.filter((a) => a.date <= today).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)));
  const slugs = new Set();
  for (const a of all) {
    if (slugs.has(a.slug)) throw new Error(`two articles share the slug "${a.slug}"`);
    slugs.add(a.slug);
  }
  fs.rmSync(path.join(out, "articles"), { recursive: true, force: true }); // drop pages for deleted articles
  for (const a of all) write(`articles/${a.slug}/index.html`, articlePage(a, all));
  write("articles/index.html", indexPage(all));
  const RESERVED = new Set(["articles", "providers", "bond", "call", "trust", "demo", "cron", "v1", "health"]);
  const pages = (fs.existsSync(pagesSrc) ? fs.readdirSync(pagesSrc).filter((f) => f.endsWith(".md")) : [])
    .map((f) => parse(f, pagesSrc)).filter((p) => !p.draft).sort((a, b) => Number(a.order || 99) - Number(b.order || 99));
  for (const p of pages) {
    if (RESERVED.has(p.slug)) throw new Error(`a page cannot be called "${p.slug}": that address is already in use`);
    write(`${p.slug}/index.html`, standingPage(p));
  }
  write("sitemap.xml", sitemap(all, pages));
  write("rss.xml", rss(all));
  write("robots.txt", robots());
  fs.writeFileSync(scheduleFile, JSON.stringify({ scheduled }, null, 2) + "\n");
  log(`Built ${all.length} article${all.length === 1 ? "" : "s"} for ${SITE_URL}`);
  for (const a of all) log(`  ${a.path}  (${a.words} words)`);
  for (const a of scheduled) log(`  held until ${a.date}: ${a.slug}`);
  for (const p of pages) log(`  ${p.path}  (page, ${p.words} words)`);
  return { published: all, scheduled, pages };
}

module.exports = { build, parse };

if (require.main === module) {
  try {
    build();
  } catch (e) {
    console.error(`generate failed: ${e.message}`);
    process.exit(1);
  }
}
