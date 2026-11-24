// The human-facing homepage. Agents asking for JSON still get JSON from "/".
// The hero is a working demo: it runs real paid calls through /demo/run and
// shows the pass or the on-chain refund as it happens.
const { esc, head } = require("../site/theme");
const { nav, navCss } = require("../site/nav");
const { footer, footerCss } = require("../site/footer");

const PAGE_CSS = `
.intro{padding:44px 0 34px;max-width:900px}
h1{font-size:clamp(40px,5.6vw,72px);line-height:1;letter-spacing:-.035em;font-weight:700;margin:0 0 18px}
.lede{font-size:21px;line-height:1.45;color:#3B3558;max-width:56ch;margin:0}

/* The demo console: the one loud object on the page. */
.console{background:var(--night);color:#F3F0FF;border-radius:22px;padding:30px 32px 26px;margin:6px 0 0;box-shadow:0 30px 60px -36px rgba(27,18,66,.75)}
.console h2{font-size:clamp(24px,2.6vw,32px);letter-spacing:-.02em;line-height:1.15;margin:0 0 6px;font-weight:700}
.console .hint{color:var(--lilac);margin:0 0 22px;font-size:17px;max-width:62ch}
.runs{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:26px}
.run{font:inherit;font-weight:500;font-size:18px;padding:15px 22px;border-radius:12px;border:2px solid transparent;cursor:pointer;text-align:left;line-height:1.2}
.run small{display:block;font-size:14px;font-weight:400;opacity:.85;margin-top:3px}
.run.good{background:var(--purple);color:#fff}
.run.slow{background:transparent;color:#fff;border-color:var(--night-line)}
.run[disabled]{opacity:.55;cursor:progress}
ol.trace{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:0;border-top:1px solid var(--night-line)}
ol.trace li{padding:18px 18px 4px 0;border-right:1px solid var(--night-line);padding-left:18px;min-height:132px}
ol.trace li:first-child{padding-left:0}
ol.trace li:last-child{border-right:0}
.trace .n{display:flex;align-items:center;gap:9px;font-size:15px;color:var(--lilac)}
.trace .pip{width:11px;height:11px;border-radius:50%;border:2px solid var(--night-line);flex:none}
.trace li.live .pip{border-color:var(--lilac);animation:pulse 1s ease-in-out infinite}
.trace li.done .pip{background:var(--pass-soft);border-color:var(--pass-soft)}
.trace li.refunded .pip{background:var(--refund-soft);border-color:var(--refund-soft)}
.trace .v{font-size:25px;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin:10px 0 4px;min-height:29px}
.trace .d{font-size:15px;color:#CFC8F2;line-height:1.4}
.trace .d a{color:#fff}
.trace li.refunded .v{color:var(--refund-soft)}
.trace li.done.outcome .v{color:var(--pass-soft)}
.verdict{margin:20px 0 0;padding:14px 18px;border-radius:12px;background:#261A58;font-size:17.5px;min-height:54px;display:flex;align-items:center}
.verdict.err{background:#4A1B2B}
.fine{margin:14px 0 0;font-size:14.5px;color:#A99FD6}
@keyframes pulse{50%{opacity:.25}}

.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:0;background:var(--panel);border:1px solid var(--line);border-radius:16px;margin:18px 0 0;box-shadow:var(--lift)}
.facts div{padding:18px 22px;border-right:1px solid var(--line)}
.facts div:last-child{border-right:0}
.facts dt{font-size:14.5px;color:var(--muted)}
.facts dd{margin:3px 0 0;font-size:22px;font-weight:700;letter-spacing:-.015em}
.facts dd.on{color:var(--pass)}
.facts dd.off{color:var(--refund)}

section{padding:72px 0 0}
h2.title{font-size:clamp(28px,3.4vw,42px);letter-spacing:-.025em;line-height:1.08;margin:0 0 12px;font-weight:700}
.sub{color:var(--muted);max-width:58ch;margin:0 0 28px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:52px;align-items:start}
.term{background:var(--night);border-radius:16px;overflow:hidden;color:#E9E4FF}
.term-bar{display:flex;justify-content:space-between;align-items:center;padding:10px 12px 10px 20px;border-bottom:1px solid var(--night-line);color:var(--lilac);font-size:15px}
.copy{font:inherit;font-size:15px;font-weight:500;color:#fff;background:transparent;border:1.5px solid var(--night-line);border-radius:8px;padding:6px 14px;cursor:pointer}
.term pre{margin:0;padding:20px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:14.5px;line-height:1.7}
.term .c{color:#8F84C4}
.use .job{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:24px 26px;height:100%;box-shadow:var(--lift)}
.use{gap:20px;align-items:stretch}
.use h3{font-size:24px;letter-spacing:-.02em;margin:0 0 8px}
.use p{margin:0 0 16px;color:#443E62}
.use p.small{font-size:15.5px;color:var(--muted);margin:12px 0 0}
.go{display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:17px;font-weight:500;min-height:48px;padding:0 20px;border-radius:11px;border:0;background:var(--purple);color:#fff;text-decoration:none;cursor:pointer}
.use label{display:block;font-size:15.5px;font-weight:500;margin:0 0 6px}
.lookup{display:flex;flex-wrap:wrap;gap:10px}
.lookup input{flex:1 1 220px;min-width:0;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:14px;padding:12px;border:1.5px solid #CFC8EA;border-radius:11px;min-height:48px;background:#fff;color:var(--ink)}
.lk-out{margin-top:14px;font-size:16.5px}
.lk-out:empty{display:none}
.lk-out dl{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;margin:0 0 12px}
.lk-out dt{font-size:14px;color:var(--muted)}
.lk-out dd{margin:1px 0 0;font-weight:700}
.lk-out .call{background:var(--night);color:#E9E4FF;border-radius:11px;padding:12px 14px;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:13.5px;overflow-wrap:anywhere}
.lk-out .err{color:#8A1C2B}
ul.explore{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:0 52px;border-top:1px solid var(--line)}
ul.explore li{padding:18px 0;border-bottom:1px solid var(--line)}
ul.explore a{font-size:22px;font-weight:700;letter-spacing:-.015em;text-decoration:none;color:var(--ink);display:block}
ul.explore span{color:#443E62;font-size:16.5px;display:block;margin-top:2px;max-width:46ch}
ul.plain{margin:0;padding:0;list-style:none}
ul.plain li{padding:14px 0;border-bottom:1px solid var(--line)}
ul.plain li:first-child{padding-top:0}
ul.plain strong{display:block;font-weight:700}
ul.plain span{color:#443E62;font-size:16.5px}
.limits ul.plain strong{color:var(--refund)}
@media (max-width:900px){
  ol.trace{grid-template-columns:1fr 1fr}
  ol.trace li{border-bottom:1px solid var(--night-line);min-height:0;padding:16px 14px 16px 0}
  ol.trace li:nth-child(odd){padding-left:0}
  ol.trace li:nth-child(even){border-right:0;padding-left:16px}
  .facts{grid-template-columns:1fr 1fr}
  .facts div:nth-child(2){border-right:0}
  .facts div:nth-child(-n+2){border-bottom:1px solid var(--line)}
  .two{grid-template-columns:1fr;gap:36px}
  ul.explore{grid-template-columns:1fr}
  section{padding-top:56px}
}
@media (max-width:520px){
  .console{padding:24px 20px 22px;border-radius:18px}
  .run{width:100%;min-height:60px}
  h1{font-size:38px}
  .lede{font-size:19px}
  .facts dd{font-size:19px}
  .facts div{padding:14px 16px}
  ol.trace{grid-template-columns:1fr}
  ol.trace li,ol.trace li:nth-child(even){border-right:0;padding-left:0}
}
@media (prefers-reduced-motion:reduce){.trace li.live .pip{animation:none}}
`;

function landingPage({ url, provider, vaultAddress, repoUrl, price }) {
  const cmd = `node examples/call-api.js ${url} ${provider}`;
  const description =
    "API providers post a bond. If a paid x402 call comes back slow or broken, the agent is refunded on-chain. Run a live call on Monad testnet.";
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Surety",
    url: `${url}/`,
    description,
  };
  return `<!doctype html>
<html lang="en">
<head>
${head({
  title: "Surety: bond-backed refunds for AI agent payments",
  description,
  url: `${url}/`,
  siteUrl: url,
  jsonLd,
  css: navCss + footerCss + PAGE_CSS,
})}
</head>
<body>
<div class="wrap">
${nav({ current: "home", repoUrl })}

<main>
<div class="intro">
  <h1>Your agent shouldn't pay for garbage.</h1>
  <p class="lede">API providers post a bond. When a paid x402 call comes back slow or broken, the agent gets its money back on-chain. Run one below and watch.</p>
</div>

<div class="console" id="demo">
  <h2>Run a real paid call</h2>
  <p class="hint">Each button pays ${esc(price)} to a live API on Monad testnet, through Surety. The slow one is built to miss its promise, so the bond refunds it.</p>
  <div class="runs">
    <button class="run good" type="button" data-kind="good">Run a good call<small>Buys the live MON price</small></button>
    <button class="run slow" type="button" data-kind="slow">Run a slow call<small>Triggers a refund from the bond</small></button>
  </div>
  <ol class="trace" aria-live="polite">
    <li id="t-pay"><div class="n"><span class="pip"></span>Agent pays</div><div class="v">${esc(price)}</div><div class="d">Paid over x402, in test USDC.</div></li>
    <li id="t-answer"><div class="n"><span class="pip"></span>Provider answers</div><div class="v">&nbsp;</div><div class="d">Timed from request to full response.</div></li>
    <li id="t-check"><div class="n"><span class="pip"></span>Surety checks</div><div class="v">&nbsp;</div><div class="d">Status, speed and shape against the promise.</div></li>
    <li id="t-outcome" class="outcome"><div class="n"><span class="pip"></span>Outcome</div><div class="v">&nbsp;</div><div class="d">Pass, or a refund from the bond.</div></li>
  </ol>
  <p class="verdict" id="verdict" role="status">Nothing run yet in this visit. Pick a call.</p>
  <p class="fine">Demo calls are paid by Surety's own test wallet, so you don't need one. Fresh runs are spaced out; a repeat click may show the run from a moment ago.</p>
</div>

<dl class="facts" aria-label="Live record of the first provider">
  <div><dt>Bond posted</dt><dd id="f-bond">…</dd></div>
  <div><dt>Coverage</dt><dd id="f-state">…</dd></div>
  <div><dt>Refunds paid from the bond</dt><dd id="f-claims">…</dd></div>
  <div><dt>Trust score</dt><dd id="f-score">…</dd></div>
</dl>

<section id="use">
  <h2 class="title">Use it</h2>
  <p class="sub">Surety does two jobs, one for each side of a paid API call.</p>
  <div class="two use">
    <div class="job">
      <h3>You run a paid API</h3>
      <p>List it and put a bond behind it. Agents can see what you promise and what you stand to lose, which is a reason to pick you over an API with nothing at stake.</p>
      <a class="go" href="/bond/">Bond your API</a>
      <p class="small">Done in the browser with your own wallet. About five minutes on testnet.</p>
    </div>
    <div class="job">
      <h3>You build agents</h3>
      <p>Check a provider before your agent pays it, then call it through Surety so a broken call is refunded.</p>
      <label for="lk">Provider address</label>
      <div class="lookup"><input id="lk" type="text" spellcheck="false" autocomplete="off" value="${esc(provider)}"><button class="go" id="lk-btn" type="button">Check</button></div>
      <div class="lk-out" id="lk-out" role="status"></div>
    </div>
  </div>
</section>

<section id="try">
  <div class="two">
    <div>
      <h2 class="title">Now call it with your own wallet</h2>
      <p class="sub">The first bonded provider is a small price API. It reads the MON price straight from on-chain pools and sells each answer for ${esc(price)}. You need Node 18 or newer and a wallet with a little Monad testnet USDC. No gas.</p>
      <ul class="plain">
        <li><strong>Free test USDC</strong><span>From <a href="https://faucet.circle.com">faucet.circle.com</a>: choose USDC, then Monad Testnet.</span></li>
        <li><strong>Read before you run</strong><span>The <a href="/.well-known/surety.json">promise it is bonded against</a> and its <a href="/trust/${esc(provider)}">live trust record</a>.</span></li>
      </ul>
    </div>
    <div class="term">
      <div class="term-bar"><span>Terminal</span><button class="copy" id="copy" type="button">Copy</button></div>
<pre id="cmd"><span class="c"># get the client</span>
git clone ${esc(repoUrl)}.git
cd surety && npm install --omit=dev

<span class="c"># pay for one call with your testnet key</span>
export AGENT_KEY=0xYourKey
${esc(cmd)}</pre>
    </div>
  </div>
</section>

<section>
  <h2 class="title">Go deeper</h2>
  <p class="sub">The demo shows one call. These explain the rest.</p>
  <ul class="explore">
    <li><a href="/how-it-works/">How it works</a><span>The three roles, one call from start to finish, and why the bond can't vanish.</span></li>
    <li><a href="/providers/">Provider directory</a><span>Every bonded API with its live bond, refund history and trust score.</span></li>
    <li><a href="/docs/">Docs</a><span>The relay address format, response headers, the SLA document and the vault functions.</span></li>
    <li><a href="/articles/bond-your-x402-api/">Bonding walkthrough</a><span>The same steps as the Bond your API page, explained for people who prefer code.</span></li>
    <li><a href="/faq/">FAQ</a><span>Real money? Audited? Who decides? Is there a token? Straight answers.</span></li>
    <li><a href="/articles/">Articles</a><span>Longer writing on refunds, bonds and paying agents fairly.</span></li>
  </ul>
</section>

<section class="limits">
  <div class="two">
    <div>
      <h2 class="title">What this is today</h2>
      <p class="sub">An experiment that works end to end on a test network. It is not ready for real money, and here is why.</p>
    </div>
    <ul class="plain">
      <li><strong>Testnet only</strong><span>Every bond, payment and refund here is test USDC with no value.</span></li>
      <li><strong>Not audited</strong><span>The contracts have tests, including randomised ones, but no independent review.</span></li>
      <li><strong>One trusted relay</strong><span>A single operator checks calls and files refunds. Its rules and code are public.</span></li>
      <li><strong>One provider so far</strong><span>The price API is run by the same person who built Surety.</span></li>
    </ul>
  </div>
</section>
</main>

${footer({ vaultAddress, repoUrl })}
</div>

<script>
(function () {
  var PROVIDER = "${esc(provider)}";
  var $ = function (id) { return document.getElementById(id); };
  var usd = function (micro) {
    var t = (Number(micro) / 1e6).toFixed(6).replace(/0+$/, "");
    var d = t.split(".")[1] || "";
    return d.length >= 2 ? t : (Number(micro) / 1e6).toFixed(2);
  };
  var ms = function (n) { return Number(n).toLocaleString("en-US") + " ms"; };
  var txLink = function (r, tx, label) { return '<a href="' + r.explorer + "/tx/" + tx + '" rel="noopener">' + label + "</a>"; };
  var steps = ["t-pay", "t-answer", "t-check", "t-outcome"];
  var set = function (id, cls, v, d) {
    var li = $(id);
    li.className = (id === "t-outcome" ? "outcome " : "") + cls;
    if (v != null) li.querySelector(".v").innerHTML = v;
    if (d != null) li.querySelector(".d").innerHTML = d;
  };
  var ago = function (at) {
    var s = Math.max(1, Math.round((Date.now() - at) / 1000));
    return s < 90 ? s + " seconds ago" : Math.round(s / 60) + " minutes ago";
  };

  function facts() {
    fetch("/trust/" + PROVIDER).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (t) {
      $("f-bond").textContent = usd(t.bond) + " USDC";
      $("f-state").textContent = t.active ? "Active" : "Paused";
      $("f-state").className = t.active ? "on" : "off";
      $("f-claims").textContent = t.claimCount + " (" + usd(t.claimsPaid) + " USDC)";
      $("f-score").textContent = t.score + " of 100";
    }).catch(function () {
      ["f-bond", "f-state", "f-claims", "f-score"].forEach(function (id) { $(id).textContent = "unavailable"; });
    });
  }

  function show(r) {
    var passed = r.verdict === "pass";
    set("t-pay", "done", null, r.paymentTx ? txLink(r, r.paymentTx, "See the payment") + " on the explorer." : "Paid over x402, in test USDC.");
    set("t-answer", "done", ms(r.latencyMs), r.promisedMs ? "Promised within " + ms(r.promisedMs) + "." : "Timed from request to full response.");
    set("t-check", passed ? "done" : "refunded", passed ? "Kept its promise" : (r.reason === "too_slow" ? "Too slow" : "Broke its promise"),
      passed ? "Status, speed and shape all match." : "Slower than the provider said it would be.");
    if (passed) {
      set("t-outcome", "done", "Pass", r.data ? "MON is $" + Number(r.data.priceUsd).toFixed(5) + " at block " + r.data.block + "." : "The provider keeps the payment.");
    } else if (r.refund) {
      set("t-outcome", "refunded", "Refunded " + usd(r.refund.payout) + " USDC", "Taken from the bond. " + txLink(r, r.refund.tx, "See the refund") + " on the explorer.");
    } else {
      set("t-outcome", "refunded", "No refund", r.claimError ? "The claim did not go through: " + String(r.claimError).replace(/[<>&]/g, "") : "This call was not covered.");
    }
    var line = passed
      ? "Passed in " + ms(r.latencyMs) + ". The provider keeps the payment and nothing touches the bond."
      : r.refund
        ? "The agent paid, the answer came late, and the bond paid the agent back without anyone asking."
        : "The call failed its check, but no refund was paid.";
    if (r.replay) line = (r.note || "Showing an earlier run.") + " It ran " + ago(r.at) + ".";
    $("verdict").className = "verdict";
    $("verdict").textContent = line;
  }

  function run(kind) {
    var buttons = document.querySelectorAll(".run");
    buttons.forEach(function (b) { b.disabled = true; });
    steps.forEach(function (id) { set(id, "", id === "t-pay" ? null : "&nbsp;", null); });
    set("t-pay", "live");
    $("verdict").className = "verdict";
    $("verdict").textContent = kind === "slow" ? "Paying, then waiting on a provider that is slow on purpose…" : "Paying and calling the provider…";
    var i = 0;
    var tick = setInterval(function () { // walk the pips while the real call is in flight
      if (i < 3) { $(steps[i]).classList.remove("live"); i += 1; $(steps[i]).classList.add("live"); }
    }, kind === "slow" ? 1500 : 500);
    fetch("/demo/run?kind=" + kind, { method: "POST" })
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || "The demo is unavailable."); return b; }); })
      .then(function (r) { clearInterval(tick); show(r); facts(); })
      .catch(function (e) {
        clearInterval(tick);
        steps.forEach(function (id) { $(id).classList.remove("live"); });
        $("verdict").className = "verdict err";
        $("verdict").textContent = e.message || "The demo is unavailable. Try again in a minute.";
      })
      .then(function () { buttons.forEach(function (b) { b.disabled = false; }); });
  }

  document.querySelectorAll(".run").forEach(function (b) { b.addEventListener("click", function () { run(b.dataset.kind); }); });
  $("copy").addEventListener("click", function () {
    var text = $("cmd").innerText.split("\\n").filter(function (l) { return l && l.charAt(0) !== "#"; }).join("\\n");
    var done = function () { $("copy").textContent = "Copied"; setTimeout(function () { $("copy").textContent = "Copy"; }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done); else done();
  });
  function lookup() {
    var a = $("lk").value.trim(), out = $("lk-out");
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { out.innerHTML = '<p class="err">That is not a wallet address. It should start with 0x and have 40 more characters.</p>'; return; }
    out.textContent = "Reading the vault…";
    fetch("/trust/" + a).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); }).then(function (r) {
      if (!r.ok) { out.innerHTML = '<p class="err">' + (r.b.error === "provider_not_registered" ? "No provider is listed at that address." : "Could not read that address just now.") + "</p>"; return; }
      var t = r.b, rate = t.passRate == null ? "No calls yet" : Math.round(t.passRate * 100) + "% of " + t.calls;
      out.innerHTML = "<dl><div><dt>Coverage</dt><dd>" + (t.active ? "Active" : "Not covered") + "</dd></div><div><dt>Trust score</dt><dd>" + t.score + " of 100</dd></div>" +
        "<div><dt>Bond</dt><dd>" + usd(t.bond) + " USDC</dd></div><div><dt>Calls passed</dt><dd>" + rate + "</dd></div></dl>" +
        '<div class="call">' + location.origin + "/call/" + t.provider + "/&lt;path&gt;</div>";
    }).catch(function () { out.innerHTML = '<p class="err">Could not reach the relay. Try again.</p>'; });
  }
  $("lk-btn").addEventListener("click", lookup);
  $("lk").addEventListener("keydown", function (e) { if (e.key === "Enter") lookup(); });
  facts();
})();
</script>
</body>
</html>`;
}

module.exports = { landingPage };
