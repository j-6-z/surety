// Local stand-in for an x402 facilitator, for tests only. It trusts every
// payment and "settles" by moving test USDC on the local chain.
const http = require("http");

function startFakeFacilitator({ usdc, network, wallets }) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const reply = (obj) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(obj));
    if (req.url === "/supported") {
      return reply({ kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: {} });
    }
    const auth = body.paymentPayload.payload.authorization;
    if (req.url === "/verify") return reply({ isValid: true, payer: auth.from });
    if (req.url === "/settle") {
      const tx = await usdc.connect(wallets[auth.from.toLowerCase()]).transfer(auth.to, auth.value);
      await tx.wait();
      return reply({ success: true, transaction: tx.hash, network, payer: auth.from });
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

module.exports = { startFakeFacilitator };
