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

## Keep the demo's refunds off your real record

The homepage's slow demo fails on purpose, so every run is a refund. Listed under your real API, each one counts against it on-chain, where anyone scoring providers will see it. Give the demo a provider of its own:

**1. List and bond it.** With `DEMO_KEY` and `SURETY_NETWORK=mainnet` in `.env`, and a little MON plus about 1.1 USDC in the demo wallet:

```
npm run demo:provider -- https://your-domain setup
```

The demo wallet becomes the demo provider. Refunds are paid back to that same wallet, so the bond only shrinks by the protocol fee.

**2. Switch the host over.** Add `DEMO_PROVIDER_ADDRESS` (the address the script prints) to the host's settings and redeploy. Run the script again without `setup` to confirm it says "All set".

Refunds already recorded against your real API stay there. This only stops new ones.

## Give your provider an ERC-8004 identity

Reputation services that follow ERC-8004 (Tally among them) attach scores to an agent id, not an address. To get one, with the **provider** wallet's key as `PRIVATE_KEY` in `.env`:

```
npm run agent -- https://your-domain register
```

Then add `AGENT_ID` (the id it prints) to the host's settings and redeploy. The agent must belong to the provider's own wallet: that is what proves the agent and the bonded provider are the same.

## Not done yet

- **The site's wording.** The pages, docs and FAQ still say testnet and test funds. They must be rewritten before the public site points at mainnet.
- **An audit.** Until there is one, keep the minimum bond small and say "unaudited" wherever a provider would bond.
- **One relay.** You alone decide every verdict.
- **Legal.** Whether holding other people's bonds needs registration where you operate is a question for a lawyer.
