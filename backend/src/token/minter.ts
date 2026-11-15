// Mints play tokens for a completed run. Optional and failure-safe, like the Tiger and MongoDB modules:
// it runs in the background after the log batches, never blocks the replay, has a bounded timeout and a
// circuit breaker, mints at most once per run id, and logs each distinct error once with no secrets.
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import type { PlayTokens } from "@volatone/shared/protocol";
import { configFromEnv, loadKeypair, waitForConfirmed } from "../chain/sender";
import { CircuitBreaker, logOnce, safeError } from "../tiger/queue";
import { buildMintTransaction, parseMint, playTokensFor, tokenEnabled, VPLAY_SYMBOL } from "./mint";

export const MINT_TIMEOUT_MS = 15_000;

export interface MinterDeps {
  mint: string;
  /** Sends one mint transaction for `amount` play tokens and resolves once it is confirmed. */
  send: (amount: number) => Promise<{ signature: string; confirmMs: number }>;
  log: (m: string) => void;
  timeoutMs?: number;
  /** strings that must never appear in a log line (the RPC URL) */
  secrets?: string[];
}

export class PlayTokenMinter {
  readonly breaker = new CircuitBreaker(3, 30_000);
  private readonly attempted = new Set<string>(); // run ids already handled: a repeat never mints twice
  private readonly results = new Map<string, PlayTokens>();
  private readonly note: (m: string) => void;

  constructor(private readonly deps: MinterDeps) {
    this.note = logOnce(deps.log);
  }

  /** What was minted for this run, if anything. */
  result(runId: string | null): PlayTokens | undefined {
    return runId ? this.results.get(runId) : undefined;
  }

  /** Mints 100 per good call, once per run. Resolves with the result or null. Never throws. */
  async mintForRun(runId: string, goodCalls: number): Promise<PlayTokens | null> {
    if (!runId || this.attempted.has(runId)) return this.results.get(runId) ?? null;
    this.attempted.add(runId); // before any await, so two quick calls cannot both mint
    const amount = playTokensFor(goodCalls);
    if (amount === 0) return null; // nothing to mint: skip silently
    if (!this.breaker.canTry(Date.now())) return null;
    try {
      const sent = await withTimeout(this.deps.send(amount), this.deps.timeoutMs ?? MINT_TIMEOUT_MS);
      this.breaker.success();
      const tokens: PlayTokens = { minted: amount, symbol: VPLAY_SYMBOL, mint: this.deps.mint, signature: sent.signature, confirmMs: sent.confirmMs };
      this.results.set(runId, tokens);
      return tokens;
    } catch (e) {
      this.breaker.failure(Date.now());
      this.note(`token: mint failed (${safeError(e, this.deps.secrets)}); the replay is unaffected`);
      return null;
    }
  }
}

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("mint timed out")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

/** The real minter, or null (silently) if CHAIN is off or VPLAY_MINT is unset or invalid. */
export function createMinter(env: NodeJS.ProcessEnv, log: (m: string) => void): PlayTokenMinter | null {
  if (!tokenEnabled(env)) return null;
  const mint = parseMint(env.VPLAY_MINT) as PublicKey;
  const config = configFromEnv(env);
  const connection = new Connection(config.rpcUrl, "confirmed");
  let payer: Keypair | undefined; // loaded on first use, kept in memory only

  const send = async (amount: number) => {
    payer ??= loadKeypair(config.walletPath);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = buildMintTransaction(mint, payer.publicKey, amount, blockhash);
    tx.sign(payer);
    const started = performance.now();
    const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    await waitForConfirmed(connection, signature, lastValidBlockHeight);
    return { signature, confirmMs: Math.round(performance.now() - started) };
  };
  return new PlayTokenMinter({ mint: mint.toBase58(), send, log, secrets: [config.rpcUrl] });
}
