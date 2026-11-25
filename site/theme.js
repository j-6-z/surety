// Shared look and <head> for every page: the homepage and the generated articles.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SITE_NAME = "Surety";
// The mark: a white shield on a purple-to-pink ground, with the check drawn in the same gradient.
const MARK = '<defs><linearGradient id="surety-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6E54FF"/><stop offset=".55" stop-color="#A94BF3"/><stop offset="1" stop-color="#FF5FA8"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#surety-g)"/><path d="M32 11.5l16.5 6.6v12.4c0 10.8-6.8 17.6-16.5 20.9-9.7-3.3-16.5-10.1-16.5-20.900V18.1z" fill="#fff"/><path d="M24.3 31.4l5.6 5.6 10-10.800" fill="none" stroke="url(#surety-g)" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${MARK}</svg>`);

const { networkFromEnv, NETWORKS } = require("../networks");

// The network the pages describe. Set once from SURETY_NETWORK; the server calls
// useNetwork() so what it says always matches the chain it is actually running on.
let NET;
try {
  NET = networkFromEnv();
} catch {
  NET = { ...NETWORKS.testnet, facilitatorUrl: "" };
}
/** @param {object} profile  a network profile (or part of one) to describe from now on */
function useNetwork(profile) {
  Object.assign(NET, profile);
  return NET;
}

// The page's one ornament: a pale flower, drawn once and reused as a background.
// Sixteen petals in two rings. `tone` is the petal colour, `core` the centre.
function flower(tone, core, inner = tone) {
  const ring = (n, offset, d, opacity, fill) =>
    Array.from({ length: n }, (_, i) => `<path transform="rotate(${offset + (360 / n) * i})" d="${d}" fill="${fill}" fill-opacity="${opacity}"/>`).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-110 -110 220 220">` +
    ring(8, 0, "M0 -14C20 -40 20 -78 0 -104C-20 -78 -20 -40 0 -14Z", ".5", tone) +
    ring(8, 22.5, "M0 -10C13 -30 13 -56 0 -74C-13 -56 -13 -30 0 -10Z", ".75", inner) +
    `<circle r="13" fill="${core}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const baseCss = `
:root{
  --ground:#FDFAFF;--panel:#FFFFFF;--ink:#15102E;--muted:#676183;--line:#EBE0F4;
  --purple:#6E54FF;--purple-deep:#4B34D6;--night:#1B1242;--night-line:#3A2F6E;--lilac:#C9BEFF;
  --pink:#FF5FA8;--rose:#D43F9C;--brand:linear-gradient(115deg,#6E54FF 0%,#9A49F2 52%,#D43F9C 100%);
  --pass:#0E9F6A;--pass-soft:#7FE7BE;--refund:#B86A00;--refund-soft:#FFC56B;
  --lift:0 1px 2px rgba(27,18,66,.05),0 14px 34px -22px rgba(27,18,66,.28);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:96px;overflow-x:hidden;overflow-x:clip}
body{margin:0;background:radial-gradient(880px 560px at 92% -6%,rgba(255,95,168,.14),transparent 62%),radial-gradient(760px 520px at -12% 30%,rgba(110,84,255,.07),transparent 60%),radial-gradient(900px 600px at 105% 68%,rgba(255,95,168,.07),transparent 60%),var(--ground);background-repeat:no-repeat;color:var(--ink);font-family:"Bricolage Grotesque",system-ui,sans-serif;font-size:18px;line-height:1.55;position:relative;overflow-x:hidden;overflow-x:clip}
/* The flower sits behind everything, mostly off the right edge, and turns very slowly. */
body::before{content:"";position:absolute;z-index:0;top:150px;right:-210px;width:640px;height:640px;pointer-events:none;
  background:${flower("#6E54FF", "#B04CF4", "#FF5FA8")} center/contain no-repeat;opacity:.11;animation:bloom 240s linear infinite}
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
@media (max-width:520px){body{font-size:17px}.wrap{padding:0 18px}body::before{width:320px;height:320px;right:-150px;opacity:.09}}
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

module.exports = { esc, head, baseCss, flower, MARK, ICON, SITE_NAME, NET, useNetwork, DEFAULT_REPO: "https://github.com/j-6-z/surety" };
