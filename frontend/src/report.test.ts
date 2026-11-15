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
