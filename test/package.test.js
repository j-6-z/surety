// The npm package: what it ships, that it works when installed the way a stranger
// would install it, and that the copy-and-go kit has not drifted from it.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { ethers } = require("hardhat");
const { validateSlaDoc } = require("../verifier/sla");
const { syncKit } = require("../scripts/sync-kit");

const ROOT = path.join(__dirname, "..");
const PKG = path.join(ROOT, "packages", "provider");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

describe("surety-provider (the npm package)", function () {
  this.timeout(120_000);
  let installed; // a folder laid out like a stranger's project after `npm install surety-provider`
  let files;

  before(() => {
    // Run from inside the package so no path with a space in it has to survive a Windows shell.
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "surety-pack-"));
    const out = execFileSync(npm, ["pack", "--json", "--pack-destination", dest], { cwd: PKG, encoding: "utf8", shell: process.platform === "win32" });
    const info = JSON.parse(out)[0];
    files = info.files.map((f) => f.path).sort();
    installed = fs.mkdtempSync(path.join(os.tmpdir(), "surety-pkg-"));
    const into = path.join(installed, "node_modules", "surety-provider");
    fs.mkdirSync(into, { recursive: true });
    execFileSync("tar", ["-xzf", path.join(dest, info.filename), "-C", into, "--strip-components=1"]);
  });

  /// Runs a script inside the stranger's project. Its dependencies resolve from this repo's node_modules.
  const run = (file, args = [], env = {}) =>
    spawnSync(process.execPath, [file, ...args], { cwd: installed, encoding: "utf8", env: { ...process.env, NODE_PATH: path.join(ROOT, "node_modules"), ...env } });

  it("ships the library, the command line, the template and the types, and nothing else", () => {
    expect(files).to.deep.equal([
      "LICENSE", "README.md", "cli.js", "index.d.ts", "index.js",
      "lib/bond.js", "lib/check.js", "lib/surety.js", "lib/try.js", "package.json",
      "template/app.js", "template/env.example", "template/gitignore", "template/package.json", "template/vercel.json", "template/vercelignore",
    ].sort());
    expect(files.some((f) => /\.env$|\.key$|test/i.test(f))).to.equal(false);
  });

  it("declares every module it requires, and nothing reaches outside the package", () => {
    const deps = Object.keys(require(path.join(PKG, "package.json")).dependencies);
    for (const f of ["index.js", "cli.js", "lib/surety.js", "lib/bond.js", "lib/check.js", "lib/try.js"]) {
      const src = fs.readFileSync(path.join(PKG, f), "utf8");
      expect(src, f).to.not.match(/require\(["']\.\.\/\.\./);
      for (const m of src.matchAll(/require\(["']([^."'][^"']*)["']\)/g)) {
        if (["fs", "path", "child_process", "surety-provider"].includes(m[1])) continue; // built-ins, and its own name in a usage comment
        const name = m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0];
        expect(deps, `${f} needs ${name}`).to.include(name);
      }
    }
  });

  it("the copy-and-go kit is identical to the package's library", () => {
    expect(syncKit(), "run: npm run sync:kit").to.deep.equal([]);
  });

  it("the five-line example from the README is a working paid API", async () => {
    const app = path.join(installed, "five.js");
    fs.writeFileSync(app, `
const { serve } = require("surety-provider");
serve({
  payTo: "${"0x" + "c3".repeat(20)}",
  facilitatorUrl: "http://127.0.0.1:9",
  endpoints: [{ path: "/v1/hello", maxLatencyMs: 4000, handler: () => ({ hello: "world" }) }],
}, { port: 0, host: "127.0.0.1", log: (m) => console.log(m) });
`);
    const child = require("child_process").spawn(process.execPath, [app], { cwd: installed, env: { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") } });
    try {
      const url = await new Promise((resolve, reject) => {
        let buf = "";
        child.stdout.on("data", (d) => { buf += d; const m = buf.match(/Running at (http:\/\/\S+)/); if (m) resolve(m[1]); });
        child.stderr.on("data", (d) => { if (/Error|Cannot find/.test(String(d)) && !/facilitator/.test(String(d))) reject(new Error(String(d))); });
        setTimeout(() => reject(new Error(`did not start: ${buf}`)), 20_000);
      });
      const sla = validateSlaDoc(await (await fetch(`${url}/.well-known/surety.json`)).json());
      expect(sla.endpoints).to.have.length(1);
      expect(sla.endpoints[0]).to.include({ method: "GET", path: "/v1/hello", maxLatencyMs: 4000 });
      expect((await (await fetch(`${url}/`)).json()).endpoints[0].price).to.equal("$0.001");
      expect((await fetch(`${url}/health`)).status).to.equal(200);
      // The paid route does not hand out the answer for free.
      expect((await fetch(`${url}/v1/hello`)).status).to.not.equal(200);
    } finally {
      child.kill();
    }
  });

  it("init creates a project that passes its own check", () => {
    const cli = path.join(installed, "node_modules", "surety-provider", "cli.js");
    const made = run(cli, ["init", "my api"]);
    expect(made.status, made.stderr).to.equal(0);
    const dir = path.join(installed, "my api");
    expect(fs.readdirSync(dir).sort()).to.deep.equal([".env.example", ".gitignore", ".vercelignore", "app.js", "package.json", "vercel.json"]);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(pkg.name).to.equal("my-api");
    expect(pkg.dependencies["surety-provider"]).to.equal("^0.1.0");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).to.contain(".env");

    // A second init must not overwrite someone's work.
    const again = run(cli, ["init", "my api"]);
    expect(again.status).to.equal(1);
    expect(again.stderr).to.contain("already has files");

    // The new project resolves the package the way it will after `npm install`.
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.symlinkSync(path.join(installed, "node_modules", "surety-provider"), path.join(dir, "node_modules", "surety-provider"), "junction");
    const checked = spawnSync(process.execPath, [cli, "check", "app.js"], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_PATH: path.join(ROOT, "node_modules"), PAY_TO_ADDRESS: "0x" + "c3".repeat(20) } });
    expect(checked.status, checked.stdout + checked.stderr).to.equal(0);
    expect(checked.stdout).to.contain("OK     GET /v1/shout/:word").and.to.contain("Every endpoint keeps its promise");
  });

  it("the command line explains itself and fails clearly", () => {
    const cli = path.join(installed, "node_modules", "surety-provider", "cli.js");
    expect(run(cli, ["--help"]).stdout).to.contain("surety-provider <command>").and.to.contain("bond <url> [usdc]");
    expect(run(cli, ["--version"]).stdout.trim()).to.equal("0.1.0");
    const unknown = run(cli, ["launch"]);
    expect(unknown.status).to.equal(1);
    expect(unknown.stderr).to.contain('Unknown command "launch"');
    expect(run(cli, ["check", "nope.js"]).stderr).to.contain("No file at");
    expect(run(cli, ["bond"]).stderr).to.contain("Give the public address");
    expect(run(cli, ["bond", "https://x.example"], { PRIVATE_KEY: "" }).stderr).to.contain("PRIVATE_KEY");
    expect(run(cli, ["try", "not a url"], { PRIVATE_KEY: "" }).stderr).to.contain("full address of one endpoint");
    fs.writeFileSync(path.join(installed, "bare.js"), "module.exports = {};");
    expect(run(cli, ["check", "bare.js"]).stderr).to.contain('as "api"');
  });

  it("the type definitions compile against a real consumer", function () {
    const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
    if (!fs.existsSync(tsc)) this.skip();
    fs.writeFileSync(path.join(installed, "consumer.ts"), `
import { serve, createBondedApi, check, bond, tryCall, networkFromEnv, type Endpoint, type CheckResult } from "surety-provider";
const hello: Endpoint = { path: "/v1/hello", maxLatencyMs: 4000, handler: async (req) => ({ hello: req.params.name }) };
async function main() {
  const api = createBondedApi({ payTo: "0x00", endpoints: [hello], price: "$0.01", settleReserveMs: 1500 });
  const url: string = await api.listen(0);
  const results: CheckResult[] = await check(api, { runs: 2 });
  const level: "ok" | "tight" | "fail" = results[0].level;
  const served = await serve({ endpoints: [hello] }, { port: 0 });
  const where: string = served.url + api.slaUrl() + networkFromEnv().usdc + url + level;
  const r = await tryCall({ suretyUrl: where, provider: "0x", path: "/", privateKey: "0x" });
  const ms: number = r.latencyMs;
  void bond; void ms;
}
void main;
// @ts-expect-error  an endpoint without a promise is not an endpoint
const bad: Endpoint = { path: "/x", handler: () => 1 };
void bad;
`);
    const r = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--skipLibCheck", "--types", "node", "--typeRoots", path.join(ROOT, "node_modules", "@types"), "consumer.ts"],
      { cwd: installed, encoding: "utf8", env: { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") } });
    expect(r.status, r.stdout + r.stderr).to.equal(0);
  });
});
