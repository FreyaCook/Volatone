// Pure helpers for the VPLAY "play token": how many to mint, whether the feature is on, and the
// mint transaction. Play tokens have no value; this is a devnet demo of a Solana token.
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const VPLAY_PER_GOOD_CALL = 100;
export const VPLAY_SYMBOL = "VPLAY" as const;
export const VPLAY_DECIMALS = 0;

/** 100 play tokens for each good-outcome move. 0 good calls = 0 (nothing is minted). */
export const playTokensFor = (goodCalls: number): number =>
  Number.isFinite(goodCalls) && goodCalls > 0 ? Math.floor(goodCalls) * VPLAY_PER_GOOD_CALL : 0;

export const countGood = (moves: readonly { outcome?: string | null }[]): number => moves.filter((m) => m.outcome === "good").length;

/** The mint address from VPLAY_MINT, or null if it is unset or not a valid address. */
export function parseMint(raw: string | undefined): PublicKey | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    return new PublicKey(v);
  } catch {
    return null;
  }
}

/** On only if CHAIN is not off and VPLAY_MINT is a valid address. Otherwise the feature does nothing, silently. */
export function tokenEnabled(env: NodeJS.ProcessEnv): boolean {
  const chainOn = env.CHAIN?.trim().toLowerCase() !== "off";
  return chainOn && parseMint(env.VPLAY_MINT) !== null;
}

/**
 * One transaction: create the wallet's own associated token account if it is missing (idempotent),
 * then mint `amount` play tokens into it. The backend wallet is the payer, the owner and the mint authority.
 */
export function buildMintTransaction(mint: PublicKey, wallet: PublicKey, amount: number, recentBlockhash: string): Transaction {
  const ata = getAssociatedTokenAddressSync(mint, wallet);
  const tx = new Transaction({ feePayer: wallet, recentBlockhash });
  tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet, ata, wallet, mint));
  tx.add(createMintToInstruction(mint, ata, wallet, amount));
  return tx;
}
