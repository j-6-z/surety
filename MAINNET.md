# Taking Surety to Monad mainnet

Mainnet means real USDC. The vault contract has **not been audited**. This guide is for a small, capped beta where the first money at risk is your own.

## The four wallets

| Wallet | What it does | Where its key lives |
| --- | --- | --- |
| **Owner** | Pauses the vault, replaces the arbiter, changes the minimum bond and fee | Hardware wallet or multisig. Never in a file, never on a server |
| **Arbiter** | Signs refunds for the relay | On the server (`ARBITER_KEY`). Holds a little MON, nothing else |
| **Provider** | Lists and bonds your own API | Your own computer, only when you run `set-host.js` |
| **Deployer** | Deploys the contract once | A throwaway. Empty it afterwards |

If the server is ever broken into, the attacker gets the arbiter key. With it they can pay out bonds as fake refunds, but slowly: one refund is capped at 5% of the minimum bond, and all refunds against one provider stop for the day at 20% of its cover. That gives the owner time to pause the vault and replace the arbiter, which is why the owner key must be somewhere else.

Because of those caps, a call priced above 5% of the minimum bond cannot be refunded. Only the owner can raise either cap (`setMaxClaimPayout`, `setMaxDailySlashBps`).

## Steps

**1. Check the network before anything is deployed.** Put the arbiter wallet's key in `.env` as `PRIVATE_KEY`, then:

```
npm run check:mainnet
```

It spends nothing. It confirms the RPC, the USDC token, and that the payment facilitator settles on mainnet.

**2. Deploy.** Put a throwaway deployer key in `.env` as `PRIVATE_KEY` (it needs a little MON), set `OWNER_ADDRESS`, `ARBITER_ADDRESS`, `MIN_BOND_USDC=1` and `I_UNDERSTAND_UNAUDITED=yes`, then:

```
npm run deploy:mainnet
```

The script refuses to run if the owner and arbiter are the same wallet, or if the owner is the wallet you are deploying from.

**3. Check the vault.** Put the new address in `.env` as `VAULT_ADDRESS`, switch `PRIVATE_KEY` back to the arbiter key, and run `npm run check:mainnet` again. It now also checks who owns the vault and what one refund can cost.

**4. Prove the loop with real money.** Send the arbiter wallet the minimum bond plus 0.15 USDC, then:

```
npm run check:mainnet -- --live
```

Three real paid calls of $0.001: one good, one slow, one broken. The two bad ones should be refunded on-chain. The bond it posts is yours to withdraw after the waiting period.

**5. Only then, the server.** In the host's settings: `SURETY_NETWORK=mainnet`, `VAULT_ADDRESS`, `ARBITER_KEY`, `PROVIDER_ADDRESS`, `PAY_TO_ADDRESS`, `PUBLIC_URL`. Add `DEMO_KEY` if you want the homepage demo, funded with a dollar or two.

## Not done yet

- **The site's wording.** The pages, docs and FAQ still say testnet and test funds. They must be rewritten before the public site points at mainnet.
- **An audit.** Until there is one, keep the minimum bond small and say "unaudited" wherever a provider would bond.
- **One relay.** You alone decide every verdict.
- **Legal.** Whether holding other people's bonds needs registration where you operate is a question for a lawyer.
