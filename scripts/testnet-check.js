// Live check on Monad testnet:  node scripts/testnet-check.js
//
// Runs a real x402-paid API on this machine, bonds it on your vault, puts the
// relay in front of it and makes three paid calls: one healthy, one too slow,
// one with the wrong shape. The two bad ones should be refunded on-chain.
//
// One wallet (PRIVATE_KEY in .env) plays every part: vault owner, arbiter,
// provider and paying agent. It needs a little MON for gas and 1 testnet USDC
// (https://faucet.circle.com -> USDC -> Monad Testnet).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { createRelay } = require("../verifier/relay");
const { createSuretyClient } = require("../sdk");
const { createX402Provider } = require("../examples/x402-provider");
const { createPayingFetch } = require("../examples/x402-client");

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function arbiter() view returns (address)",
  "function minProviderBond() view returns (uint256)",
  "function unbondingDelay() view returns (uint64)",
  "function slashFeeBps() view returns (uint16)",
  "function setParams(uint256,uint64,uint16)",
  "function providers(address) view returns (bool registered, uint64 bondReadyAt, uint64 claimCount, uint128 bond, uint128 bondPendingWithdraw, uint128 backingAssets, uint128 claimsPaid, uint256 backingShares, uint256 backingSharesPending, string metadataURI)",
  "function register(string)",
  "function setMetadata(string)",
  "function depositBond(uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const usd = (n) => ethers.parseUnits(String(n), 6);
const fmt = (v) => `${ethers.formatUnits(v, 6)} USDC`;

/**
 * @param {object} c
 * @param {import("ethers").Wallet} c.wallet   connected to the network
 * @param {string} c.vaultAddress
 * @param {string} c.usdcAddress
 * @param {string} c.network                   CAIP-2 id
 * @param {string} c.facilitatorUrl
 * @param {string} [c.explorer]
 * @param {number} [c.slowMs] @param {number} [c.slowMaxMs]
 * @param {number} [c.apiPort] @param {number} [c.relayPort]
 * @param {(ctx: {payTo: string}) => {listen: Function, close: Function, slaUrl: Function}} [c.createApi]
 *        the paid API to bond and call; defaults to the three-endpoint demo API
 * @param {Array<[string, "pass"|"fail"]>} [c.calls]  paths to call and the verdict each should get
 * @param {boolean} [c.showBody]  print each successful response
 * @param {boolean} [c.ownerElsewhere]  the vault owner is a different wallet (as on mainnet): this wallet only
 *        needs to be the arbiter, and the vault's settings are left exactly as they are
 * @param {{name: string, version: string}} [c.tokenDomain]  passed to the paid API
 * @param {string} [c.fundsHint]  what to tell the user when the wallet is short of USDC
 * @param {(msg: string) => void} [c.log]
 */
async function main(c) {
  const log = c.log || console.log;
  const { wallet } = c;
  const me = wallet.address;
  const vault = new ethers.Contract(c.vaultAddress, VAULT_ABI, wallet);
  const usdc = new ethers.Contract(c.usdcAddress, ERC20_ABI, wallet);
  const send = async (label, txPromise) => {
    const tx = await txPromise;
    await tx.wait();
    log(`  done: ${label}`);
  };
  const MIN_BOND = c.ownerElsewhere ? await vault.minProviderBond() : usd(0.5);
  const BOND = MIN_BOND + usd(0.1); // room for the two refunds and their fees

  log(`Wallet ${me}`);
  log(`Vault  ${c.vaultAddress}`);

  // ---- 1. preflight
  const [mon, usdcBal, owner, arbiter, p0] = await Promise.all([
    wallet.provider.getBalance(me), usdc.balanceOf(me), vault.owner(), vault.arbiter(), vault.providers(me),
  ]);
  log(`Balance: ${ethers.formatEther(mon)} MON, ${fmt(usdcBal)}. Bond already posted: ${fmt(p0.bond)}`);
  if (c.ownerElsewhere) {
    if (arbiter !== me) throw new Error(`This wallet must be the vault's arbiter. The vault's arbiter is ${arbiter}.`);
    if (owner === me) log("WARNING: this wallet is also the vault's owner. On mainnet the owner key should never sit on a server.");
  } else if (owner !== me || arbiter !== me) {
    throw new Error(`This wallet must be the vault's owner and arbiter (owner ${owner}, arbiter ${arbiter}).`);
  }
  const bondNeeded = p0.bond >= BOND ? 0n : BOND - p0.bond;
  const usdcNeeded = bondNeeded + usd(0.01);
  if (usdcBal < usdcNeeded) {
    throw new Error(
      `Not enough USDC: have ${fmt(usdcBal)}, need ${fmt(usdcNeeded)}. ` +
        (c.fundsHint || `Get 1 USDC at https://faucet.circle.com (USDC -> Monad Testnet) for ${me}, then run this again.`)
    );
  }

  // ---- 2. testnet-sized settings: the faucet only gives 1 USDC, so drop the minimum bond to 0.5
  log("\nSetting up...");
  if (!c.ownerElsewhere && (await vault.minProviderBond()) !== MIN_BOND) {
    await send("minimum bond set to 0.5 USDC", vault.setParams(MIN_BOND, await vault.unbondingDelay(), await vault.slashFeeBps()));
  }

  // ---- 3. the paid API. Payments go to a separate address derived from this key.
  const payTo = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`surety-payto:${wallet.privateKey}`))).address;
  const api = c.createApi
    ? c.createApi({ payTo })
    : createX402Provider({
        network: c.network, usdc: c.usdcAddress, payTo, facilitatorUrl: c.facilitatorUrl, tokenDomain: c.tokenDomain,
        price: "$0.001", slowMs: c.slowMs ?? 6000, slowMaxMs: c.slowMaxMs ?? 2000,
      });
  const calls = c.calls || [["/quote", "pass"], ["/slow", "fail"], ["/broken", "fail"]];
  await api.listen(c.apiPort ?? 4021);
  log(`  paid API running, payments go to ${payTo}`);

  let relay;
  try {
    // ---- 4. register + bond
    if (!p0.registered) await send("provider registered", vault.register(api.slaUrl()));
    else if (p0.metadataURI !== api.slaUrl()) await send("SLA link updated", vault.setMetadata(api.slaUrl()));
    if (bondNeeded > 0n) {
      if ((await usdc.allowance(me, c.vaultAddress)) < bondNeeded) {
        await send("USDC approved for the vault", usdc.approve(c.vaultAddress, bondNeeded));
      }
      await send(`bond topped up by ${fmt(bondNeeded)}`, vault.depositBond(bondNeeded));
    }

    // ---- 5. relay + agent
    relay = createRelay({
      vaultAddress: c.vaultAddress, usdcAddress: c.usdcAddress, signer: wallet, allowInsecure: true,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "surety-testnet-")),
    });
    await new Promise((r) => relay.listen(c.relayPort ?? 8402, "127.0.0.1", r));
    const client = createSuretyClient({
      relayUrl: `http://127.0.0.1:${relay.address().port}`,
      fetch: createPayingFetch(wallet.privateKey, c.network, c.usdcAddress).fetch,
    });

    // ---- 6. three paid calls
    log(`\nMaking ${calls.length} paid call${calls.length === 1 ? "" : "s"} through the relay...`);
    const results = [];
    for (const [pathname, want] of calls) {
      const row = { path: pathname, want };
      try {
        const r = await client.call(me, pathname);
        Object.assign(row, {
          status: r.response.status, verdict: r.verdict, reason: r.reason, latencyMs: r.latencyMs,
          refund: r.claim ? fmt(r.claim.payout) : "none", claimTx: r.claim?.tx, claimError: r.claimError,
          receipt: r.response.headers.get("payment-response") ? "yes" : "NO",
        });
        const text = await r.response.text();
        if (r.response.status !== 200) row.body = text.slice(0, 300);
        else if (c.showBody) row.data = text.slice(0, 400);
        if (r.response.status === 402) row.paymentRequired = decode(r.response.headers.get("payment-required"));
      } catch (e) {
        row.error = String(e.message).slice(0, 400);
      }
      row.ok = !row.error && row.verdict === want && (want === "pass" ? row.refund === "none" : !!row.claimTx);
      results.push(row);
      log(`\n${pathname}  ->  ${row.ok ? "OK" : "PROBLEM"}`);
      for (const [k, v] of Object.entries(row)) {
        if (!["path", "ok", "want"].includes(k) && v != null) log(`    ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
      if (row.claimTx && c.explorer) log(`    see it: ${c.explorer}/tx/${row.claimTx}`);
    }

    // ---- 7. summary
    const p1 = await vault.providers(me);
    const good = results.filter((r) => r.ok).length;
    log(`\nBond now ${fmt(p1.bond)}. Claims paid on this vault: ${p1.claimCount} (${fmt(p1.claimsPaid)}).`);
    const all = good === calls.length;
    log(`RESULT: ${good}/${calls.length} calls behaved as expected.${all ? " Surety works against real x402 on this network." : " Paste this whole output to Claude."}`);
    return { results, provider: p1 };
  } finally {
    if (relay) await new Promise((r) => relay.close(r));
    await api.close();
  }
}

function decode(b64) {
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return b64 || null;
  }
}

module.exports = { main };

if (require.main === module) {
  require("dotenv").config();
  const { PRIVATE_KEY, VAULT_ADDRESS } = process.env;
  if (!PRIVATE_KEY || !VAULT_ADDRESS) {
    console.error("Set PRIVATE_KEY and VAULT_ADDRESS in .env first.");
    process.exit(1);
  }
  const rpc = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  main({
    wallet: new ethers.Wallet(key, new ethers.JsonRpcProvider(rpc)),
    vaultAddress: VAULT_ADDRESS,
    usdcAddress: process.env.USDC_ADDRESS || "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    network: "eip155:10143",
    facilitatorUrl: process.env.FACILITATOR_URL || "https://x402-facilitator.molandak.org",
    explorer: "https://testnet.monadvision.com",
  }).then(
    () => process.exit(0),
    (e) => {
      console.error(`\nSTOPPED: ${e.shortMessage || e.message}`);
      process.exit(1);
    }
  );
}
