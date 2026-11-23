// Live check of the Market Data API:  node scripts/api-check.js
//
// Runs the API on this machine with REAL Monad mainnet prices, bonds it on your
// testnet vault, and buys two calls through the relay with testnet USDC.
// Reading mainnet prices is free: no mainnet wallet or funds are involved.
const { ethers } = require("ethers");
const { main } = require("./testnet-check");
const { createMarketApi } = require("../api/server");
const { createPriceReader, MONAD_MAINNET } = require("../api/prices");

if (require.main === module) {
  require("dotenv").config();
  const env = process.env;
  if (!env.PRIVATE_KEY || !env.VAULT_ADDRESS) {
    console.error("Set PRIVATE_KEY and VAULT_ADDRESS in .env first.");
    process.exit(1);
  }
  const key = env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`;
  const network = "eip155:10143";
  const usdcAddress = env.USDC_ADDRESS || "0x534b2f3A21130d7a60830c2Df862319e593943A3";
  const facilitatorUrl = env.FACILITATOR_URL || "https://x402-facilitator.molandak.org";
  const dataProvider = new ethers.JsonRpcProvider(env.DATA_RPC || MONAD_MAINNET.rpc);
  const reader = createPriceReader({
    provider: dataProvider, factories: MONAD_MAINNET.factories, wmon: MONAD_MAINNET.wmon, usdc: MONAD_MAINNET.usdc,
    minUsdcDepth: Number(env.MIN_POOL_USDC || 1000),
  });

  (async () => {
    // Look at the data first, for free, so a thin pool is obvious before anything is paid for.
    console.log("Reading MON price from Monad mainnet pools...");
    let poolPath = null;
    try {
      const p = await reader.monPrice();
      console.log(`  MON = $${p.priceUsd} (${p.dex} pool ${p.pool}, ${Math.round(p.poolUsdc)} USDC in pool, block ${p.block})`);
      poolPath = `/v1/pool/${p.pool}`;
    } catch (e) {
      throw new Error(
        `Could not get a usable MON price from mainnet: ${e.message} ${e.detail ? JSON.stringify(e.detail) : ""}. ` +
          "Nothing was bonded or paid for. Paste this to Claude."
      );
    }
    await main({
      wallet: new ethers.Wallet(key, new ethers.JsonRpcProvider(env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz")),
      vaultAddress: env.VAULT_ADDRESS,
      usdcAddress,
      network,
      facilitatorUrl,
      explorer: "https://testnet.monadvision.com",
      showBody: true,
      createApi: ({ payTo }) => createMarketApi({ reader, network, usdc: usdcAddress, payTo, facilitatorUrl }),
      calls: [["/v1/price/mon", "pass"], [poolPath, "pass"]],
    });
  })().then(
    () => process.exit(0),
    (e) => {
      console.error(`\nSTOPPED: ${e.shortMessage || e.message}`);
      process.exit(1);
    }
  );
}
