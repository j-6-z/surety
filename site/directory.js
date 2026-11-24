// The provider directory: every bonded provider this relay knows about, with
// its live record. The page is a shell; the rows come from /providers.json.
const { esc, head } = require("./theme");
const { nav, navCss } = require("./nav");
const { footer, footerCss } = require("./footer");

const CSS = `
.dir{padding:34px 0 0}
.dir h1{font-size:clamp(38px,5vw,60px);line-height:1.02;letter-spacing:-.03em;margin:0 0 12px}
.dir .standfirst{font-size:21px;color:#3B3558;margin:0 0 30px;max-width:58ch}
.count{font-size:17px;color:var(--muted);margin:0 0 14px}
.rows{list-style:none;margin:0;padding:0;display:grid;gap:16px}
.prov{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px 24px}
.prov-top{display:flex;flex-wrap:wrap;gap:10px 20px;justify-content:space-between;align-items:baseline}
.prov h2{font-size:25px;letter-spacing:-.02em;margin:0;overflow-wrap:anywhere}
.badge{font-size:15px;font-weight:500;padding:4px 12px;border-radius:999px;white-space:nowrap}
.badge.on{background:#DDF6EA;color:#0A6B47}
.badge.off{background:#FCEBD0;color:#8A4F00}
.prov .addr{font-size:13.5px;color:var(--muted);word-break:break-all;margin:4px 0 16px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 20px;margin:0 0 16px}
.stats dt{font-size:14.5px;color:var(--muted)}
.stats dd{margin:2px 0 0;font-size:20px;font-weight:700;letter-spacing:-.01em}
.eps{margin:0;padding:14px 0 0;border-top:1px solid var(--line);list-style:none;display:grid;gap:8px;font-size:16px}
.eps li{display:flex;flex-wrap:wrap;gap:4px 14px;justify-content:space-between}
.eps code{overflow-wrap:anywhere}
.eps span{color:var(--muted);white-space:nowrap}
.prov .links{margin:14px 0 0;font-size:16px;display:flex;flex-wrap:wrap;gap:6px 22px}
.note{background:var(--panel);border:1px dashed #C9BEFF;border-radius:18px;padding:22px 24px;margin:16px 0 0}
.note h2{font-size:22px;margin:0 0 6px;letter-spacing:-.01em}
.note p{margin:0 0 12px;color:#443E62;max-width:60ch}
.note a.go{display:inline-block;background:var(--purple);color:#fff;text-decoration:none;font-weight:500;padding:12px 18px;border-radius:11px}
.note a.go:hover{background:var(--purple-deep)}
.state{padding:26px;text-align:center;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:18px}
@media (max-width:700px){.stats{grid-template-columns:1fr 1fr}.prov{padding:18px}.prov h2{font-size:22px}}
`;

function directoryPage({ url, vaultAddress, repoUrl }) {
  const description = "Every API provider bonded on Surety, with its live bond, refund history and trust score, read from the vault on Monad testnet.";
  return `<!doctype html>
<html lang="en">
<head>
${head({
  title: "Provider directory | Surety",
  description,
  url: `${url}/providers/`,
  siteUrl: url,
  jsonLd: { "@context": "https://schema.org", "@type": "CollectionPage", name: "Surety provider directory", description, url: `${url}/providers/` },
  css: navCss + footerCss + CSS,
})}
</head>
<body>
<div class="wrap">
${nav({ current: "providers" })}
<main class="dir">
  <h1>Provider directory</h1>
  <p class="standfirst">APIs that have put up a bond on Surety. The numbers are read live from the vault, so what you see is what is at stake right now.</p>
  <p class="count" id="count" aria-live="polite">Reading the vault…</p>
  <ul class="rows" id="rows"></ul>
  <div class="note">
    <h2>Run a paid API? Add yours.</h2>
    <p>Listing is open to anyone: publish what you promise, register on the vault and post a bond. On testnet that costs nothing real and takes about fifteen minutes.</p>
    <a class="go" href="/bond/">Bond your API</a>
  </div>
</main>
${footer({ vaultAddress, repoUrl })}
</div>
<script>
(function () {
  var rows = document.getElementById("rows"), count = document.getElementById("count");
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var usd = function (micro) {
    var t = (Number(micro) / 1e6).toFixed(6).replace(/0+$/, ""), d = t.split(".")[1] || "";
    return d.length >= 2 ? t : (Number(micro) / 1e6).toFixed(2);
  };
  var secs = function (ms) { return (ms / 1000) + " s"; };
  fetch("/providers.json").then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) {
    var list = d.providers || [];
    count.textContent = list.length === 1 ? "1 provider bonded so far." : list.length + " providers bonded.";
    if (!list.length) { rows.innerHTML = '<li class="state">No providers are bonded yet.</li>'; return; }
    rows.innerHTML = list.map(function (p) {
      var eps = (p.endpoints || []).map(function (e) {
        return "<li><code>" + esc(e.method) + " " + esc(e.path) + "</code><span>answers within " + secs(e.maxLatencyMs) + "</span></li>";
      }).join("");
      var rate = p.passRate == null ? "No calls yet" : Math.round(p.passRate * 100) + "% of " + p.calls;
      return '<li class="prov"><div class="prov-top"><h2>' + esc(p.host || "Unnamed provider") + '</h2>' +
        '<span class="badge ' + (p.active ? "on" : "off") + '">' + (p.active ? "Active: calls are covered" : "Not covered right now") + "</span></div>" +
        '<p class="addr mono">' + esc(p.provider) + "</p>" +
        '<dl class="stats"><div><dt>Bond</dt><dd>' + usd(p.bond) + " USDC</dd></div>" +
        "<div><dt>Trust score</dt><dd>" + p.score + " of 100</dd></div>" +
        "<div><dt>Refunds paid</dt><dd>" + p.claimCount + " (" + usd(p.claimsPaid) + ")</dd></div>" +
        "<div><dt>Calls passed</dt><dd>" + rate + "</dd></div></dl>" +
        (eps ? '<ul class="eps">' + eps + "</ul>" : "") +
        '<p class="links"><a href="/trust/' + esc(p.provider) + '">Full record</a>' + (p.slaUrl ? '<a href="' + esc(p.slaUrl) + '" rel="noopener">Its promise (SLA)</a>' : "") + "</p></li>";
    }).join("");
  }).catch(function () {
    count.textContent = "";
    rows.innerHTML = '<li class="state">Couldn\\'t read the vault just now. Reload to try again.</li>';
  });
})();
</script>
</body>
</html>`;
}

function notFoundPage({ url, vaultAddress, repoUrl }) {
  return `<!doctype html>
<html lang="en">
<head>
${head({ title: "Page not found | Surety", description: "That page doesn't exist.", url: `${url}/`, siteUrl: url, css: navCss + footerCss + CSS, extra: '<meta name="robots" content="noindex">\n' })}
</head>
<body>
<div class="wrap">
${nav({})}
<main class="dir">
  <h1>That page doesn't exist.</h1>
  <p class="standfirst">The address may be mistyped, or the page may have moved. These are the places most people are looking for.</p>
  <div class="note">
    <p><a href="/">Home and the live demo</a><br><a href="/how-it-works/">How it works</a><br><a href="/providers/">Provider directory</a><br><a href="/docs/">Docs</a><br><a href="/articles/">Articles</a></p>
  </div>
</main>
${footer({ vaultAddress, repoUrl })}
</div>
</body>
</html>`;
}

module.exports = { directoryPage, notFoundPage };
