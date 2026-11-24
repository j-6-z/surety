// Shared look and <head> for every page: the homepage and the generated articles.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SITE_NAME = "Surety";
const ICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6E54FF"/><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 13l15 6v12c0 10-6 16-15 19-9-3-15-9-15-19V19z"/><path d="M25 31l5 5 9-10"/></g></svg>'
);

const DEFAULT_VAULT = "0xf3F9e32De47a143149F7398f25f264b98a01273C";

// The page's one ornament: a pale flower, drawn once and reused as a background.
// Sixteen petals in two rings. `tone` is the petal colour, `core` the centre.
function flower(tone, core) {
  const ring = (n, offset, d, opacity) =>
    Array.from({ length: n }, (_, i) => `<path transform="rotate(${offset + (360 / n) * i})" d="${d}" fill="${tone}" fill-opacity="${opacity}"/>`).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-110 -110 220 220">` +
    ring(8, 0, "M0 -14C20 -40 20 -78 0 -104C-20 -78 -20 -40 0 -14Z", ".5") +
    ring(8, 22.5, "M0 -10C13 -30 13 -56 0 -74C-13 -56 -13 -30 0 -10Z", ".75") +
    `<circle r="13" fill="${core}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const baseCss = `
:root{
  --ground:#FCFBFF;--panel:#FFFFFF;--ink:#15102E;--muted:#676183;--line:#E6E1F5;
  --purple:#6E54FF;--purple-deep:#4B34D6;--night:#1B1242;--night-line:#3A2F6E;--lilac:#C9BEFF;
  --pass:#0E9F6A;--pass-soft:#7FE7BE;--refund:#B86A00;--refund-soft:#FFC56B;
  --lift:0 1px 2px rgba(27,18,66,.05),0 14px 34px -22px rgba(27,18,66,.28);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:96px;overflow-x:hidden;overflow-x:clip}
body{margin:0;background:var(--ground);color:var(--ink);font-family:"Bricolage Grotesque",system-ui,sans-serif;font-size:18px;line-height:1.55;position:relative;overflow-x:hidden;overflow-x:clip}
/* The flower sits behind everything, mostly off the right edge, and turns very slowly. */
body::before{content:"";position:absolute;z-index:0;top:150px;right:-210px;width:640px;height:640px;pointer-events:none;
  background:${flower("#6E54FF", "#6E54FF")} center/contain no-repeat;opacity:.085;animation:bloom 240s linear infinite}
.wrap{position:relative;z-index:1}
a{color:var(--purple-deep);text-underline-offset:4px}
:focus-visible{outline:3px solid var(--purple);outline-offset:3px;border-radius:6px}
.mono,code{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.86em}
.wrap{max-width:1120px;margin:0 auto;padding:0 28px}
img,svg{max-width:100%}
table{border-collapse:collapse}
main{animation:arrive .55s cubic-bezier(.2,.7,.2,1) both}
@keyframes arrive{from{opacity:0;transform:translateY(10px)}}
@keyframes bloom{to{transform:rotate(360deg)}}
@media (max-width:860px){body::before{width:420px;height:420px;right:-190px;top:110px}}
@media (max-width:520px){body{font-size:17px}.wrap{padding:0 18px}body::before{width:320px;height:320px;right:-150px;opacity:.07}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}body::before,main{animation:none}}
`;

/**
 * Everything that belongs in <head>, including the tags search engines and link previews read.
 * @param {object} o
 * @param {string} o.title @param {string} o.description
 * @param {string} o.url            absolute address of this page (used as the canonical)
 * @param {string} o.siteUrl        site root, no trailing slash
 * @param {"website"|"article"} [o.type]
 * @param {object} [o.jsonLd]       schema.org data for this page
 * @param {string} [o.css]          page-specific styles, added after the shared ones
 * @param {string} [o.extra]        extra tags (feeds, article dates)
 */
function head(o) {
  const image = `${o.siteUrl}/og.png`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#6E54FF">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(o.url)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${o.type || "website"}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(o.url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="icon" href="${ICON}">
<link rel="alternate" type="application/rss+xml" title="${SITE_NAME} articles" href="${esc(o.siteUrl)}/rss.xml">
${o.extra || ""}${o.jsonLd ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, "\\u003c")}</script>\n` : ""}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>${baseCss}${o.css || ""}</style>`;
}

module.exports = { esc, head, baseCss, flower, ICON, SITE_NAME, DEFAULT_VAULT, DEFAULT_REPO: "https://github.com/j-6-z/surety" };
