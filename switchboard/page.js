// Dashboard page. A shell: the numbers come from /v1/capabilities and /v1/stats.
// Same palette as Surety (purple with a hint of pink), no hover effects.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function dashboardPage({ label, suretyUrl, routePrice }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Switchboard | One endpoint for bonded x402 APIs on Monad</title>
<meta name="description" content="Switchboard routes AI agent calls to the best Surety-bonded x402 provider on Monad, with automatic fallback. Failed calls are refunded from the provider's bond.">
<style>
:root{--brand:#6B4EFF;--pink:#E25FB0;--ink:#16122B;--muted:#6A6487;--line:#E7E2F7;--panel:#FFFFFF;--bg:#FBFAFF}
*{box-sizing:border-box}
body{margin:0;font:17px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
header{border-bottom:1px solid var(--line);background:#fff}
header .wrap{display:flex;justify-content:space-between;align-items:center;height:68px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--brand),var(--pink))}
header nav{display:flex;gap:24px;font-size:15.5px}
header nav a{color:#3B3558;text-decoration:none}
.pill{font-size:13.5px;padding:4px 10px;border-radius:999px;background:#EFEAFF;color:#4A33C9}
.hero{padding:56px 0 28px}
.hero h1{font-size:clamp(36px,5vw,56px);line-height:1.04;letter-spacing:-.03em;margin:14px 0 14px}
.hero p{font-size:20px;color:#3B3558;max-width:62ch;margin:0}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:32px 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
.stat dt{font-size:14px;color:var(--muted)}
.stat dd{margin:4px 0 0;font-size:26px;font-weight:700;letter-spacing:-.02em}
h2{font-size:26px;letter-spacing:-.02em;margin:36px 0 12px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden}
th,td{text-align:left;padding:14px 18px;border-bottom:1px solid var(--line);font-size:16px}
th{font-size:13.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600;background:#F7F5FF}
tr:last-child td{border-bottom:0}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14.5px}
pre{background:#16122B;color:#EDE9FF;border-radius:14px;padding:18px 20px;overflow:auto;font-size:14px;line-height:1.6}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.step{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px}
.step b{display:block;font-size:18px;margin:0 0 6px}
.step p{margin:0;color:#443E62;font-size:16px}
.muted{color:var(--muted)}
footer{margin-top:64px;border-top:1px solid var(--line);background:#fff}
footer .wrap{display:grid;grid-template-columns:2fr 1fr 1fr;gap:24px;padding:36px 24px;font-size:15px;color:#443E62}
footer h3{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 10px}
footer a{color:#3B3558;text-decoration:none;display:block;margin:0 0 6px}
.fine{border-top:1px solid var(--line);padding:16px 24px;font-size:14px;color:var(--muted)}
@media (max-width:760px){.stats{grid-template-columns:1fr 1fr}.steps{grid-template-columns:1fr}footer .wrap{grid-template-columns:1fr}header nav{display:none}}
</style>
</head>
<body>
<header><div class="wrap">
  <a class="logo" href="/"><span class="mark" aria-hidden="true"></span>Switchboard</a>
  <nav><a href="#how">How it works</a><a href="#routes">Routes</a><a href="#agents">For agents</a><a href="${esc(suretyUrl)}">Surety</a></nav>
</div></header>
<main class="wrap">
  <section class="hero">
    <span class="pill">${esc(label)} · Beta, not audited</span>
    <h1>One endpoint for every bonded API on Monad.</h1>
    <p>Your agent asks for a capability. Switchboard picks the cheapest covered provider that is up, and falls back to the next one if a call fails. Every call goes through Surety, so a failed paid call is refunded on-chain from the provider's bond.</p>
  </section>
  <dl class="stats">
    <div class="stat"><dt>Providers indexed</dt><dd id="s-prov">…</dd></div>
    <div class="stat"><dt>Routable capabilities</dt><dd id="s-caps">…</dd></div>
    <div class="stat"><dt>Lookups served</dt><dd id="s-look">…</dd></div>
    <div class="stat"><dt>Price per lookup</dt><dd>${esc(routePrice)}</dd></div>
  </dl>

  <h2 id="routes">Routes</h2>
  <table><thead><tr><th>Capability</th><th>What it is</th><th>Covered providers</th><th>Best price per call</th></tr></thead>
  <tbody id="caps"><tr><td colspan="4" class="muted">Reading the index…</td></tr></tbody></table>
  <p class="muted" id="indexed"></p>

  <h2 id="how">How it works</h2>
  <div class="steps">
    <div class="step"><b>1. Ask</b><p>The agent asks for a capability, a price cap and a minimum trust score. One small x402 payment per lookup.</p></div>
    <div class="step"><b>2. Call</b><p>It calls the top provider through the Surety relay and pays that provider directly. Switchboard never holds the money.</p></div>
    <div class="step"><b>3. Fall back</b><p>If the call fails its promise, Surety refunds it from the bond and the SDK tries the next provider.</p></div>
  </div>

  <h2 id="agents">For agents</h2>
<pre>const { createSwitchboard } = require("switchboard/sdk");
const sb = createSwitchboard({ url: "https://&lt;this-host&gt;", fetch: payingFetch });

const r = await sb.call("price.mon", { maxPrice: "0.01", minTrust: 30 });
console.log(r.provider, r.verdict, await r.response.json());</pre>
</main>
<footer>
  <div class="wrap">
    <div><a class="logo" href="/"><span class="mark" aria-hidden="true"></span>Switchboard</a><p>Routing for x402 APIs bonded on Surety. Agents pay providers directly; refunds come from on-chain bonds.</p></div>
    <div><h3>Product</h3><a href="/v1/capabilities">Capabilities (JSON)</a><a href="/v1/stats">Stats (JSON)</a><a href="#agents">SDK</a></div>
    <div><h3>Surety</h3><a href="${esc(suretyUrl)}">surety.buzz</a><a href="${esc(suretyUrl)}/providers/">Bonded providers</a><a href="${esc(suretyUrl)}/bond/">Bond your API</a></div>
  </div>
  <div class="fine">Beta on ${esc(label)}. The Surety vault is not audited; keep amounts small.</div>
</footer>
<script>
(function () {
  var e = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var usd = function (a) { return a == null ? "–" : "$" + (Number(a) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\\.$/, ""); };
  fetch("/v1/capabilities").then(function (r) { return r.json(); }).then(function (d) {
    var caps = d.capabilities || [];
    document.getElementById("s-prov").textContent = d.providers;
    document.getElementById("s-caps").textContent = caps.filter(function (c) { return c.routable > 0; }).length;
    document.getElementById("caps").innerHTML = caps.length ? caps.map(function (c) {
      return "<tr><td><code>" + e(c.capability) + "</code></td><td>" + e(c.description || "") + "</td><td>" + c.routable + "</td><td>" + usd(c.bestPrice) + "</td></tr>";
    }).join("") : '<tr><td colspan="4" class="muted">Nothing indexed yet.</td></tr>';
    if (d.indexedAt) document.getElementById("indexed").textContent = "Index refreshed " + new Date(d.indexedAt).toLocaleTimeString() + ". Prices are read from each provider's own x402 answer.";
  }).catch(function () { document.getElementById("caps").innerHTML = '<tr><td colspan="4" class="muted">Couldn\\'t read the index. Reload to try again.</td></tr>'; });
  fetch("/v1/stats").then(function (r) { return r.json(); }).then(function (d) { document.getElementById("s-look").textContent = d.lookups; }).catch(function () {});
})();
</script>
</body>
</html>`;
}

module.exports = { dashboardPage };
