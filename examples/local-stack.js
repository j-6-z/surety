// Spins up everything on Hardhat's local chain: vault, test USDC, a bonded mock
// provider, a backer, the relay, and an agent SDK client. Used by the e2e tests
// and by scripts/demo.js.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { createRelay } = require("../verifier/relay");
const { createSuretyClient } = require("../sdk");
const { createMockProvider, mockPayingFetch } = require("./mock-provider");

const usd = (n) => ethers.parseUnits(String(n), 6);

async function startLocalStack({ price = usd(2), bond = usd(200), backing = usd(50), relayOpts = {} } = {}) {
  const [owner, arbiter, treasury, providerOp, backer, agent] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
    await usdc.getAddress(), owner.address, arbiter.address, treasury.address, usd(100), 7 * 86400, 500
  );
  const vaultAddress = await vault.getAddress();
  for (const s of [providerOp, backer, agent]) {
    await usdc.mint(s.address, usd(1_000));
    await usdc.connect(s).approve(vaultAddress, ethers.MaxUint256);
  }

  const { chainId } = await ethers.provider.getNetwork();
  const mock = createMockProvider({ usdc, agentSigner: agent, payTo: providerOp.address, price, chainId });
  await mock.listen();
  await vault.connect(providerOp).register(mock.slaUrl());
  if (bond > 0n) await vault.connect(providerOp).depositBond(bond);
  if (backing > 0n) await vault.connect(backer).back(providerOp.address, backing);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "surety-"));
  const relay = createRelay({
    vaultAddress,
    usdcAddress: await usdc.getAddress(),
    signer: arbiter,
    dataDir,
    allowInsecure: true,
    slaTtlMs: 0,
    statusTtlMs: 0,
    ...relayOpts,
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const relayUrl = `http://127.0.0.1:${relay.address().port}`;
  const client = createSuretyClient({ relayUrl, fetch: mockPayingFetch() });

  const close = () =>
    Promise.all([new Promise((r) => relay.close(r)), new Promise((r) => mock.server.close(r))]);
  return { usd, usdc, vault, relayUrl, providerUrl: mock.slaUrl().replace("/.well-known/surety.json", ""), dataDir, client, price, close,
    owner, arbiter, treasury, providerOp, backer, agent, provider: providerOp.address };
}

module.exports = { startLocalStack, usd };
