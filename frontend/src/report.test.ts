import { describe, expect, it } from "vitest";
import type { VolatoneEvent } from "@volatone/shared";
import { reportFromState } from "./report";
import { parseServerMessage } from "./transport";
import { initialState, reduce, type State } from "./state";

let n = 0;
type Ev = VolatoneEvent extends infer E ? (E extends unknown ? Omit<E, "id"> : never) : never;
const fold = (events: Ev[], from: State = initialState()) =>
  events.reduce((s, e) => reduce(s, { kind: "event", event: { id: `r${++n}`, ...e } as VolatoneEvent }), from);

describe("reportFromState (mock mode)", () => {
  const s = fold([
    { t: 0, type: "tick", corridor: "USD-JPY", risk: 0.2, state: "calm" },
    { t: 1000, type: "tick", corridor: "USD-JPY", risk: 0.8, state: "storm" },
    { t: 24000, type: "agent_decision", agent: "sentinel", corridor: "USD-JPY", risk: 0.6, action: "hedge", explanation: "x" },
    { t: 25000, type: "agent_decision", agent: "sentinel", corridor: "USD-JPY", risk: 0.8, action: "reduce", explanation: "y" },
    { t: 26000, type: "agent_decision", agent: "strategist", corridor: "USD-JPY", risk: 0.7, action: "hedge", explanation: "z" },
    { t: 27000, type: "player_move", corridor: "USD-JPY", action: "hedge" },
    { t: 28000, type: "agent_decision", agent: "opportunist", corridor: "USD-JPY", risk: 0.5, action: "hold", explanation: "late" },
  ]);
  const withOutcome = fold([{ t: 40000, type: "player_outcome", moveId: s.moves[0].id, result: "good", reason: "why" }], s);
  const r = reportFromState(withOutcome);

  it("peak and mean risk per corridor from the series", () => {
    expect(r.corridors).toEqual([{ corridor: "USD-JPY", peakRisk: 0.8, meanRisk: 0.5 }]);
    expect(r.agentViews).toBe(4);
  });

  it("a move carries the agents' latest view at that moment (not later ones) and its outcome", () => {
    const m = r.moves![0];
    expect(m.views.map((v) => `${v.agent}:${v.action}`).sort()).toEqual(["sentinel:reduce", "strategist:hedge"]);
    expect(m.result).toBe("good");
    expect(m.reason).toBe("why");
  });

  it("an outcome that has not arrived yet is null", () => {
    expect(reportFromState(s).moves![0].result).toBeNull();
  });

  it("counts confirmed and failed batches", () => {
    const withTx = fold([
      { t: 30000, type: "tx_confirmed", signature: "s", eventIds: [s.decisions[0].id], confirmMs: 1000 },
      { t: 31000, type: "tx_confirmed", signature: "s2", eventIds: [s.decisions[1].id], confirmMs: 1200 },
      { t: 32000, type: "tx_failed", eventIds: [s.decisions[2].id], error: "e" },
    ], s);
    expect(reportFromState(withTx).solana).toEqual({ count: 2, minMs: 1000, meanMs: 1100, maxMs: 1200, failures: 1 });
  });
});

describe("parseServerMessage", () => {
  it("tells reports from events and ignores junk", () => {
    expect(parseServerMessage('{"type":"report","status":"off"}')).toEqual({ report: { type: "report", status: "off" } });
    const ev = parseServerMessage('{"id":"e1","t":0,"type":"tick","corridor":"USD-JPY","risk":0.1,"state":"calm"}');
    expect(ev && "event" in ev && ev.event.type).toBe("tick");
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage("42")).toBeNull();
    expect(parseServerMessage('{"nope":1}')).toBeNull();
  });
});

import { statusLine } from "./components/AfterAction";
describe("report status line", () => {
  it("says where the report came from, or why there is none", () => {
    expect(statusLine({ type: "report", status: "ok", queryMs: 14 }, false)).toBe("Read back from Tiger Data in 14 ms.");
    expect(statusLine({ type: "report", status: "unavailable" }, false)).toBe("Tiger Data unavailable. Replay and Solana log are unaffected.");
    expect(statusLine({ type: "report", status: "off" }, false)).toBe("Tiger Data switched off.");
    expect(statusLine(null, false)).toContain("Reading the report");
    expect(statusLine({ type: "report", status: "ok" }, true)).toBe("MOCK: not from Tiger Data.");
  });
});

import { goodCallsText, MOCK_RUNS, pastRunsStatus } from "./pastRuns";
describe("past runs", () => {
  it("tells runs messages from events and reports", () => {
    expect(parseServerMessage('{"type":"runs","status":"off"}')).toEqual({ runs: { type: "runs", status: "off" } });
  });
  it("status line says where the list came from, or why there is none", () => {
    expect(pastRunsStatus({ type: "runs", status: "ok", runs: [] }, false)).toBe("Run records stored in MongoDB Atlas.");
    expect(pastRunsStatus({ type: "runs", status: "unavailable" }, false)).toBe("MongoDB unavailable. The replay is unaffected.");
    expect(pastRunsStatus({ type: "runs", status: "off" }, false)).toBe("MongoDB switched off.");
    expect(pastRunsStatus(null, false)).toContain("Checking MongoDB");
    expect(pastRunsStatus(MOCK_RUNS, true)).toContain("MOCK: not from MongoDB");
  });
  it("good calls reads 'X of Y', and the mock rows are clearly fake", () => {
    expect(goodCallsText(3, 4)).toBe("good calls: 3 of 4");
    expect(MOCK_RUNS.runs?.every((r) => r.runId.startsWith("mock-") && r.finishedAt.startsWith("2026-01-01"))).toBe(true);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DevnetCard, HONESTY_LINE, recordsLine, STEPS, tokenLine } from "./components/AfterAction";

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const tokens = { minted: 300, symbol: "VPLAY" as const, mint: "M", signature: "SIG", confirmMs: 1210 };
const card = (props: Parameters<typeof DevnetCard>[0]) => text(renderToStaticMarkup(createElement(DevnetCard, props)));

describe("On Solana devnet card", () => {
  it("says how many records were saved, honest when some failed", () => {
    expect(recordsLine({ count: 12, failures: 0 })).toBe("12 of 12 records saved");
    expect(recordsLine({ count: 10, failures: 2 })).toBe("10 of 12 records saved");
    expect(recordsLine({ count: 0, failures: 3 })).toBe("0 of 3 records saved");
    expect(recordsLine({ count: 0, failures: 0 })).toBe("No records saved");
    expect(recordsLine(undefined)).toBeNull();
  });

  it("the play-token line is singular for one good call and plural otherwise, and says it has no value", () => {
    expect(tokenLine(1)).toBe("Play tokens for your 1 good call. A public score marker on Solana's practice network, with no value.");
    expect(tokenLine(3)).toBe("Play tokens for your 3 good calls. A public score marker on Solana's practice network, with no value.");
    expect(tokenLine(0)).toContain("0 good calls");
  });

  it("shows the plain sentence, the four steps, the records line and the footer, in that order", () => {
    const t = card({ sol: { count: 10, minMs: 800, meanMs: 1000, maxMs: 1400, failures: 2 }, mock: false, goodCalls: 0 });
    const order = ["On Solana devnet", "Everything you did in this run", "1 You make a call", "2 It is bundled into a record", "3 Solana saves it", "4 Anyone can look it up", "10 of 12 records saved", HONESTY_LINE];
    let at = -1;
    for (const part of order) { const i = t.indexOf(part); expect(i, part).toBeGreaterThan(at); at = i; }
    expect(STEPS).toHaveLength(4);
  });

  it("has no timing anywhere: no 'ms', no 'Confirm time', not even with play tokens", () => {
    for (const t of [
      card({ sol: { count: 12, minMs: 796, meanMs: 1066, maxMs: 1390, failures: 0 }, mock: false, goodCalls: 3, tokens }),
      card({ sol: { count: 12, minMs: 796, meanMs: 1066, maxMs: 1390, failures: 0 }, mock: false, goodCalls: 0 }),
      card({ mock: true, goodCalls: 0 }),
    ]) {
      expect(t).not.toMatch(/\d\s*ms\b/i);
      expect(t).not.toMatch(/\bms\b/i);
      expect(t).not.toMatch(/confirm/i);
      expect(t).not.toMatch(/\b(796|1066|1390|1210)\b/);
    }
  });

  it("with play tokens: a '300 VPLAY' badge, the line beside it, and the Explorer link; without: none of them", () => {
    const withT = card({ sol: { count: 12, minMs: 1, meanMs: 1, maxMs: 1, failures: 0 }, mock: false, goodCalls: 3, tokens });
    expect(withT).toContain("300 VPLAY");
    expect(withT).toContain("Play tokens for your 3 good calls.");
    expect(renderToStaticMarkup(createElement(DevnetCard, { mock: false, goodCalls: 3, tokens }))).toContain("explorer.solana.com/tx/SIG?cluster=devnet");
    const without = card({ sol: { count: 12, minMs: 1, meanMs: 1, maxMs: 1, failures: 0 }, mock: false, goodCalls: 0 });
    expect(without).not.toContain("VPLAY");
    expect(without).toContain("12 of 12 records saved");
  });

  it("a lone card (Tiger Data down, tokens exist) still shows the steps and the badge, without a records line", () => {
    const t = card({ mock: false, goodCalls: 2, tokens: { ...tokens, minted: 200 } });
    expect(t).toContain("200 VPLAY");
    expect(t).toContain("Play tokens for your 2 good calls.");
    expect(t).toContain("3 Solana saves it");
    expect(t).not.toMatch(/records saved/);
  });

  it("mock mode is labelled SIMULATED, and the wording avoids 'swap', 'reward' and finality claims", () => {
    const t = card({ sol: { count: 4, minMs: null, meanMs: null, maxMs: null, failures: 0 }, mock: true, goodCalls: 1, tokens });
    expect(t).toContain("SIMULATED");
    for (const bad of [/swap/i, /reward/i, /finality/i, /\bcoin\b/i, /\bearn/i]) expect(t).not.toMatch(bad);
    expect(HONESTY_LINE).toBe("Fake money. Devnet is Solana's practice network.");
  });
});
