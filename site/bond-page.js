// "Bond your API": the self-serve page where a provider lists an API and posts
// its bond from the browser, with their own wallet. No crypto library is loaded:
// the server builds each transaction (site/bond-api.js) and the wallet signs it.
const { head, NET } = require("./theme");
const { nav, navCss } = require("./nav");
const { footer, footerCss } = require("./footer");

const CSS = `
.bond{padding:34px 0 0}
.bond h1{font-size:clamp(38px,5vw,60px);line-height:1.02;letter-spacing:-.03em;margin:0 0 12px}
.bond .standfirst{font-size:21px;color:#3B3558;margin:0 0 30px;max-width:60ch}
.grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:28px;align-items:start}
ol.flow{list-style:none;margin:0;padding:0;counter-reset:s;display:grid;gap:14px}
ol.flow>li{counter-increment:s;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px 24px}
ol.flow>li.locked{opacity:.55}
ol.flow>li.done{border-color:#BFE9D6}
ol.flow h2{font-size:22px;letter-spacing:-.015em;margin:0 0 4px;display:flex;gap:12px;align-items:baseline}
ol.flow h2::before{content:counter(s);flex:none;width:30px;height:30px;border-radius:50%;background:var(--brand);color:#fff;font-size:16px;display:inline-flex;align-items:center;justify-content:center;transform:translateY(-2px)}
ol.flow>li.done h2::before{content:"✓";background:var(--pass)}
ol.flow p{margin:0 0 14px;color:#443E62;font-size:17px}
.row{display:flex;flex-wrap:wrap;gap:10px}
.row input{flex:1 1 240px;min-width:0}
input[type=text],input[type=url]{font:inherit;font-size:17px;padding:12px 14px;border:1.5px solid #CFC8EA;border-radius:11px;background:#fff;color:var(--ink);min-height:48px;width:100%}
input:focus{outline:3px solid var(--purple);outline-offset:1px;border-color:var(--purple)}
label{display:block;font-size:15.5px;font-weight:500;margin:0 0 6px}
button.act{font:inherit;font-size:17px;font-weight:500;padding:0 20px;min-height:48px;border-radius:11px;border:0;background:var(--brand);color:#fff;cursor:pointer}
button.act.quiet{background:transparent;color:var(--ink);border:1.5px solid #CFC8EA}
button.act[disabled]{opacity:.5;cursor:not-allowed}
.msg{margin:14px 0 0;padding:12px 14px;border-radius:11px;font-size:16.5px;background:#EEEAFB}
.msg.ok{background:#DDF6EA;color:#0A5237}
.msg.err{background:#FBE3E6;color:#8A1C2B}
.msg:empty{display:none}
.msg ul{margin:8px 0 0;padding-left:20px}
.msg code{overflow-wrap:anywhere}
.grid>*{min-width:0}
.side .mono{word-break:break-all}
.side{position:sticky;top:18px;background:var(--night);color:#F3F0FF;border-radius:18px;padding:22px 24px}
.side h2{font-size:20px;margin:0 0 14px}
.side dl{margin:0;display:grid;gap:12px}
.side dt{font-size:14.5px;color:var(--lilac)}
.side dd{margin:2px 0 0;font-size:19px;font-weight:700;overflow-wrap:anywhere}
.side dd.small{font-size:14px;font-weight:400}
.side .on{color:var(--pass-soft)}.side .off{color:var(--refund-soft)}
.side p{font-size:15px;color:#BDB3EA;margin:16px 0 0}
.side a{color:#fff}
.manage{margin:14px 0 0}
.manage summary{cursor:pointer;font-weight:500;padding:8px 0}
.fine{font-size:15px;color:var(--muted);margin:22px 0 0;max-width:70ch}
@media (max-width:900px){.grid{grid-template-columns:1fr}.side{position:static;order:-1}}
@media (max-width:520px){ol.flow>li{padding:18px}button.act{width:100%}}
`;

function bondPage({ url, vaultAddress, usdcAddress, chainId, repoUrl, explorer = NET.explorer }) {
  const description = `List your paid API on Surety and post its bond from your browser, with your own wallet. ${NET.real ? "Monad mainnet, real USDC, unaudited beta." : "Monad testnet, test funds only."}`;
  const cfg = JSON.stringify({ chainId, vault: vaultAddress, usdc: usdcAddress, url, explorer, chainName: NET.chainName, networkName: NET.fullName, rpc: NET.chainId === chainId ? NET.rpc : null }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
${head({
  title: "Bond your API | Surety",
  description,
  url: `${url}/bond/`,
  siteUrl: url,
  jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: "Bond your API on Surety", description, url: `${url}/bond/` },
  css: navCss + footerCss + CSS,
})}
</head>
<body>
<div class="wrap">
${nav({ current: "bond" })}
<main class="bond">
  <h1>Bond your API</h1>
  <p class="standfirst">List a paid x402 API and put a bond behind it, from this page, with your own wallet. ${NET.real ? "This is Monad mainnet: the bond is real USDC, and the contract has not been audited. Bond only what you can afford to lose." : "Everything here uses Monad testnet and test USDC."}</p>

  <div class="grid">
    <ol class="flow">
      <li id="s-sla">
        <h2>Check your promise</h2>
        <p>Paste the address of your SLA document: the JSON file that says how fast each endpoint answers and what shape the answer has. <a href="/docs/#the-sla-document">See the format.</a></p>
        <label for="sla-url">SLA document address</label>
        <div class="row"><input id="sla-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/sla.json"><button class="act" id="sla-btn" type="button">Check it</button></div>
        <div class="msg" id="sla-msg" role="status"></div>
      </li>
      <li id="s-wallet" class="locked">
        <h2>Connect your wallet</h2>
        <p>Use the wallet that will own this listing. It needs a little ${NET.real ? "MON for gas and USDC" : "test MON for gas and test USDC"} for the bond.</p>
        <button class="act" id="wallet-btn" type="button" disabled>Connect wallet</button>
        <div class="msg" id="wallet-msg" role="status"></div>
      </li>
      <li id="s-list" class="locked">
        <h2>List your API</h2>
        <p>One transaction that records your SLA address on the vault. It moves no money.</p>
        <button class="act" id="list-btn" type="button" disabled>List it</button>
        <div class="msg" id="list-msg" role="status"></div>
      </li>
      <li id="s-bond" class="locked">
        <h2>Post your bond</h2>
        <p>Two transactions: one lets the vault take exactly the amount you choose, the next moves it into your bond. Refunds for calls that break your promise come out of it.</p>
        <label for="amount">Amount in USDC</label>
        <div class="row"><input id="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.6"><button class="act" id="bond-btn" type="button" disabled>Post bond</button></div>
        <div class="msg" id="bond-msg" role="status"></div>
        <details class="manage" id="manage" hidden>
          <summary>Take bond out</summary>
          <p>Queue an amount for withdrawal. It waits out the delay, can still be used for refunds meanwhile, and your calls stop being covered if it takes you under the minimum.</p>
          <label for="w-amount">Amount in USDC</label>
          <div class="row"><input id="w-amount" type="text" inputmode="decimal" autocomplete="off"><button class="act quiet" id="w-btn" type="button">Queue withdrawal</button></div>
          <div class="row" style="margin-top:10px"><button class="act quiet" id="w-cancel" type="button">Cancel queued withdrawal</button><button class="act quiet" id="w-done" type="button">Collect it</button></div>
          <div class="msg" id="w-msg" role="status"></div>
        </details>
      </li>
    </ol>

    <aside class="side" aria-live="polite">
      <h2>Your listing</h2>
      <dl>
        <div><dt>Wallet</dt><dd class="small mono" id="v-wallet">Not connected</dd></div>
        <div><dt>Status</dt><dd id="v-status">Not listed</dd></div>
        <div><dt>Bond</dt><dd id="v-bond">0.00 USDC</dd></div>
        <div><dt>Minimum to be covered</dt><dd id="v-min">…</dd></div>
        <div><dt>USDC in your wallet</dt><dd id="v-bal">…</dd></div>
        <div id="v-callrow" hidden><dt>Agents call you at</dt><dd class="small mono" id="v-call"></dd></div>
      </dl>
      <p id="v-links" hidden><a id="v-trust" href="#">Your live record</a> &nbsp; <a href="/providers/">Directory</a></p>
      <p>Vault <span class="mono">${vaultAddress}</span></p>
    </aside>
  </div>
  <p class="fine">${NET.real ? "This is a beta on Monad mainnet, with real money." : "This is an experiment on a test network."} One relay, run by Surety's developer, decides whether a call kept its promise, and its decision moves money out of your bond. The contracts are tested but not audited. ${NET.real ? "Bond only what you can afford to lose." : "Use test funds only."} Each step shows you exactly what it will do before your wallet asks you to sign.</p>
</main>
${footer({ vaultAddress, repoUrl })}
</div>
<script>
(function () {
  var CFG = ${cfg};
  var $ = function (id) { return document.getElementById(id); };
  var state = { sla: null, slaUrl: "", account: null, info: null };
  var eth = window.ethereum;

  var usd = function (micro) {
    var t = (Number(micro) / 1e6).toFixed(6).replace(/0+$/, ""), d = t.split(".")[1] || "";
    return d.length >= 2 ? t : (Number(micro) / 1e6).toFixed(2);
  };
  // "0.6" -> "600000" without floating point
  var toUnits = function (s) {
    s = String(s).trim().replace(",", ".");
    if (!/^\\d+(\\.\\d{1,6})?$/.test(s)) return null;
    var p = s.split("."), frac = (p[1] || "") + "000000".slice((p[1] || "").length);
    var out = (p[0] + frac).replace(/^0+/, "");
    return out || null;
  };
  var msg = function (id, text, kind) { var el = $(id); el.className = "msg" + (kind ? " " + kind : ""); el.innerHTML = text || ""; };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var get = function (path) { return fetch(path).then(function (r) { return r.json(); }); };
  var step = function (id, cls) { $(id).className = cls || ""; };
  var why = function (e) {
    if (e && (e.code === 4001 || /reject|denied/i.test(e.message || ""))) return "You cancelled it in your wallet. Nothing was sent.";
    return esc((e && (e.shortMessage || e.message)) || "Something went wrong.").slice(0, 220);
  };

  function render() {
    var a = state.info;
    $("wallet-btn").disabled = !state.sla;
    step("s-sla", state.sla ? "done" : "");
    step("s-wallet", !state.sla ? "locked" : state.account ? "done" : "");
    if (!a) { step("s-list", "locked"); step("s-bond", "locked"); return; }
    var listedHere = a.registered && a.metadataURI === state.slaUrl;
    $("v-wallet").textContent = a.address;
    $("v-status").textContent = !a.registered ? "Not listed" : a.active ? "Active: calls are covered" : "Listed, not covered yet";
    $("v-status").className = a.active ? "on" : a.registered ? "off" : "";
    $("v-bond").textContent = usd(a.bond) + " USDC";
    $("v-min").textContent = usd(a.minBond) + " USDC";
    $("v-bal").textContent = usd(a.usdcBalance) + " USDC";
    $("v-callrow").hidden = !a.registered;
    $("v-links").hidden = !a.registered;
    if (a.registered) {
      $("v-call").textContent = CFG.url + "/call/" + a.address + "/<your path>";
      $("v-trust").href = "/trust/" + a.address;
    }
    step("s-list", listedHere ? "done" : "");
    $("list-btn").disabled = listedHere;
    $("list-btn").textContent = !a.registered ? "List it" : listedHere ? "Listed" : "Update the SLA address";
    step("s-bond", !a.registered ? "locked" : a.active ? "done" : "");
    $("bond-btn").disabled = !a.registered;
    $("bond-btn").textContent = Number(a.bond) > 0 ? "Add to bond" : "Post bond";
    if (!$("amount").value) {
      var need = Number(a.minBond) - Number(a.bond);
      $("amount").value = need > 0 ? usd(Math.ceil(need * 1.2)) : "";
    }
    $("manage").hidden = Number(a.bond) === 0;
    var pending = Number(a.bondPendingWithdraw) > 0;
    $("w-cancel").hidden = $("w-done").hidden = !pending;
    if (pending) {
      var ready = new Date(a.bondReadyAt * 1000);
      msg("w-msg", usd(a.bondPendingWithdraw) + " USDC is queued. It can be collected from " + ready.toLocaleString() + ", for 3 days.");
    }
    if (a.active && listedHere) msg("bond-msg", "You are listed and covered. Agents can call you through the address shown under Your listing.", "ok");
  }

  function refresh() {
    if (!state.account) return Promise.resolve();
    return get("/bond/account?address=" + state.account).then(function (a) { if (a.ok) { state.info = a; render(); } });
  }

  // ---- 1. SLA
  $("sla-btn").addEventListener("click", function () {
    var url = $("sla-url").value.trim();
    msg("sla-msg", "Fetching and checking it…");
    $("sla-btn").disabled = true;
    get("/bond/sla-check?url=" + encodeURIComponent(url)).then(function (r) {
      if (!r.ok) { state.sla = null; msg("sla-msg", esc(r.error), "err"); return; }
      state.sla = r; state.slaUrl = url;
      msg("sla-msg", "Valid. It promises " + r.endpoints.length + (r.endpoints.length === 1 ? " endpoint" : " endpoints") + " at " + esc(r.baseUrl) + ", paid to <code>" + esc(r.payTo) + "</code>:<ul>" +
        r.endpoints.map(function (e) { return "<li><code>" + esc(e.method + " " + e.path) + "</code> within " + (e.maxLatencyMs / 1000) + " s" + (e.checksShape ? ", shape checked" : "") + "</li>"; }).join("") + "</ul>", "ok");
    }).catch(function () { msg("sla-msg", "Could not run the check. Try again.", "err"); })
      .then(function () { $("sla-btn").disabled = false; render(); });
  });
  $("sla-url").addEventListener("keydown", function (e) { if (e.key === "Enter") $("sla-btn").click(); });

  // ---- 2. wallet
  function onNetwork() {
    var hex = "0x" + CFG.chainId.toString(16);
    return eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }).catch(function (e) {
      if (e && e.code === 4902 && CFG.rpc) {
        return eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: CFG.chainName, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: [CFG.rpc], blockExplorerUrls: [CFG.explorer] }] });
      }
      throw e;
    });
  }
  $("wallet-btn").addEventListener("click", function () {
    if (!eth) { msg("wallet-msg", "No wallet was found in this browser. Install one such as MetaMask or Rabby. On a phone, open this page inside your wallet app's own browser.", "err"); return; }
    msg("wallet-msg", "Waiting for your wallet…");
    eth.request({ method: "eth_requestAccounts" }).then(function (accts) {
      state.account = accts[0];
      return onNetwork();
    }).then(function () { msg("wallet-msg", "Connected on " + CFG.networkName + ".", "ok"); return refresh(); })
      .catch(function (e) { state.account = null; msg("wallet-msg", why(e), "err"); render(); });
  });
  if (eth && eth.on) eth.on("accountsChanged", function (a) { state.account = a[0] || null; state.info = null; $("amount").value = ""; if (state.account) refresh(); else render(); });

  // ---- sending one prepared transaction and waiting for it to land
  function send(kind, params, box) {
    var qs = "/bond/tx?kind=" + kind + Object.keys(params || {}).map(function (k) { return "&" + k + "=" + encodeURIComponent(params[k]); }).join("");
    return get(qs).then(function (tx) {
      if (!tx.ok) throw new Error(tx.error);
      msg(box, esc(tx.does) + " Confirm it in your wallet…");
      return onNetwork().then(function () { return eth.request({ method: "eth_sendTransaction", params: [{ from: state.account, to: tx.to, data: tx.data }] }); });
    }).then(function (hash) {
      msg(box, 'Sent. Waiting for it to confirm… <a href="' + CFG.explorer + "/tx/" + hash + '" rel="noopener">View</a>');
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          eth.request({ method: "eth_getTransactionReceipt", params: [hash] }).then(function (r) {
            if (r && r.status) return r.status === "0x1" ? resolve(hash) : reject(new Error("The transaction was rejected by the network."));
            if (++tries > 60) return reject(new Error("Still not confirmed after a minute. Check it in your wallet, then reload this page."));
            setTimeout(poll, 1000);
          }).catch(reject);
        })();
      });
    });
  }
  var busy = function (btn, on) { $(btn).disabled = on; };

  // ---- 3. list
  $("list-btn").addEventListener("click", function () {
    busy("list-btn", true);
    send(state.info.registered ? "setMetadata" : "register", { url: state.slaUrl }, "list-msg")
      .then(function () { msg("list-msg", "Done. Your API is listed.", "ok"); return refresh(); })
      .catch(function (e) { msg("list-msg", why(e), "err"); busy("list-btn", false); });
  });

  // ---- 4. bond
  $("bond-btn").addEventListener("click", function () {
    var units = toUnits($("amount").value);
    if (!units) { msg("bond-msg", "Enter an amount like 0.6, with up to 6 decimal places.", "err"); return; }
    if (Number(units) > Number(state.info.usdcBalance)) { msg("bond-msg", "Your wallet holds " + usd(state.info.usdcBalance) + ' USDC. Get test USDC from <a href="https://faucet.circle.com" rel="noopener">faucet.circle.com</a> (USDC, Monad Testnet).', "err"); return; }
    busy("bond-btn", true);
    var first = Number(state.info.allowance) >= Number(units) ? Promise.resolve() : send("approve", { amount: units }, "bond-msg");
    first.then(function () { return send("deposit", { amount: units }, "bond-msg"); })
      .then(function () { $("amount").value = ""; msg("bond-msg", "Bond posted.", "ok"); return refresh(); })
      .catch(function (e) { msg("bond-msg", why(e), "err"); })
      .then(function () { busy("bond-btn", false); });
  });

  // ---- taking bond out
  var manage = function (btn, kind, params, done) {
    $(btn).addEventListener("click", function () {
      var p = params();
      if (p === null) { msg("w-msg", "Enter an amount like 0.2.", "err"); return; }
      busy(btn, true);
      send(kind, p, "w-msg").then(function () { msg("w-msg", done, "ok"); return refresh(); })
        .catch(function (e) { msg("w-msg", why(e), "err"); }).then(function () { busy(btn, false); });
    });
  };
  manage("w-btn", "withdraw", function () { var u = toUnits($("w-amount").value); return u ? { amount: u } : null; }, "Queued.");
  manage("w-cancel", "cancelWithdraw", function () { return {}; }, "Cancelled. Your full bond counts again.");
  manage("w-done", "completeWithdraw", function () { return {}; }, "Collected. The USDC is back in your wallet.");

  get("/bond/account?address=0x0000000000000000000000000000000000000001").then(function (a) { if (a.ok) $("v-min").textContent = usd(a.minBond) + " USDC"; });
  render();
})();
</script>
</body>
</html>`;
}

module.exports = { bondPage };
