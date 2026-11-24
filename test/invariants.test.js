// Randomised stress test: hundreds of random actions from providers, backers and
// the arbiter, checking after each one that the vault's books match its balance.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const usd = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400;

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("SuretyVault invariants (randomised)", function () {
  this.timeout(120_000);

  for (const seed of [1, 7, 42, 2026]) {
    it(`books always match the balance, and everyone can exit (seed ${seed})`, async () => {
      const rand = rng(seed);
      const pick = (arr) => arr[Math.floor(rand() * arr.length)];
      const amount = (max) => BigInt(1 + Math.floor(rand() * max * 1e6)); // down to 1 micro-USDC

      const signers = await ethers.getSigners();
      const [owner, arbiter, treasury, agent] = signers;
      const provs = signers.slice(4, 7);
      const backers = signers.slice(7, 11);
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
        await usdc.getAddress(), owner.address, arbiter.address, treasury.address, usd(100), 7 * DAY, 500
      );
      const v = await vault.getAddress();
      await vault.setMaxClaimPayout(usd(1_000_000));
      if (seed % 2 === 0) await vault.setMaxDailySlashBps(10_000); // half the seeds run with the daily limit on
      for (const s of [...provs, ...backers]) {
        await usdc.mint(s.address, usd(1_000_000));
        await usdc.connect(s).approve(v, ethers.MaxUint256);
      }
      for (const p of provs) await vault.connect(p).register("x");

      let claimNo = 0;
      const actions = [
        () => vault.connect(pick(provs)).depositBond(amount(500)),
        () => vault.connect(pick(provs)).requestBondWithdraw(amount(500)),
        () => vault.connect(pick(provs)).cancelBondWithdraw(),
        () => vault.connect(pick(provs)).completeBondWithdraw(),
        () => vault.connect(pick(backers)).back(pick(provs).address, amount(800)),
        async () => {
          const b = pick(backers), p = pick(provs).address;
          const sh = await vault.backerShares(p, b.address);
          return vault.connect(b).requestUnstake(p, (sh * BigInt(1 + Math.floor(rand() * 100))) / 100n);
        },
        () => vault.connect(pick(backers)).cancelUnstake(pick(provs).address),
        () => vault.connect(pick(backers)).completeUnstake(pick(provs).address),
        () => vault.connect(pick(backers)).fundRewards(pick(provs).address, amount(50)),
        () => vault.connect(arbiter).payClaim(ethers.id(`c${claimNo++}`), pick(provs).address, agent.address, amount(900), ethers.ZeroHash),
        () => vault.connect(arbiter).payClaim(ethers.id(`c${claimNo++}`), pick(provs).address, agent.address, amount(3), ethers.ZeroHash),
        () => time.increase(Math.floor(rand() * 5 * DAY)),
      ];

      const check = async () => {
        let owed = 0n;
        for (const p of provs) {
          const d = await vault.providers(p.address);
          owed += d.bond + d.backingAssets;
          expect(d.bondPendingWithdraw <= d.bond, "queued bond <= bond").to.equal(true);
          expect(d.backingSharesPending <= d.backingShares, "queued shares <= shares").to.equal(true);
          let sum = 0n;
          for (const b of backers) sum += await vault.backerShares(p.address, b.address);
          expect(sum, "backer shares add up").to.equal(d.backingShares);
        }
        expect(await usdc.balanceOf(v), "vault balance == bonds + backing").to.equal(owed);
      };

      let ok = 0;
      for (let i = 0; i < 300; i++) {
        try {
          await pick(actions)();
          ok++;
        } catch (e) {
          // Clean, named reverts are expected (nothing pending, still unbonding...).
          // An arithmetic panic or an unnamed revert would be a real bug.
          if (!/custom error|reverted with custom/.test(e.message)) throw e;
        }
        if (i % 10 === 9) await check();
      }
      await check();
      expect(ok).to.be.greaterThan(100);

      // Everyone leaves. Nothing may get stuck.
      for (const p of provs) {
        for (const b of backers) {
          const sh = await vault.backerShares(p.address, b.address);
          if (sh > 0n) await vault.connect(b).requestUnstake(p.address, sh);
        }
        const d = await vault.providers(p.address);
        if (d.bond > 0n) await vault.connect(p).requestBondWithdraw(d.bond);
      }
      await time.increase(7 * DAY);
      for (const p of provs) {
        for (const b of backers) {
          if ((await vault.backerShares(p.address, b.address)) > 0n) await vault.connect(b).completeUnstake(p.address);
        }
        if ((await vault.providers(p.address)).bond > 0n) await vault.connect(p).completeBondWithdraw();
        const d = await vault.providers(p.address);
        expect(d.bond).to.equal(0n);
        expect(d.backingShares).to.equal(0n);
        expect(d.backingAssets < usd(0.01), `only rounding dust left, got ${d.backingAssets}`).to.equal(true);
      }
      expect((await usdc.balanceOf(v)) < usd(0.03)).to.equal(true);
    });
  }
});
