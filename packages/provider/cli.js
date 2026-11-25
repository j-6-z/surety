#!/usr/bin/env node
// Command line for surety-provider.
//
//   surety-provider init [folder]          start a new bonded API from the template
//   surety-provider check [file]           time every endpoint against its promise (no payment)
//   surety-provider bond <url> [usdc]      list your hosted API and post its bond
//   surety-provider try <endpoint-url>     one real paid call through the relay
const fs = require("fs");
const path = require("path");

const USAGE = `surety-provider <command>

  init [folder]        Start a new bonded API in a folder (default: my-bonded-api)
  check [file]         Time every endpoint in your app against its own promise. No payment.
                       The file (default: ./app.js) must export the result of createBondedApi as "api".
  bond <url> [usdc]    List your hosted API on the vault and post its bond (default: the minimum).
                       Needs PRIVATE_KEY in .env or the environment.
  try <endpoint-url>   Make one real paid call through the Surety relay and print the verdict.

Runs on Monad testnet unless SURETY_NETWORK=mainnet. Docs: https://www.surety.buzz/kit/`;

/// Copies the starter files into a new folder. Refuses to write into a folder that has files in it.
function init(dir, { log = console.log } = {}) {
  const target = path.resolve(dir || "my-bonded-api");
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${target} already has files in it. Pick an empty or new folder.`);
  fs.mkdirSync(target, { recursive: true });
  const from = path.join(__dirname, "template");
  // npm will not ship files named .gitignore or .env.example reliably, so the template stores them undotted.
  const names = { gitignore: ".gitignore", "env.example": ".env.example", vercelignore: ".vercelignore" };
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(target, names[f] || f));
  const pkgPath = path.join(target, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.name = path.basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "my-bonded-api";
  pkg.dependencies["surety-provider"] = `^${require("./package.json").version}`;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  log(`Created ${target}\n\nNext:\n  cd ${path.relative(process.cwd(), target) || "."}\n  npm install\n  copy .env.example to .env and set PAY_TO_ADDRESS\n  npm start`);
  return target;
}

/// Loads the user's app file and returns the object createBondedApi gave them.
function loadApi(file) {
  const full = path.resolve(file || "app.js");
  if (!fs.existsSync(full)) throw new Error(`No file at ${full}. Give the file that creates your API:  surety-provider check ./app.js`);
  const mod = require(full);
  const api = mod && (mod.api || (mod.endpoints && mod.run ? mod : null));
  if (!api) throw new Error(`${path.basename(full)} must export what createBondedApi returned, as "api":\n  module.exports.api = api;`);
  return api;
}

async function main(argv, { log = console.log } = {}) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    log(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    log(require("./package.json").version);
    return 0;
  }
  if (command === "init") {
    init(rest[0], { log });
    return 0;
  }
  try {
    require("dotenv").config({ quiet: true });
  } catch {
    /* no .env support installed: the environment is used as it is */
  }
  if (command === "check") {
    const failed = await require("./lib/check").report(loadApi(rest[0]), { log, tryCommand: "npx surety-provider try <endpoint-url>" });
    return failed ? 1 : 0;
  }
  if (command === "bond") {
    if (!rest[0]) throw new Error("Give the public address of your API:  surety-provider bond https://your-api.example");
    const { bondFromEnv, explain } = require("./lib/bond");
    await bondFromEnv({ url: rest[0], amount: rest[1], log }).catch((e) => { throw new Error(explain(e)); });
    return 0;
  }
  if (command === "try") {
    await require("./lib/try").tryFromEnv({ target: rest[0], log, usage: "surety-provider try https://your-api.example/v1/block" });
    return 0;
  }
  throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
}

module.exports = { main, init, loadApi, USAGE };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`STOPPED: ${e.shortMessage || e.message}`);
      process.exit(1);
    }
  );
}
