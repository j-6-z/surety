// Site navigation, shared by the homepage and every generated page.
// On phones the links collapse behind a Menu button. Without JavaScript they simply wrap.
const { esc, DEFAULT_REPO } = require("./theme");

const navCss = `
nav.site{display:flex;justify-content:space-between;align-items:center;gap:10px 28px;flex-wrap:wrap;padding:20px 0;position:relative}
nav.site .brand{display:flex;align-items:center;gap:11px;font-weight:700;font-size:22px;letter-spacing:-.01em;text-decoration:none;color:var(--ink);min-height:44px}
nav.site .brand svg{width:32px;height:32px}
nav.site ul{display:flex;align-items:center;flex-wrap:wrap;gap:4px 24px;list-style:none;margin:0;padding:0;font-size:17px}
nav.site ul a{color:var(--ink);text-decoration:none;padding:8px 0;border-bottom:2px solid transparent;display:inline-block}
nav.site ul a:hover{border-bottom-color:var(--purple)}
nav.site ul a[aria-current="page"]{border-bottom-color:var(--purple);font-weight:500}
nav.site ul a.cta{background:var(--purple);color:#fff;padding:10px 16px;border-radius:10px;border:0;font-weight:500}
nav.site ul a.cta:hover{background:var(--purple-deep)}
nav.site .menu-btn{display:none;font:inherit;font-size:17px;font-weight:500;color:var(--ink);background:var(--panel);border:1.5px solid var(--line);border-radius:10px;padding:0 16px;min-height:44px;cursor:pointer;align-items:center;gap:10px}
nav.site .menu-btn .bars{width:18px;height:12px;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink);position:relative}
nav.site .menu-btn .bars::after{content:"";position:absolute;left:0;right:0;top:3px;border-top:2px solid var(--ink)}
@media (max-width:860px){
  .js nav.site .menu-btn{display:inline-flex}
  .js nav.site ul{display:none;width:100%;flex-direction:column;align-items:stretch;gap:0;background:var(--panel);border:1.5px solid var(--line);border-radius:14px;padding:8px 16px 14px;margin-top:4px}
  .js nav.site.open ul{display:flex}
  .js nav.site ul li{border-bottom:1px solid var(--line)}
  .js nav.site ul li:last-child{border-bottom:0;padding-top:12px}
  .js nav.site ul a{display:block;padding:14px 0;border-bottom:0;font-size:18px}
  .js nav.site ul a[aria-current="page"]{color:var(--purple-deep)}
  .js nav.site ul a.cta{text-align:center;padding:14px 16px}
}
`;

const LINKS = [
  { id: "how", label: "How it works", href: "/how-it-works/" },
  { id: "providers", label: "Providers", href: "/providers/" },
  { id: "bond", label: "Bond your API", href: "/bond/" },
  { id: "docs", label: "Docs", href: "/docs/" },
  { id: "articles", label: "Articles", href: "/articles/" },
];

/**
 * @param {object} [o]
 * @param {"home"|"how"|"providers"|"bond"|"docs"|"articles"|"faq"} [o.current]  which section this page belongs to
 */
function nav(o = {}) {
  const items = LINKS.map(
    (l) => `<li><a href="${l.href}"${l.id === o.current ? ' aria-current="page"' : ""}>${l.label}</a></li>`
  ).join("");
  return `<script>document.documentElement.className+=" js"</script>
<nav class="site" aria-label="Main">
  <a class="brand" href="/" aria-label="Surety home">
    <svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#6E54FF"/><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 13l15 6v12c0 10-6 16-15 19-9-3-15-9-15-19V19z"/><path d="M25 31l5 5 9-10"/></g></svg>
    Surety
  </a>
  <button class="menu-btn" type="button" aria-expanded="false" aria-controls="site-menu"><span class="bars" aria-hidden="true"></span>Menu</button>
  <ul id="site-menu">${items}<li><a class="cta" href="/#demo">Run the demo</a></li></ul>
</nav>
<script>(function(){var n=document.querySelector("nav.site"),b=n.querySelector(".menu-btn");b.addEventListener("click",function(){var o=n.classList.toggle("open");b.setAttribute("aria-expanded",o?"true":"false")});n.querySelector("ul").addEventListener("click",function(e){if(e.target.tagName==="A"){n.classList.remove("open");b.setAttribute("aria-expanded","false")}})})();</script>`;
}

module.exports = { nav, navCss, LINKS, DEFAULT_REPO, esc };
