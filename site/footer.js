// Site footer, shared by the homepage and every generated page.
const { esc, DEFAULT_REPO } = require("./theme");

const DEFAULT_VAULT = "0xf3F9e32De47a143149F7398f25f264b98a01273C";

const footerCss = `
footer.site{margin-top:84px;border-top:1px solid var(--line);padding:34px 0 56px;color:var(--muted);font-size:16px}
footer.site .cols{display:grid;grid-template-columns:minmax(0,1.3fr) repeat(3,minmax(0,1fr));gap:28px 40px}
footer.site .about strong{color:var(--ink);font-size:19px;display:block;margin-bottom:6px}
footer.site .about{margin:0;max-width:40ch}
footer.site h2{font-size:15px;font-weight:500;color:var(--ink);margin:0 0 8px}
footer.site ul{list-style:none;margin:0;padding:0}
footer.site li a{display:inline-block;padding:5px 0}
footer.site .vault{margin:28px 0 0;padding-top:18px;border-top:1px solid var(--line);font-size:14.5px}
footer.site .mono{font-size:13.5px;word-break:break-all}
@media (max-width:860px){footer.site .cols{grid-template-columns:1fr 1fr}footer.site .about{grid-column:1/-1}footer.site li a{padding:9px 0}}
`;

/**
 * @param {object} [o]
 * @param {string} [o.vaultAddress] @param {string} [o.repoUrl]
 */
function footer(o = {}) {
  const repo = esc(o.repoUrl || DEFAULT_REPO);
  return `<footer class="site">
  <div class="cols">
    <p class="about"><strong>Surety</strong>Bond-backed refunds for AI agent payments. Running on Monad testnet with test funds only. Not audited.</p>
    <div><h2>Product</h2><ul>
      <li><a href="/#demo">Run the demo</a></li>
      <li><a href="/how-it-works/">How it works</a></li>
      <li><a href="/providers/">Provider directory</a></li>
      <li><a href="/faq/">FAQ</a></li>
    </ul></div>
    <div><h2>Build</h2><ul>
      <li><a href="/bond/">Bond your API</a></li>
      <li><a href="/docs/">Docs</a></li>
      <li><a href="/.well-known/surety.json">SLA document</a></li>
      <li><a href="${repo}">Source on GitHub</a></li>
    </ul></div>
    <div><h2>Read</h2><ul>
      <li><a href="/articles/">Articles</a></li>
      <li><a href="/rss.xml">RSS feed</a></li>
      <li><a href="${repo}/blob/main/LICENSE">MIT licence</a></li>
    </ul></div>
  </div>
  <p class="vault">Vault on Monad testnet <span class="mono">${esc(o.vaultAddress || DEFAULT_VAULT)}</span></p>
</footer>`;
}

module.exports = { footer, footerCss };
