// Proof that the agent actually paid: read the x402 settlement receipt from the
// provider's response, then confirm the USDC transfer on-chain.
const { ethers } = require("ethers");

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

/// x402 v2 sends the receipt in PAYMENT-RESPONSE, v1 in X-PAYMENT-RESPONSE.
/// The value is JSON (usually base64-encoded) with at least a transaction hash.
function parseReceipt(headers) {
  const raw = headers.get("payment-response") || headers.get("x-payment-response");
  if (!raw) return null;
  let obj = null;
  for (const text of [raw, safeBase64(raw)]) {
    if (!text) continue;
    try {
      obj = JSON.parse(text);
      break;
    } catch {
      /* try next encoding */
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const tx = obj.transaction || obj.txHash;
  if (obj.success === false || typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return null;
  return { transaction: tx, payer: ethers.isAddress(obj.payer) ? ethers.getAddress(obj.payer) : null };
}

function safeBase64(s) {
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/// Confirms the tx succeeded, is recent, and moved USDC to the provider's payTo.
/// Returns { payer, amount } or throws with the reason.
async function verifyTransfer({ provider, usdc, txHash, payTo, payer, maxAgeSec = 600, retries = 10 }) {
  // A node can lag a moment behind the facilitator, so give the receipt a few tries.
  let receipt = null;
  for (let i = 0; i < retries && !receipt; i++) {
    if (i) await new Promise((r) => setTimeout(r, 500));
    receipt = await provider.getTransactionReceipt(txHash);
  }
  if (!receipt || receipt.status !== 1) throw new Error("payment_tx_not_found");
  const block = await provider.getBlock(receipt.blockNumber);
  const latest = await provider.getBlock("latest");
  if (latest.timestamp - block.timestamp > maxAgeSec) throw new Error("payment_tx_too_old");

  let from = null;
  let amount = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdc.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const logFrom = ethers.getAddress("0x" + log.topics[1].slice(26));
    const logTo = ethers.getAddress("0x" + log.topics[2].slice(26));
    if (logTo !== ethers.getAddress(payTo)) continue;
    if (payer && logFrom !== payer) continue;
    if (from && logFrom !== from) continue; // one payer per receipt
    from = logFrom;
    amount += BigInt(log.data);
  }
  if (!from || amount === 0n) throw new Error("payment_transfer_not_found");
  return { payer: from, amount };
}

module.exports = { parseReceipt, verifyTransfer };
