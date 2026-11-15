// Pure parts of the play-token feature. No network, no real wallet.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildMintTransaction, countGood, parseMint, playTokensFor, tokenEnabled } from "../src/token/mint";
import { createMinter, PlayTokenMinter } from "../src/token/minter";

const mint = Keypair.generate().publicKey;

describe("how many play tokens", () => {
  it("is 100 per good call, and 0 for none (or nonsense)", () => {
    assert.equal(playTokensFor(3), 300);
    assert.equal(playTokensFor(1), 100);
    assert.equal(playTokensFor(0), 0);
    assert.equal(playTokensFor(-2), 0);
    assert.equal(playTokensFor(NaN), 0);
  });
  it("counts only good outcomes (poor and pending do not count)", () => {
    assert.equal(countGood([{ outcome: "good" }, { outcome: "poor" }, { outcome: null }, { outcome: "good" }, {}]), 2);
  });
});

describe("VPLAY_MINT and the on/off switch", () => {
  it("parses a valid address and rejects unset, blank and invalid ones", () => {
    assert.equal(parseMint(mint.toBase58())?.toBase58(), mint.toBase58());
    assert.equal(parseMint(undefined), null);
    assert.equal(parseMint("   "), null);
    assert.equal(parseMint("not-an-address"), null);
    assert.equal(parseMint("0000"), null);
  });
  it("is on only with CHAIN not off and a valid mint", () => {
    const m = mint.toBase58();
    assert.equal(tokenEnabled({ VPLAY_MINT: m }), true);
    assert.equal(tokenEnabled({ VPLAY_MINT: m, CHAIN: "off" }), false);
    assert.equal(tokenEnabled({ VPLAY_MINT: m, CHAIN: "OFF" }), false);
    assert.equal(tokenEnabled({}), false);
    assert.equal(tokenEnabled({ VPLAY_MINT: "junk" }), false);
  });
  it("createMinter is null, silently, when off or invalid", () => {
    const logs: string[] = [];
    assert.equal(createMinter({}, (m) => logs.push(m)), null);
    assert.equal(createMinter({ VPLAY_MINT: "junk" }, (m) => logs.push(m)), null);
    assert.equal(createMinter({ VPLAY_MINT: mint.toBase58(), CHAIN: "off" }, (m) => logs.push(m)), null);
    assert.deepEqual(logs, []);
  });
});

describe("the mint transaction", () => {
  const wallet = Keypair.generate().publicKey;
  const tx = buildMintTransaction(mint, wallet, 300, "11111111111111111111111111111111");

  it("creates the wallet's own token account if missing, then mints 300 into it", () => {
    assert.equal(tx.instructions.length, 2);
    const [create, mintTo] = tx.instructions;
    const ata = getAssociatedTokenAddressSync(mint, wallet);
    assert.ok(create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    assert.deepEqual([...create.data], [1]); // CreateIdempotent
    assert.ok(create.keys[1].pubkey.equals(ata));
    assert.ok(mintTo.programId.equals(TOKEN_PROGRAM_ID));
    assert.equal(mintTo.data[0], 7); // MintTo
    assert.equal(mintTo.data.readBigUInt64LE(1), 300n);
    assert.ok(mintTo.keys[0].pubkey.equals(mint));
    assert.ok(mintTo.keys[1].pubkey.equals(ata));
    assert.ok(mintTo.keys[2].pubkey.equals(wallet)); // the mint authority is the backend wallet
  });
  it("is paid for by the wallet, so one signature is enough", () => {
    assert.ok(tx.feePayer?.equals(wallet));
  });
});

describe("PlayTokenMinter", () => {
  const ok = (calls: number[]) => async (amount: number) => { calls.push(amount); return { signature: "sig123", confirmMs: 1200 }; };

  it("mints 100 per good call and returns the result for the report", async () => {
    const calls: number[] = [];
    const m = new PlayTokenMinter({ mint: "MINT", send: ok(calls), log: () => {} });
    const r = await m.mintForRun("run-1", 3);
    assert.deepEqual(r, { minted: 300, symbol: "VPLAY", mint: "MINT", signature: "sig123", confirmMs: 1200 });
    assert.deepEqual(calls, [300]);
    assert.deepEqual(m.result("run-1"), r);
    assert.equal(m.result("other"), undefined);
  });

  it("zero good calls: nothing is sent, nothing is logged", async () => {
    const calls: number[] = [], logs: string[] = [];
    const m = new PlayTokenMinter({ mint: "MINT", send: ok(calls), log: (l) => logs.push(l) });
    assert.equal(await m.mintForRun("run-0", 0), null);
    assert.deepEqual([calls, logs], [[], []]);
  });

  it("never mints twice for the same run, even for two calls at once", async () => {
    const calls: number[] = [];
    const m = new PlayTokenMinter({ mint: "MINT", send: ok(calls), log: () => {} });
    const [a, b] = await Promise.all([m.mintForRun("run-1", 2), m.mintForRun("run-1", 2)]);
    await m.mintForRun("run-1", 2);
    assert.equal(calls.length, 1);
    assert.ok(a !== null || b !== null);
  });

  it("a failed mint is not retried for the same run, is logged once, and leaks no secrets", async () => {
    const logs: string[] = [];
    let n = 0;
    const m = new PlayTokenMinter({
      mint: "MINT", log: (l) => logs.push(l), secrets: ["https://api.devnet.example/?api-key=SECRET123"],
      send: async () => { n++; throw new Error("fetch failed for https://api.devnet.example/?api-key=SECRET123"); },
    });
    assert.equal(await m.mintForRun("run-1", 1), null);
    assert.equal(await m.mintForRun("run-1", 1), null);
    assert.equal(n, 1);
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes("SECRET123") && !logs[0].includes("devnet.example"));
  });

  it("after 3 failed runs in a row it stops trying", async () => {
    let n = 0;
    const m = new PlayTokenMinter({ mint: "M", log: () => {}, send: async () => { n++; throw new Error("x"); } });
    for (const id of ["a", "b", "c", "d", "e"]) await m.mintForRun(id, 1);
    assert.equal(n, 3);
    assert.equal(m.breaker.isOpen, true);
  });

  it("gives up after the timeout instead of waiting for ever", async () => {
    const logs: string[] = [];
    const m = new PlayTokenMinter({ mint: "M", log: (l) => logs.push(l), timeoutMs: 30, send: () => new Promise(() => {}) });
    const t0 = Date.now();
    assert.equal(await m.mintForRun("run-1", 1), null);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(logs.length, 1);
  });
});
