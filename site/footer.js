// Site footer, shared by the homepage and every generated page.
//
// A full-width dark band in four parts: a closing pitch with the two things a
// visitor can do; the whole site map with a line under each link; the on-chain
// details someone checking the project wants; and a plain statement of what
// this is today, above the legal line.
const { esc, flower, DEFAULT_REPO, NET } = require("./theme");
const { SHIELD } = require("./nav");


const footerCss = `
footer.site{position:relative;margin-top:104px;color:#D9D2F7;padding:68px 0 30px;font-size:16.5px}
footer.site::before{content:"";position:absolute;z-index:-2;top:0;bottom:0;left:-100vmax;right:-100vmax;background:var(--night)}
/* The same flower as the page, pale on the dark band. */
footer.site::after{content:"";position:absolute;z-index:-1;top:-150px;right:-230px;width:560px;height:560px;pointer-events:none;
  background:${flower("#C9BEFF", "#C9BEFF")} center/contain no-repeat;opacity:.07;clip-path:inset(150px 0 0 0)}
footer.site a{color:#fff;text-decoration:none}
footer.site .close{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:36px 56px;align-items:end;padding-bottom:50px;border-bottom:1px solid var(--night-line)}
footer.site .mark{display:flex;align-items:center;gap:16px;font-size:clamp(44px,6vw,76px);font-weight:700;letter-spacing:-.04em;line-height:1;color:#fff;margin:0 0 18px}
footer.site .mark svg{width:.9em;height:.9em;flex:none}
footer.site .pitch{font-size:21px;line-height:1.4;margin:0;max-width:34ch;color:#E9E4FF}
footer.site .acts{display:flex;flex-wrap:wrap;gap:12px}
footer.site .acts a{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 24px;border-radius:12px;font-weight:500;font-size:18px}
footer.site .acts a.one{background:var(--purple);color:#fff}
footer.site .acts a.two{border:1.5px solid #5A4BA3;color:#fff}
footer.site .acts p{flex-basis:100%;margin:6px 0 0;font-size:15px;color:#A99FD6}

footer.site .map{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:34px 40px;padding:48px 0}
footer.site h2{font-size:15px;font-weight:500;color:var(--lilac);margin:0 0 14px;padding-bottom:12px;border-bottom:1px solid var(--night-line)}
footer.site ul{list-style:none;margin:0;padding:0}
footer.site .map li{margin:0 0 14px}
footer.site .map a{display:block;font-size:17px;font-weight:500}
footer.site .map span{display:block;font-size:14.5px;color:#A99FD6;line-height:1.4;margin-top:1px}

footer.site .chain{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:0;background:#241960;border:1px solid var(--night-line);border-radius:18px;overflow:hidden}
footer.site .chain>div{padding:24px 26px}
footer.site .chain .today{border-right:1px solid var(--night-line)}
footer.site .chain h2{border:0;padding:0;margin:0 0 8px}
footer.site .today p{margin:0;font-size:15.5px;line-height:1.5;color:#D9D2F7}
footer.site .today .state{display:inline-flex;align-items:center;gap:9px;color:#fff;font-weight:500;font-size:17px;margin:0 0 8px}
footer.site .today .state::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--refund-soft)}
footer.site dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:9px 22px;margin:0;font-size:15px}
footer.site dt{color:var(--lilac);white-space:nowrap}
footer.site dd{margin:0;color:#fff}
footer.site dd.mono{font-size:13.5px;word-break:break-all}
footer.site dd a{text-decoration:underline;text-decoration-color:#5A4BA3;text-underline-offset:4px}

footer.site .legal{display:flex;flex-wrap:wrap;gap:8px 28px;justify-content:space-between;align-items:center;margin:28px 0 0;font-size:14.5px;color:#A99FD6}
footer.site .legal ul{display:flex;flex-wrap:wrap;gap:6px 22px}
footer.site .legal a{color:#D9D2F7;padding:4px 0;display:inline-block}
@media (max-width:900px){
  footer.site{padding-top:52px;margin-top:76px}
  footer.site .close{grid-template-columns:1fr;align-items:start;padding-bottom:38px}
  footer.site .map{grid-template-columns:1fr 1fr;padding:38px 0}
  footer.site .chain{grid-template-columns:1fr}
  footer.site .chain .today{border-right:0;border-bottom:1px solid var(--night-line)}
  footer.site::after{width:380px;height:380px;right:-180px;top:-100px;clip-path:inset(100px 0 0 0)}
}
@media (max-width:520px){
  footer.site .acts a{flex:1 1 100%}
  footer.site .pitch{font-size:19px}
  footer.site .map{gap:28px 22px}
  footer.site .map span{display:none}
  footer.site .map li{margin-bottom:12px}
  footer.site .chain>div{padding:20px}
  footer.site dl{grid-template-columns:1fr;gap:2px}
  footer.site dd{margin-bottom:10px}
}
`;

/**
 * @param {object} [o]
 * @param {string} [o.vaultAddress] @param {string} [o.repoUrl]
 */
function footer(o = {}) {
  const repo = esc(o.repoUrl || DEFAULT_REPO);
  const vault = esc(o.vaultAddress || NET.vault);
  const USDC = esc(NET.usdc), EXPLORER = `${esc(NET.explorer)}/address/`;
  const today = NET.real
    ? `Surety runs on ${esc(NET.fullName)} with real USDC. The vault contract has not been independently audited, and one relay, run by us, decides whether a call kept its promise. Bond only what you can afford to lose.`
    : `Surety runs on ${esc(NET.fullName)} with test USDC. One relay, run by us, decides whether a call kept its promise. Nothing here holds real money yet.`;
  const col = (title, links) =>
    `<div><h2>${title}</h2><ul>${links.map(([href, t, d, ext]) => `<li><a href="${href}"${ext ? ' rel="noopener"' : ""}>${t}</a><span>${d}</span></li>`).join("")}</ul></div>`;
  return `<footer class="site">
  <div class="close">
    <div>
      <p class="mark">${SHIELD}Surety</p>
      <p class="pitch">Providers put money behind their promises. Agents get paid back when a promise is broken.</p>
    </div>
    <div class="acts">
      <a class="one" href="/#demo">Run the demo</a>
      <a class="two" href="/bond/">Bond your API</a>
      <p>No wallet needed for the demo. Bonding takes about five minutes.</p>
    </div>
  </div>

  <nav class="map" aria-label="Site">
    ${col("Product", [
      ["/#demo", "Live demo", "Run a paid call and watch a refund"],
      ["/how-it-works/", "How it works", "The bond, the relay, the refund"],
      ["/providers/", "Provider directory", "Every bonded API and its record"],
      ["/#use", "Check a provider", "Bond and trust score by address"],
    ])}
    ${col("For providers", [
      ["/bond/", "Bond your API", "From your browser, with your wallet"],
      ["/kit/", "Provider kit", "Starter project for a bonded API"],
      ["/articles/bond-your-x402-api/", "Bonding with code", "The manual route, step by step"],
    ])}
    ${col("Developers", [
      ["/docs/", "Docs", "Relay addresses, headers, trust record"],
      ["/docs/#spending-limits", "Spending limits", "Cap an agent per call and per day"],
      ["/.well-known/surety.json", "SLA document", "The promise our own API is held to"],
      ["/providers.json", "Directory as JSON", "The provider list, for programs"],
      [repo, "Source on GitHub", "Contract, relay and this site"],
    ])}
    ${col("Learn", [
      ["/articles/", "Articles", "Agent payments, bonds and refunds"],
      ["/faq/", "FAQ", "Including what this is not"],
      ["/rss.xml", "RSS feed", "New articles as they are published"],
      [`${repo}/blob/main/SECURITY.md`, "Report a problem", "Security issues and how to reach us"],
    ])}
  </nav>

  <div class="chain">
    <div class="today">
      <h2>Where this stands</h2>
      <p class="state">${esc(NET.status)}</p>
      <p>${today}</p>
    </div>
    <div>
      <h2>On-chain details</h2>
      <dl>
        <dt>Network</dt><dd>${esc(NET.fullName)}, chain ID ${NET.chainId}</dd>
        <dt>Vault contract</dt><dd class="mono"><a href="${EXPLORER}${vault}" rel="noopener">${vault}</a></dd>
        <dt>Payment token</dt><dd class="mono"><a href="${EXPLORER}${USDC}" rel="noopener">${USDC}</a> <span>(${esc(NET.usdcLabel)})</span></dd>
        <dt>Payments</dt><dd>x402, settled per call</dd>
      </dl>
    </div>
  </div>

  <div class="legal">
    <span>&copy; 2026 Surety. ${NET.real ? "Unaudited beta: use at your own risk." : "Test funds only."} Nothing here is financial advice.</span>
    <ul>
      <li><a href="${repo}/blob/main/LICENSE">MIT licence</a></li>
      <li><a href="${repo}">GitHub</a></li>
      <li><a href="#top">Back to top</a></li>
    </ul>
  </div>
</footer>`;
}

module.exports = { footer, footerCss };
