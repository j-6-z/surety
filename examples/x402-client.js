// A fetch that pays x402 invoices automatically from a private key
// (the official @x402/fetch client). Paying needs USDC but no gas.
const { privateKeyToAccount } = require("viem/accounts");
const { wrapFetchWithPayment, x402Client } = require("@x402/fetch");
const { ExactEvmScheme } = require("@x402/evm/exact/client");

/**
 * @param {string} privateKey
 * @param {string} network      CAIP-2 id, e.g. "eip155:10143"
 * @param {string} usdc         token the agent is allowed to pay in
 * @param {string} [maxAtomic]  most it may spend on one call, in token units (default 1 USDC)
 */
function createPayingFetch(privateKey, network, usdc, maxAtomic = "1000000") {
  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  // The client only pays in tokens it has been told to trust, capped per call.
  const client = new x402Client()
    .register(network, new ExactEvmScheme(account))
    .setSpendControls({ allowedAssets: [{ network, asset: usdc, maxAmountPerPayment: maxAtomic }] });
  return { fetch: wrapFetchWithPayment(fetch, client), address: account.address };
}

module.exports = { createPayingFetch };
