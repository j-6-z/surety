// YOUR API. Edit the endpoints below, then:
//   npm start          run it on this computer
//   npm run check      time every endpoint against its own promise
//   npm run bond -- https://your-address    post a bond so its calls are covered
require("dotenv").config({ quiet: true });
const { createBondedApi, publicUrlFromEnv } = require("surety-provider");

const api = createBondedApi({
  name: "My bonded API",
  description: "Replace this with one line about what your API sells.",
  payTo: process.env.PAY_TO_ADDRESS, // the wallet your payments land in
  publicUrl: publicUrlFromEnv(),
  price: process.env.API_PRICE || "$0.001", // per call, unless an endpoint sets its own

  endpoints: [
    {
      method: "GET",
      path: "/v1/shout/:word",
      description: "Returns the word in capitals",
      // THE PROMISE. Answer slower than this, or in a different shape, and the caller is refunded
      // from your bond. The clock includes payment settlement, so leave room.
      maxLatencyMs: 4000,
      responseSchema: { type: "object", required: ["shout"], properties: { shout: { type: "string" } } },
      example: "/v1/shout/hello", // a real call "npm run check" can try
      // Runs before payment. Return a message to reject the call for free.
      validate: (req) => (/^[a-z]{1,32}$/i.test(req.params.word) ? null : "word must be 1 to 32 letters"),
      // THE WORK. Return the answer. Throw to answer with an error (the caller is not charged).
      handler: (req) => ({ shout: req.params.word.toUpperCase() }),
    },
  ],
});

module.exports = api.app; // hosts like Vercel pick this up
module.exports.api = api; // "surety-provider check" reads this

if (require.main === module) {
  api.listen(Number(process.env.PORT || 4021), "0.0.0.0").then((url) => {
    console.log(`Running at ${url}`);
    console.log(`Your promise: ${url}/.well-known/surety.json`);
  });
}
