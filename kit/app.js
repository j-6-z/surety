// YOUR API. Edit the endpoints below, then:
//   npm start                              run it on this computer
//   npm run check                          time every endpoint against its own promise
//   npm run bond -- https://your-address   post a bond so its calls are covered
//
// Each endpoint states what it promises. Surety checks every paid call against
// that promise and refunds the caller from your bond when a call misses it.
require("dotenv").config();
const { createBondedApi, publicUrlFromEnv } = require("./surety");

const api = createBondedApi({
  name: "My bonded API",
  description: "Replace this with one line about what your API sells.",
  payTo: process.env.PAY_TO_ADDRESS, // the wallet your payments land in
  publicUrl: publicUrlFromEnv(),
  price: process.env.API_PRICE || "$0.001", // per call, unless an endpoint sets its own

  endpoints: [
    {
      method: "GET",
      path: "/v1/block",
      description: "Latest Monad block number and time",
      // THE PROMISE. Answer slower than this, or in a different shape, and the caller is refunded.
      // The clock includes payment settlement (about 1.5 seconds on Monad testnet), so leave room.
      // If your handler is still running with 2 seconds of the promise left, the kit answers with an
      // error instead. The caller is not charged, so a slow day costs you nothing from your bond.
      maxLatencyMs: 4000,
      responseSchema: {
        type: "object",
        required: ["block", "timestamp"],
        properties: { block: { type: "integer", minimum: 1 }, timestamp: { type: "string" } },
      },
      // THE WORK. Return the answer. Throw to answer with an error (the caller is not charged).
      handler: async () => {
        const r = await fetch(process.env.DATA_RPC || "https://rpc.monad.xyz", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
          signal: AbortSignal.timeout(2500),
        });
        const { result } = await r.json();
        return { block: Number(result.number), timestamp: new Date(Number(result.timestamp) * 1000).toISOString() };
      },
    },
    {
      method: "GET",
      path: "/v1/shout/:word",
      description: "Example with input: returns the word in capitals",
      maxLatencyMs: 4000,
      responseSchema: { type: "object", required: ["shout"], properties: { shout: { type: "string" } } },
      // Runs before payment. Return a message to reject the call for free.
      example: "/v1/shout/hello", // a real call "npm run check" can try, since the path has a :parameter
      validate: (req) => (/^[a-z]{1,32}$/i.test(req.params.word) ? null : "word must be 1 to 32 letters"),
      handler: (req) => ({ shout: req.params.word.toUpperCase() }),
    },
  ],
});

module.exports = api.app; // hosts like Vercel pick this up
module.exports.api = api;

if (require.main === module) {
  api.listen(Number(process.env.PORT || 4021), "0.0.0.0").then((url) => {
    console.log(`Running at ${url}`);
    console.log(`Your promise: ${url}/.well-known/surety.json`);
  });
}
