const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const usd = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;
const DELAY = 7 * DAY;
const FEE_BPS = 500; // 5%

describe("SuretyVault", () => {
  async function deploy() {
    const [owner, arbiter, treasury, provider, backerA, backerB, agent, stranger] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
      await usdc.getAddress(), owner.address, arbiter.address, treasury.address, usd(100), DELAY, FEE_BPS
    );
    const v = await vault.getAddress();
    await vault.setMaxClaimPayout(usd(100_000)); // most tests use big round payouts
    await vault.setMaxDailySlashBps(10_000); // and are not about the daily limit (tested on its own below)
    for (const s of [provider, backerA, backerB, stranger]) {
      await usdc.mint(s.address, usd(10_000));
      await usdc.connect(s).approve(v, ethers.MaxUint256);
    }
    await vault.connect(provider).register("ipfs://sla-terms");
    return { vault, usdc, owner, arbiter, treasury, provider, backerA, backerB, agent, stranger };
  }

  async function funded() {
    const f = await deploy();
    await f.vault.connect(f.provider).depositBond(usd(1_000));
    await f.vault.connect(f.backerA).back(f.provider.address, usd(3_000));
    await f.vault.connect(f.backerB).back(f.provider.address, usd(1_000));
    return f;
  }

  const claimId = (s) => ethers.id(s);

  describe("providers", () => {
    it("registers once and tracks active status against min bond", async () => {
      const { vault, provider } = await loadFixture(deploy);
      await expect(vault.connect(provider).register("x")).to.be.revertedWithCustomError(vault, "AlreadyRegistered");
      expect(await vault.isActive(provider.address)).to.equal(false);
      await vault.connect(provider).depositBond(usd(100));
      expect(await vault.isActive(provider.address)).to.equal(true);
    });

    it("blocks unregistered providers from bonding", async () => {
      const { vault, stranger } = await loadFixture(deploy);
      await expect(vault.connect(stranger).depositBond(usd(1))).to.be.revertedWithCustomError(vault, "NotRegistered");
    });

    it("enforces the unbonding delay on bond withdrawals", async () => {
      const { vault, usdc, provider } = await loadFixture(funded);
      await vault.connect(provider).requestBondWithdraw(usd(400));
      await expect(vault.connect(provider).completeBondWithdraw()).to.be.revertedWithCustomError(vault, "StillUnbonding");
      await time.increase(DELAY);
      await expect(vault.connect(provider).completeBondWithdraw()).to.changeTokenBalance(usdc, provider, usd(400));
      expect((await vault.providers(provider.address)).bond).to.equal(usd(600));
    });
  });

  describe("claims", () => {
    it("pays from the provider bond first, plus the protocol fee", async () => {
      const { vault, usdc, arbiter, treasury, provider, agent } = await loadFixture(funded);
      await expect(
        vault.connect(arbiter).payClaim(claimId("c1"), provider.address, agent.address, usd(200), ethers.ZeroHash)
      ).to.changeTokenBalances(usdc, [agent, treasury], [usd(200), usd(10)]);
      const p = await vault.providers(provider.address);
      expect(p.bond).to.equal(usd(790));
      expect(p.backingAssets).to.equal(usd(4_000));
      expect(p.claimsPaid).to.equal(usd(200));
      expect(p.claimCount).to.equal(1n);
    });

    it("spills over to backers pro rata once the bond is gone", async () => {
      const { vault, arbiter, provider, backerA, backerB, agent } = await loadFixture(funded);
      // payout 1,600 + 5% fee = 1,680 -> 1,000 from bond, 680 from backers (3/4 A, 1/4 B)
      await vault.connect(arbiter).payClaim(claimId("c1"), provider.address, agent.address, usd(1_600), ethers.ZeroHash);
      const p = await vault.providers(provider.address);
      expect(p.bond).to.equal(0n);
      expect(p.backingAssets).to.equal(usd(3_320));
      const a = await vault.backerAssets(provider.address, backerA.address);
      const b = await vault.backerAssets(provider.address, backerB.address);
      expect(a).to.be.closeTo(usd(2_490), 2n);
      expect(b).to.be.closeTo(usd(830), 2n);
    });

    it("pays each claim id only once", async () => {
      const { vault, arbiter, provider, agent } = await loadFixture(funded);
      await vault.connect(arbiter).payClaim(claimId("c1"), provider.address, agent.address, usd(1), ethers.ZeroHash);
      await expect(
        vault.connect(arbiter).payClaim(claimId("c1"), provider.address, agent.address, usd(1), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(vault, "ClaimAlreadyPaid");
    });

    it("pays what is there when cover is short, shrinking the fee first", async () => {
      const { vault, usdc, arbiter, treasury, provider, agent } = await loadFixture(funded);
      // cover is 5,000. 4,900 + 5% fee = 5,145 -> agent still gets 4,900, fee drops to 100
      await expect(
        vault.connect(arbiter).payClaim(claimId("big"), provider.address, agent.address, usd(4_900), ethers.ZeroHash)
      ).to.changeTokenBalances(usdc, [agent, treasury], [usd(4_900), usd(100)]);
      expect(await vault.coverOf(provider.address)).to.equal(0n);
      await expect(
        vault.connect(arbiter).payClaim(claimId("after"), provider.address, agent.address, usd(1), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(vault, "NoCover");
    });

    it("caps a single claim at maxClaimPayout", async () => {
      const { vault, owner, arbiter, provider, agent } = await loadFixture(funded);
      await vault.connect(owner).setMaxClaimPayout(usd(100));
      await expect(
        vault.connect(arbiter).payClaim(claimId("big"), provider.address, agent.address, usd(101), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(vault, "PayoutTooLarge");
    });

    it("only lets the arbiter pay claims", async () => {
      const { vault, stranger, provider, agent } = await loadFixture(funded);
      await expect(
        vault.connect(stranger).payClaim(claimId("c1"), provider.address, agent.address, usd(1), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(vault, "NotArbiter");
    });

    it("still slashes funds that are mid-withdrawal", async () => {
      const { vault, usdc, arbiter, provider, backerA, agent } = await loadFixture(funded);
      await vault.connect(provider).requestBondWithdraw(usd(1_000));
      const shares = await vault.backerShares(provider.address, backerA.address);
      await vault.connect(backerA).requestUnstake(provider.address, shares);
      // Claim wipes the bond and takes 470 from backers (1,400 + 70 fee - 1,000 bond)
      await vault.connect(arbiter).payClaim(claimId("c1"), provider.address, agent.address, usd(1_400), ethers.ZeroHash);
      expect((await vault.providers(provider.address)).bondPendingWithdraw).to.equal(0n);
      await time.increase(DELAY);
      await expect(vault.connect(provider).completeBondWithdraw()).to.be.revertedWithCustomError(vault, "NothingPending");
      const before = await usdc.balanceOf(backerA.address);
      await vault.connect(backerA).completeUnstake(provider.address);
      const got = (await usdc.balanceOf(backerA.address)) - before;
      expect(got).to.be.closeTo(usd(3_000) - (usd(470) * 3n) / 4n, 2n); // took 3/4 of the backer loss
    });
  });

  describe("exits", () => {
    const WINDOW = 3 * DAY;

    it("queued bond stops counting toward active status at once, and cancelling restores it", async () => {
      const { vault, provider } = await loadFixture(funded);
      expect(await vault.isActive(provider.address)).to.equal(true);
      await vault.connect(provider).requestBondWithdraw(usd(950)); // leaves 50 committed, under the 100 minimum
      expect(await vault.isActive(provider.address)).to.equal(false);
      await vault.connect(provider).cancelBondWithdraw();
      expect(await vault.isActive(provider.address)).to.equal(true);
    });

    it("a matured exit can't be held open forever", async () => {
      const { vault, provider, backerA } = await loadFixture(funded);
      const shares = await vault.backerShares(provider.address, backerA.address);
      await vault.connect(provider).requestBondWithdraw(usd(100));
      await vault.connect(backerA).requestUnstake(provider.address, shares);
      await time.increase(DELAY + WINDOW + 1);
      await expect(vault.connect(provider).completeBondWithdraw()).to.be.revertedWithCustomError(vault, "ExitWindowClosed");
      await expect(vault.connect(backerA).completeUnstake(provider.address)).to.be.revertedWithCustomError(
        vault, "ExitWindowClosed"
      );
      // asking again restarts the clock
      await vault.connect(backerA).requestUnstake(provider.address, shares);
      await time.increase(DELAY);
      await expect(vault.connect(backerA).completeUnstake(provider.address)).to.not.be.reverted;
    });

    it("committed cover leaves out everything queued for exit", async () => {
      const { vault, provider, backerA, backerB } = await loadFixture(funded);
      expect(await vault.committedCoverOf(provider.address)).to.be.closeTo(usd(5_000), 2n);
      await vault.connect(provider).requestBondWithdraw(usd(400));
      const shares = await vault.backerShares(provider.address, backerA.address);
      await vault.connect(backerA).requestUnstake(provider.address, shares);
      expect(await vault.committedCoverOf(provider.address)).to.be.closeTo(usd(1_600), 2n); // 600 bond + B's 1,000
      expect(await vault.coverOf(provider.address)).to.equal(usd(5_000)); // all still slashable
      await vault.connect(backerA).requestUnstake(provider.address, shares / 3n); // replacing shrinks the queue
      expect(await vault.committedCoverOf(provider.address)).to.be.closeTo(usd(3_600), 2n);
      await vault.connect(backerA).cancelUnstake(provider.address);
      expect(await vault.committedCoverOf(provider.address)).to.be.closeTo(usd(4_600), 2n);
      await expect(vault.connect(backerB).cancelUnstake(provider.address)).to.be.revertedWithCustomError(
        vault, "NothingPending"
      );
    });
  });

  describe("backers", () => {
    it("rewards raise share value for existing backers", async () => {
      const { vault, stranger, provider, backerA, backerB } = await loadFixture(funded);
      await vault.connect(stranger).fundRewards(provider.address, usd(400));
      expect(await vault.backerAssets(provider.address, backerA.address)).to.be.closeTo(usd(3_300), 2n);
      expect(await vault.backerAssets(provider.address, backerB.address)).to.be.closeTo(usd(1_100), 2n);
    });

    it("refuses rewards when nobody is staked, so they can't be stranded", async () => {
      const { vault, provider, stranger } = await loadFixture(deploy);
      await expect(vault.connect(stranger).fundRewards(provider.address, usd(50))).to.be.revertedWithCustomError(
        vault, "NoBackers"
      );
    });

    it("enforces the unbonding delay on unstakes", async () => {
      const { vault, usdc, provider, backerB } = await loadFixture(funded);
      const shares = await vault.backerShares(provider.address, backerB.address);
      await vault.connect(backerB).requestUnstake(provider.address, shares);
      await expect(vault.connect(backerB).completeUnstake(provider.address)).to.be.revertedWithCustomError(
        vault, "StillUnbonding"
      );
      await time.increase(DELAY);
      const before = await usdc.balanceOf(backerB.address);
      await vault.connect(backerB).completeUnstake(provider.address);
      expect((await usdc.balanceOf(backerB.address)) - before).to.be.closeTo(usd(1_000), 2n);
    });

    it("can't unstake more shares than owned", async () => {
      const { vault, provider, stranger } = await loadFixture(funded);
      await expect(vault.connect(stranger).requestUnstake(provider.address, 1n)).to.be.revertedWithCustomError(
        vault, "InsufficientShares"
      );
    });
  });

  describe("admin", () => {
    it("pause blocks new deposits and claims but not exits", async () => {
      const { vault, owner, arbiter, provider, backerB, agent } = await loadFixture(funded);
      const shares = await vault.backerShares(provider.address, backerB.address);
      await vault.connect(backerB).requestUnstake(provider.address, shares);
      await vault.connect(owner).pause();
      await expect(vault.connect(provider).depositBond(usd(1))).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(
        vault.connect(arbiter).payClaim(claimId("c1"), provider.address, agent.address, usd(1), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await time.increase(DELAY);
      await expect(vault.connect(backerB).completeUnstake(provider.address)).to.not.be.reverted;
    });

    it("caps the protocol fee at 10%", async () => {
      const { vault, owner } = await loadFixture(deploy);
      await expect(vault.connect(owner).setParams(0, 0, 1_001)).to.be.revertedWithCustomError(vault, "FeeTooHigh");
    });

    it("keeps the unbonding delay between 1 and 30 days", async () => {
      const { vault, owner } = await loadFixture(deploy);
      await expect(vault.connect(owner).setParams(0, 0, 0)).to.be.revertedWithCustomError(vault, "DelayOutOfRange");
      await expect(vault.connect(owner).setParams(0, 31 * DAY, 0)).to.be.revertedWithCustomError(vault, "DelayOutOfRange");
    });

    it("only the owner can change the arbiter", async () => {
      const { vault, stranger } = await loadFixture(deploy);
      await expect(vault.connect(stranger).setArbiter(stranger.address)).to.be.revertedWithCustomError(
        vault, "OwnableUnauthorizedAccount"
      );
    });
  });

  // What a stolen arbiter key could take: bounded per claim and per provider per day.
  describe("refund limits", () => {
    const DAY = 86_400;
    async function limited() {
      const [owner, arbiter, treasury, provider, backer, agent, other] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
        await usdc.getAddress(), owner.address, arbiter.address, treasury.address, usd(1), DELAY, FEE_BPS
      );
      for (const s of [provider, backer, other]) {
        await usdc.mint(s.address, usd(1_000));
        await usdc.connect(s).approve(await vault.getAddress(), ethers.MaxUint256);
      }
      await vault.connect(provider).register("ipfs://sla");
      await vault.connect(provider).depositBond(usd(10));
      // Start each test just after midnight UTC so the day boundary is where the test puts it.
      const now = await time.latest();
      await time.increaseTo(now - (now % DAY) + DAY + 60);
      let n = 0;
      const claim = (amount, who = provider) => vault.connect(arbiter).payClaim(ethers.id(`limit-${n++}`), who.address, agent.address, usd(amount), ethers.ZeroHash);
      return { owner, arbiter, treasury, provider, backer, agent, other, usdc, vault, claim };
    }

    it("a new vault caps one claim at 5% of the minimum bond and a day at 20% of cover", async () => {
      const { vault, provider, claim } = await loadFixture(limited);
      expect(await vault.maxClaimPayout()).to.equal(usd(0.05));
      expect(await vault.maxDailySlashBps()).to.equal(2_000n);
      expect(await vault.dailyAllowance(provider.address)).to.equal(usd(2)); // 20% of the 10 USDC bond
      expect(await vault.isCovered(provider.address)).to.equal(true);
      await expect(claim(0.06)).to.be.revertedWithCustomError(vault, "PayoutTooLarge");
    });

    it("stops paying once the day's limit is reached, and says so before anyone pays", async () => {
      const { vault, usdc, agent, provider, claim } = await loadFixture(limited);
      // Each full claim takes 0.05 + 5% fee = 0.0525. The limit is 2 USDC, so the 39th claim crosses it.
      for (let i = 0; i < 38; i++) await claim(0.05);
      expect(await vault.dailyAllowance(provider.address)).to.equal(usd(2) - usd(0.0525) * 38n);
      expect(await vault.isCovered(provider.address)).to.equal(true);
      await claim(0.05); // crosses the line and is still paid in full
      expect(await vault.dailyAllowance(provider.address)).to.equal(0n);
      expect(await vault.isCovered(provider.address)).to.equal(false);
      expect(await vault.isActive(provider.address)).to.equal(true); // bonded, just not payable again today
      await expect(claim(0.001)).to.be.revertedWithCustomError(vault, "DailyLimitReached").withArgs(usd(2));
      // The worst a stolen key could do in one day: the limit plus one claim.
      expect(await usdc.balanceOf(agent.address)).to.equal(usd(0.05) * 39n);
      expect((await vault.providers(provider.address)).bond).to.equal(usd(10) - usd(0.0525) * 39n);
      expect(usd(0.0525) * 39n).to.be.at.most(usd(2) + usd(0.0525));
    });

    it("a claim refused today can be paid tomorrow, when the limit starts again from the smaller cover", async () => {
      const { vault, provider, arbiter, agent, claim } = await loadFixture(limited);
      for (let i = 0; i < 39; i++) await claim(0.05);
      const held = ethers.id("held-over");
      const pay = () => vault.connect(arbiter).payClaim(held, provider.address, agent.address, usd(0.01), ethers.ZeroHash);
      await expect(pay()).to.be.revertedWithCustomError(vault, "DailyLimitReached");
      expect(await vault.claimPaid(held)).to.equal(false);
      await time.increase(DAY);
      const cover = await vault.coverOf(provider.address);
      expect(await vault.dailyAllowance(provider.address)).to.equal((cover * 2_000n) / 10_000n);
      await pay();
      expect(await vault.claimPaid(held)).to.equal(true);
      expect(await vault.dailyAllowance(provider.address)).to.equal((cover * 2_000n) / 10_000n - usd(0.0105));
    });

    it("counts each provider on its own, and backing raises the limit from the next day", async () => {
      const { vault, provider, other, backer, claim } = await loadFixture(limited);
      await vault.connect(other).register("ipfs://other");
      await vault.connect(other).depositBond(usd(2));
      for (let i = 0; i < 39; i++) await claim(0.05);
      await claim(0.05, other); // the first provider being used up does not touch the second
      expect(await vault.isCovered(other.address)).to.equal(true);
      await vault.connect(backer).back(provider.address, usd(100));
      expect(await vault.isCovered(provider.address)).to.equal(false); // a top-up cannot reopen today
      await time.increase(DAY);
      expect(await vault.dailyAllowance(provider.address)).to.equal(((await vault.coverOf(provider.address)) * 2_000n) / 10_000n);
    });

    it("only the owner can change the limits, within range, and 10000 switches the daily limit off", async () => {
      const { vault, owner, arbiter, provider, claim } = await loadFixture(limited);
      await expect(vault.connect(arbiter).setMaxDailySlashBps(10_000)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await expect(vault.connect(arbiter).setMaxClaimPayout(usd(100))).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await expect(vault.connect(owner).setMaxDailySlashBps(0)).to.be.revertedWithCustomError(vault, "BpsOutOfRange");
      await expect(vault.connect(owner).setMaxDailySlashBps(10_001)).to.be.revertedWithCustomError(vault, "BpsOutOfRange");
      await expect(vault.connect(owner).setMaxDailySlashBps(500)).to.emit(vault, "MaxDailySlashBpsSet").withArgs(500);
      expect(await vault.dailyAllowance(provider.address)).to.equal(usd(0.5));
      for (let i = 0; i < 10; i++) await claim(0.05);
      await expect(claim(0.05)).to.be.revertedWithCustomError(vault, "DailyLimitReached");
      await vault.connect(owner).setMaxDailySlashBps(10_000);
      for (let i = 0; i < 60; i++) await claim(0.05); // far past any daily share
      expect(await vault.isCovered(provider.address)).to.equal(true);
    });

    it("the owner can pause, which stops every refund at once", async () => {
      const { vault, owner, claim } = await loadFixture(limited);
      await vault.connect(owner).pause();
      await expect(claim(0.01)).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await vault.connect(owner).unpause();
      await claim(0.01);
    });
  });
});
