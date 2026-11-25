// Types for surety-provider.
import type { Application, Request } from "express";
import type { Signer } from "ethers";

/** One paid endpoint and the promise it is bonded against. */
export interface Endpoint {
  /** HTTP method. Default "GET". */
  method?: string;
  /** Express-style path, e.g. "/v1/pool/:address". */
  path: string;
  description?: string;
  /** Price for one call, e.g. "$0.001". Defaults to the API's price. */
  price?: string;
  /** THE PROMISE: answer within this many milliseconds, measured by the relay and including payment settlement. */
  maxLatencyMs: number;
  /** THE PROMISE: JSON Schema every 2xx answer must match. */
  responseSchema?: object;
  /** A real path `check` can call when `path` has a :parameter, e.g. "/v1/pool/0xabc". */
  example?: string;
  /** Request body `check` should send with the example. */
  exampleBody?: unknown;
  /** Set false to turn off the deadline that answers 504 (uncharged) before a late answer would cost your bond. */
  guard?: boolean;
  /** Runs before payment. Return a message to reject the call with 400, free of charge. */
  validate?: (req: Request) => string | null | undefined;
  /** THE WORK. Return the JSON answer. Throwing answers with an error, and the caller is not charged. */
  handler: (req: Request) => unknown | Promise<unknown>;
}

export interface BondedApiOptions {
  /** Shown at "/". */
  name?: string;
  description?: string;
  /** Wallet that receives the payments. `serve` falls back to PAY_TO_ADDRESS. */
  payTo?: string;
  endpoints: Endpoint[];
  /** Default price per call. Default "$0.001". */
  price?: string;
  /** Public https address once hosted. `serve` falls back to PUBLIC_URL and the host's own variables. */
  publicUrl?: string;
  /** Milliseconds kept back for payment settlement. Default 2000. */
  settleReserveMs?: number;
  /** CAIP-2 network id. Default: Monad testnet, or mainnet when SURETY_NETWORK=mainnet. */
  network?: string;
  /** Payment token address on that network. */
  usdc?: string;
  facilitatorUrl?: string;
}

/** The SLA document served at /.well-known/surety.json. */
export interface SlaDocument {
  version: 1;
  baseUrl: string;
  payTo: string;
  endpoints: Array<{ method: string; path: string; maxLatencyMs: number; responseSchema?: object }>;
}

export interface BondedApi {
  /** The Express app. Export it for hosts such as Vercel. */
  app: Application;
  sla(): SlaDocument;
  slaUrl(): string;
  endpoints: Array<Endpoint & { method: string; price: string; deadlineMs: number | null }>;
  /** Runs one endpoint's handler under its deadline. */
  run(endpoint: Endpoint, req: Request): Promise<unknown>;
  settleReserveMs: number;
  /** Starts listening. Resolves to the address it is reachable at. */
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

export interface NetworkProfile {
  key: "testnet" | "mainnet";
  network: string;
  usdc: string;
  rpc: string;
  facilitatorUrl: string;
}

/** Builds the paid API and its SLA document. Does not start listening. */
export function createBondedApi(options: BondedApiOptions & { payTo: string }): BondedApi;
/** createBondedApi and listen, reading PORT, PAY_TO_ADDRESS and the public address from the environment. */
export function serve(options: BondedApiOptions, how?: { port?: number; host?: string; log?: (m: string) => void }): Promise<BondedApi & { url: string }>;
/** The public https address of this server, from PUBLIC_URL or the host's own variables. */
export function publicUrlFromEnv(env?: NodeJS.ProcessEnv): string;
/** Testnet unless SURETY_NETWORK=mainnet. */
export function networkFromEnv(env?: NodeJS.ProcessEnv): NetworkProfile;
export const MONAD_TESTNET: Omit<NetworkProfile, "key">;
export const MONAD_MAINNET: Omit<NetworkProfile, "key">;

export interface BondResult {
  provider: string;
  active: boolean;
  bond: bigint;
  slaUrl: string;
  vault: string;
  callUrls: string[];
}
/** Lists a hosted API on the vault and tops its bond up to `amount` USDC (default: the vault minimum). */
export function bond(options: { url: string; wallet: Signer; suretyUrl?: string; amount?: string; vaultAddress?: string; log?: (m: string) => void }): Promise<BondResult>;
/** `bond` using PRIVATE_KEY and SURETY_NETWORK from the environment. */
export function bondFromEnv(options: { url: string; amount?: string; env?: NodeJS.ProcessEnv; log?: (m: string) => void }): Promise<BondResult>;

export interface CheckResult {
  endpoint: string;
  ok: boolean;
  level: "ok" | "tight" | "fail";
  worstMs?: number;
  budgetMs?: number;
  note: string;
}
/** Runs every handler a few times with no payment and compares it with its own promise. */
export function check(api: BondedApi, options?: { runs?: number }): Promise<CheckResult[]>;
/** `check`, printed. Resolves to the number of endpoints that did not keep their promise. */
export function report(api: BondedApi, options?: { log?: (m: string) => void; tryCommand?: string }): Promise<number>;

export interface TryResult {
  status: number;
  body: string;
  verdict: string | null;
  reason: string | null;
  latencyMs: number;
  claim: string | null;
  claimTx: string | null;
}
/** One real paid call to `path` on `provider` through the relay. */
export function tryCall(options: { suretyUrl: string; provider: string; path: string; privateKey: string; network?: string; usdc?: string }): Promise<TryResult>;
/** `tryCall` for one endpoint address, paying from PRIVATE_KEY in the environment. */
export function tryFromEnv(options: { target: string; env?: NodeJS.ProcessEnv; log?: (m: string) => void; usage?: string }): Promise<TryResult>;
