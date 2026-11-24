// Site header, shared by the homepage and every generated page.
//
// Two tiers. A thin dark strip says where this runs and that it is experimental,
// with the links someone checking the project wants. Under it, the main bar:
// the brand, four menus that open on click (never on hover), and the two actions.
// On phones the menus collapse behind a Menu button and open as one list.
// Without JavaScript every link is simply shown.
const { esc, DEFAULT_REPO, DEFAULT_VAULT } = require("./theme");

const navCss = `
header.site{position:sticky;top:0;z-index:50;margin:0 0 6px}
header.site::before{content:"";position:absolute;z-index:-1;top:0;bottom:0;left:-100vmax;right:-100vmax;background:var(--ground);border-bottom:1px solid var(--line);transition:box-shadow .25s ease}
header.site.stuck::before{box-shadow:0 10px 30px -22px rgba(27,18,66,.45)}

.util{position:relative;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 24px;padding:8px 0;font-size:14.5px;color:#D9D2F7}
.util::before{content:"";position:absolute;z-index:-1;top:0;bottom:0;left:-100vmax;right:-100vmax;background:var(--night)}
.util p{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px}
.util .net{display:inline-flex;align-items:center;gap:8px;color:#fff;font-weight:500}
.util .net::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--pass-soft);animation:beat 2.6s ease-in-out infinite}
.util .stats{display:inline-flex;flex-wrap:wrap;gap:2px 0;color:#B9AFE6}
.util .stats[hidden]{display:none}
.util .stats span{padding:0 14px;border-left:1px solid var(--night-line)}
.util .stats b{color:#fff;font-weight:500}
.util a.mono{font-size:13px}
.util ul{display:flex;gap:4px 22px;list-style:none;margin:0;padding:0}
.util a{color:#fff;text-decoration:none;padding:3px 0;display:inline-block}
@keyframes beat{50%{opacity:.5}}

nav.site{display:flex;justify-content:space-between;align-items:center;gap:10px 28px;flex-wrap:wrap;padding:14px 0;position:relative}
nav.site .brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--ink);min-height:48px}
nav.site .brand svg{width:38px;height:38px;flex:none}
nav.site .brand b{display:block;font-weight:700;font-size:23px;letter-spacing:-.02em;line-height:1.05}
nav.site .brand small{display:block;font-size:13.5px;color:var(--muted);line-height:1.2;margin-top:2px;white-space:nowrap}
nav.site .menus{display:flex;align-items:center;flex-wrap:wrap;gap:4px 2px;font-size:16.5px}
nav.site .m{position:relative}
nav.site .m>button{font:inherit;color:var(--ink);background:none;border:0;border-radius:9px;padding:10px 10px;white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
nav.site .m>button::after{content:"";width:7px;height:7px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:translateY(-2px) rotate(45deg);transition:transform .2s ease}
nav.site .m.here>button{font-weight:500;color:var(--purple-deep)}
nav.site .m.open>button{background:#EFEBFF}
nav.site .m.open>button::after{transform:translateY(2px) rotate(225deg)}
nav.site .drop{display:flex;flex-wrap:wrap;gap:2px 18px;padding:2px 12px 8px}
nav.site .drop a{color:var(--ink);text-decoration:none;display:block}
nav.site .drop strong{display:block;font-weight:500}
nav.site .drop span{display:block;font-size:14.5px;color:var(--muted);line-height:1.35;margin-top:1px}
nav.site .drop a[aria-current="page"] strong{color:var(--purple-deep)}
nav.site .acts{display:flex;gap:10px;margin-left:10px}
nav.site .acts a{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 16px;border-radius:11px;font-weight:500;font-size:16.5px;text-decoration:none;white-space:nowrap}
nav.site .acts .ghost{color:var(--ink);border:1.5px solid #CFC8EA;background:var(--panel)}
nav.site .acts .cta{background:var(--purple);color:#fff;box-shadow:0 8px 20px -12px rgba(110,84,255,.9)}
nav.site .menu-btn{display:none;font:inherit;font-size:17px;font-weight:500;color:var(--ink);background:var(--panel);border:1.5px solid var(--line);border-radius:10px;padding:0 16px;min-height:46px;cursor:pointer;align-items:center;gap:10px}
nav.site .menu-btn .bars{width:18px;height:12px;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink);position:relative}
nav.site .menu-btn .bars::after{content:"";position:absolute;left:0;right:0;top:3px;border-top:2px solid var(--ink)}

/* With JavaScript: menus drop down on click. */
@media (min-width:981px){
  .js nav.site,.js nav.site .menus{flex-wrap:nowrap}
  .js nav.site .drop{display:none;position:absolute;top:calc(100% + 12px);left:-10px;width:340px;flex-direction:column;gap:2px;padding:10px;background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:0 2px 4px rgba(27,18,66,.05),0 28px 60px -28px rgba(27,18,66,.45)}
  .js nav.site .m:nth-last-of-type(-n+3) .drop{left:auto;right:-10px}
  .js nav.site .m.open .drop{display:flex;animation:unfold .18s ease-out both}
  .js nav.site .drop a{padding:11px 14px;border-radius:10px}
  .js nav.site .drop a[aria-current="page"]{background:#F3F0FF}
}
@keyframes unfold{from{opacity:0;transform:translateY(-6px)}}
@media (min-width:981px) and (max-width:1240px){nav.site .brand small{display:none}}
@media (max-width:980px){
  .util .stats span:nth-child(n+2),.util ul li.opt{display:none}
  nav.site .brand small{display:none}
  .js nav.site .menu-btn{display:inline-flex}
  .js nav.site .menus{display:none;width:100%;flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:0;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:6px 18px 18px;margin-top:4px;box-shadow:var(--lift);max-height:calc(100vh - 150px);overflow-y:auto}
  .js nav.site.open .menus{display:flex;animation:unfold .18s ease-out both}
  .js nav.site .m{border-bottom:1px solid var(--line);padding:12px 0 8px}
  .js nav.site .m>button{padding:0;font-size:14.5px;color:var(--muted);cursor:default;pointer-events:none}
  .js nav.site .m>button::after{display:none}
  .js nav.site .m.open>button{background:none}
  .js nav.site .drop{flex-direction:column;gap:0;padding:4px 0 0}
  .js nav.site .drop a{padding:9px 0}
  .js nav.site .drop span{display:none}
  .js nav.site .drop strong{font-size:18px}
  .js nav.site .acts{margin:16px 0 0;flex-direction:column}
  .js nav.site .acts a{min-height:52px;font-size:18px}
}
@media (max-width:520px){.util{font-size:13.5px}.util .stats{display:none}nav.site{padding:10px 0}}
@media (prefers-reduced-motion:reduce){.util .net::before,.js nav.site .m.open .drop,.js nav.site.open .menus{animation:none}nav.site .m>button::after,header.site::before{transition:none}}
`;

/// Which menu each section of the site lives under.
const MENUS = (repo) => [
  { label: "Product", ids: ["home", "how", "providers"], items: [
    { id: "how", href: "/how-it-works/", t: "How it works", d: "The bond, the relay and the refund, start to finish" },
    { href: "/#demo", t: "Live demo", d: "Run a paid call and watch a refund happen" },
    { id: "providers", href: "/providers/", t: "Provider directory", d: "Every bonded API and its record" },
    { href: "/#use", t: "Check a provider", d: "Look up a bond and trust score by address" },
  ] },
  { label: "For providers", ids: ["bond", "kit"], items: [
    { id: "bond", href: "/bond/", t: "Bond your API", d: "List it and post a bond from your browser" },
    { id: "kit", href: "/kit/", t: "Provider kit", d: "A starter project for a new bonded API" },
    { href: "/articles/bond-your-x402-api/", t: "Bonding with code", d: "The manual route, step by step" },
  ] },
  { label: "Developers", ids: ["docs"], items: [
    { id: "docs", href: "/docs/", t: "Docs", d: "Relay addresses, response headers, the trust record" },
    { href: "/docs/#spending-limits", t: "Spending limits", d: "Cap what an agent can pay per call and per day" },
    { href: "/.well-known/surety.json", t: "SLA document", d: "The promise our own API is held to" },
    { href: repo, t: "Source on GitHub", d: "The contract, the relay and this site" },
  ] },
  { label: "Learn", ids: ["articles", "faq"], items: [
    { id: "articles", href: "/articles/", t: "Articles", d: "Why agent payments need refunds, and how bonds work" },
    { id: "faq", href: "/faq/", t: "FAQ", d: "Straight answers, including what this is not" },
  ] },
];

const SHIELD = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#6E54FF"/><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 13l15 6v12c0 10-6 16-15 19-9-3-15-9-15-19V19z"/><path d="M25 31l5 5 9-10"/></g></svg>';

/**
 * @param {object} [o]
 * @param {"home"|"how"|"providers"|"bond"|"kit"|"docs"|"articles"|"faq"} [o.current]  which section this page belongs to
 * @param {string} [o.repoUrl] @param {string} [o.vaultAddress]
 */
function nav(o = {}) {
  const repo = esc(o.repoUrl || DEFAULT_REPO);
  const vault = esc(o.vaultAddress || DEFAULT_VAULT);
  const menus = MENUS(repo).map((m, i) => {
    const items = m.items.map(
      (l) => `<a href="${l.href}"${l.id && l.id === o.current ? ' aria-current="page"' : ""}><strong>${l.t}</strong><span>${l.d}</span></a>`
    ).join("");
    return `<div class="m${m.ids.includes(o.current) ? " here" : ""}"><button type="button" aria-expanded="false" aria-controls="menu-${i}">${m.label}</button><div class="drop" id="menu-${i}">${items}</div></div>`;
  }).join("\n    ");
  return `<script>document.documentElement.className+=" js"</script>
<header class="site">
  <div class="util">
    <p><span class="net">Monad testnet</span><span class="stats" id="util-stats" hidden><span><b id="us-p"></b> bonded</span><span><b id="us-b"></b> USDC in bonds</span><span><b id="us-r"></b> paid out</span></span></p>
    <ul>
      <li class="opt"><a class="mono" href="https://testnet.monadvision.com/address/${vault}" rel="noopener" title="Vault contract">Vault ${vault.slice(0, 6)}…${vault.slice(-4)}</a></li>
      <li><a href="${repo}">GitHub</a></li>
      <li><a href="/faq/">FAQ</a></li>
    </ul>
  </div>
  <nav class="site" aria-label="Main">
    <a class="brand" href="/" aria-label="Surety home">${SHIELD}<span><b>Surety</b><small>Bonded refunds for agent payments</small></span></a>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="site-menu"><span class="bars" aria-hidden="true"></span>Menu</button>
    <div class="menus" id="site-menu">
    ${menus}
    <div class="acts"><a class="ghost" href="/bond/">Bond your API</a><a class="cta" href="/#demo">Run the demo</a></div>
    </div>
  </nav>
</header>
<script>(function(){
var h=document.querySelector("header.site"),n=h.querySelector("nav.site"),b=n.querySelector(".menu-btn"),ms=[].slice.call(n.querySelectorAll(".m"));
function shut(except){ms.forEach(function(m){if(m!==except){m.classList.remove("open");m.firstChild.setAttribute("aria-expanded","false")}})}
function all(open){n.classList.toggle("open",open);b.setAttribute("aria-expanded",open?"true":"false")}
ms.forEach(function(m){m.firstChild.addEventListener("click",function(e){e.stopPropagation();shut(m);var o=m.classList.toggle("open");this.setAttribute("aria-expanded",o?"true":"false")})});
b.addEventListener("click",function(e){e.stopPropagation();all(!n.classList.contains("open"))});
n.addEventListener("click",function(e){if(e.target.closest("a")){shut();all(false)}});
document.addEventListener("click",function(e){if(!n.contains(e.target)){shut();all(false)}});
document.addEventListener("keydown",function(e){if(e.key==="Escape"){shut();all(false)}});
function s(){h.classList.toggle("stuck",window.scrollY>8)}s();window.addEventListener("scroll",s,{passive:true});
function show(d){var p=d.providers||[],a=0,b=0,r=0;p.forEach(function(x){if(x.active)a++;b+=Number(x.bond||0);r+=Number(x.claimCount||0)});if(!p.length)return;
document.getElementById("us-p").textContent=a+(a===1?" provider":" providers");document.getElementById("us-b").textContent=(b/1e6).toFixed(2);document.getElementById("us-r").textContent=r+(r===1?" refund":" refunds");document.getElementById("util-stats").hidden=false}
var k="surety-stats",c=null;try{c=JSON.parse(sessionStorage.getItem(k))}catch(e){}
if(c&&Date.now()-c.at<60000)show(c.d);else fetch("/providers.json").then(function(x){return x.ok?x.json():null}).then(function(d){if(!d)return;show(d);try{sessionStorage.setItem(k,JSON.stringify({at:Date.now(),d:d}))}catch(e){}}).catch(function(){});
})();</script>`;
}

module.exports = { nav, navCss, MENUS, SHIELD, DEFAULT_REPO, esc };
