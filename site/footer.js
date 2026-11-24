// Site footer, shared by the homepage and every generated page.
// A full-width dark band: a closing pitch with the two things a visitor can do,
// the site map, and the facts someone checking the project wants (network, vault, status).
const { esc, DEFAULT_REPO } = require("./theme");

const DEFAULT_VAULT = "0xf3F9e32De47a143149F7398f25f264b98a01273C";

const footerCss = `
footer.site{margin-top:96px;background:var(--night);color:#D9D2F7;padding:64px 0 34px;font-size:16.5px;
  box-shadow:0 0 0 100vmax var(--night);clip-path:inset(0 -100vmax)}
footer.site a{color:#fff;text-decoration:none}
footer.site a:hover{color:var(--lilac);text-decoration:underline;text-underline-offset:4px}
footer.site .close{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:36px 56px;align-items:end;padding-bottom:48px;border-bottom:1px solid var(--night-line)}
footer.site .mark{display:flex;align-items:center;gap:16px;font-size:clamp(44px,6vw,76px);font-weight:700;letter-spacing:-.04em;line-height:1;color:#fff;margin:0 0 18px}
footer.site .mark svg{width:.9em;height:.9em;flex:none}
footer.site .pitch{font-size:21px;line-height:1.4;margin:0;max-width:34ch;color:#E9E4FF}
footer.site .acts{display:flex;flex-wrap:wrap;gap:12px}
footer.site .acts a{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 24px;border-radius:12px;font-weight:500;font-size:18px;text-decoration:none}
footer.site .acts a.one{background:var(--purple);color:#fff}
footer.site .acts a.one:hover{background:#8169FF;color:#fff}
footer.site .acts a.two{border:1.5px solid #5A4BA3;color:#fff}
footer.site .acts a.two:hover{border-color:var(--lilac);color:#fff}
footer.site .acts p{flex-basis:100%;margin:6px 0 0;font-size:15px;color:#A99FD6}
footer.site .map{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:30px 40px;padding:44px 0}
footer.site h2{font-size:15px;font-weight:500;color:var(--lilac);margin:0 0 12px}
footer.site ul{list-style:none;margin:0;padding:0}
footer.site li a{display:inline-block;padding:6px 0;font-size:17px}
footer.site .facts{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:16px 44px;padding:22px 24px;background:#241960;border-radius:16px;margin:0}
footer.site .facts dt{font-size:14px;color:var(--lilac)}
footer.site .facts dd{margin:3px 0 0;color:#fff;font-weight:500}
footer.site .facts dd.mono{font-size:14px;font-weight:400;word-break:break-all}
footer.site .facts .live{display:inline-flex;align-items:center;gap:8px}
footer.site .facts .live::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--refund-soft)}
footer.site .legal{display:flex;flex-wrap:wrap;gap:8px 28px;justify-content:space-between;margin:26px 0 0;font-size:14.5px;color:#A99FD6}
@media (max-width:860px){
  footer.site{padding-top:48px;margin-top:72px}
  footer.site .close{grid-template-columns:1fr;align-items:start;padding-bottom:36px}
  footer.site .map{grid-template-columns:1fr 1fr;padding:34px 0}
  footer.site li a{padding:9px 0}
  footer.site .facts{grid-template-columns:1fr 1fr}
  footer.site .facts .wide{grid-column:1/-1}
}
@media (max-width:520px){
  footer.site .acts a{flex:1 1 100%}
  footer.site .pitch{font-size:19px}
  footer.site .facts{padding:18px}
}
`;

/**
 * @param {object} [o]
 * @param {string} [o.vaultAddress] @param {string} [o.repoUrl]
 */
function footer(o = {}) {
  const repo = esc(o.repoUrl || DEFAULT_REPO);
  const vault = esc(o.vaultAddress || DEFAULT_VAULT);
  return `<footer class="site">
  <div class="close">
    <div>
      <p class="mark"><svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#6E54FF"/><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 13l15 6v12c0 10-6 16-15 19-9-3-15-9-15-19V19z"/><path d="M25 31l5 5 9-10"/></g></svg>Surety</p>
      <p class="pitch">Providers put money behind their promises. Agents get paid back when a promise is broken.</p>
    </div>
    <div class="acts">
      <a class="one" href="/#demo">Run the demo</a>
      <a class="two" href="/bond/">Bond your API</a>
      <p>No wallet needed for the demo. Bonding takes about five minutes on testnet.</p>
    </div>
  </div>

  <nav class="map" aria-label="Site">
    <div><h2>Use it</h2><ul>
      <li><a href="/#demo">Live demo</a></li>
      <li><a href="/bond/">Bond your API</a></li>
      <li><a href="/#use">Check a provider</a></li>
      <li><a href="/providers/">Provider directory</a></li>
    </ul></div>
    <div><h2>Understand it</h2><ul>
      <li><a href="/how-it-works/">How it works</a></li>
      <li><a href="/faq/">FAQ</a></li>
      <li><a href="/articles/">Articles</a></li>
      <li><a href="/rss.xml">RSS feed</a></li>
    </ul></div>
    <div><h2>Build on it</h2><ul>
      <li><a href="/docs/">Docs</a></li>
      <li><a href="/.well-known/surety.json">SLA document</a></li>
      <li><a href="/articles/bond-your-x402-api/">Bonding with code</a></li>
    </ul></div>
    <div><h2>Check our work</h2><ul>
      <li><a href="${repo}">Source on GitHub</a></li>
      <li><a href="https://testnet.monadvision.com/address/${vault}" rel="noopener">Vault on the explorer</a></li>
      <li><a href="${repo}/blob/main/SECURITY.md">Report a problem</a></li>
    </ul></div>
  </nav>

  <dl class="facts">
    <div><dt>Network</dt><dd>Monad testnet</dd></div>
    <div><dt>Status</dt><dd><span class="live">Experimental, not audited</span></dd></div>
    <div class="wide"><dt>Vault contract</dt><dd class="mono">${vault}</dd></div>
  </dl>

  <p class="legal"><span>Test funds only. Nothing here is financial advice.</span><span>Open source under the <a href="${repo}/blob/main/LICENSE">MIT licence</a></span></p>
</footer>`;
}

module.exports = { footer, footerCss };
