import { describe, expect, it } from "vitest";
import type { Corridor, StormState, VolatoneEvent } from "@volatone/shared";
import { autopilotAction, cycloneRisk, initialState, openPrompt, promptViews, reduce, secondsLeft, stormCount, stormIndex, worstState, type State } from "./state";

let n = 0;
const id = () => `evt_${String(++n).padStart(4, "0")}`;
const tick = (t: number, corridor: Corridor, state: StormState, risk = 0.5): VolatoneEvent =>
  ({ id: id(), t, type: "tick", corridor, state, risk });
const fold = (events: VolatoneEvent[], from: State = initialState()) =>
  events.reduce((s, event) => reduce(s, { kind: "event", event }), from);

describe("reducer", () => {
  it("starts idle with calm corridors", () => {
    const s = initialState();
    expect(s.status).toBe("idle");
    expect(s.corridors["USD-JPY"].state).toBe("calm");
  });

  it("ticks update one corridor and the run clock", () => {
    const s = fold([tick(5000, "USD-JPY", "storm", 0.9)]);
    expect(s.status).toBe("running");
    expect(s.t).toBe(5000);
    expect(s.corridors["USD-JPY"]).toEqual({ state: "storm", risk: 0.9 });
    expect(s.corridors["EUR-USD"].state).toBe("calm");
    expect(stormCount(s)).toBe(1);
  });

  it("finishes at the last replay second", () => {
    expect(fold([tick(150_000, "USD-JPY", "calm")]).status).toBe("finished");
  });

  it("applies escalations", () => {
    const s = fold([{ id: id(), t: 1000, type: "escalation", corridor: "GBP-USD", from: "calm", to: "spreading" }]);
    expect(s.corridors["GBP-USD"].state).toBe("spreading");
  });

  it("keeps decisions newest first and tracks the latest Sentinel decision per corridor", () => {
    const d = (agent: "sentinel" | "strategist", action: "hedge" | "hold"): VolatoneEvent =>
      ({ id: id(), t: 1000, type: "agent_decision", agent, corridor: "USD-JPY", risk: 0.5, action, explanation: "x" });
    const s = fold([d("sentinel", "hold"), d("strategist", "hedge"), d("sentinel", "hedge")]);
    expect(s.decisions).toHaveLength(3);
    expect(s.decisions[0].action).toBe("hedge");
    expect(s.sentinel["USD-JPY"]?.action).toBe("hedge");
  });

  it("reset clears everything", () => {
    const s = fold([tick(30_000, "USD-JPY", "storm"), { id: id(), t: 0, type: "reset" }]);
    expect(s.t).toBe(0);
    expect(s.corridors["USD-JPY"].state).toBe("calm");
    expect(s.decisions).toEqual([]);
  });

  it("late join: replaying history from a reset gives the same state as watching live", () => {
    const history: VolatoneEvent[] = [
      { id: id(), t: 0, type: "reset" },
      tick(0, "USD-JPY", "calm", 0.1),
      tick(1000, "USD-JPY", "spreading", 0.5),
      { id: id(), t: 1000, type: "escalation", corridor: "USD-JPY", from: "calm", to: "spreading" },
    ];
    const live = fold(history);
    const stale = fold([tick(99_000, "EUR-USD", "storm")]); // leftover state from before a reconnect
    const replayed = fold(history, reduce(stale, { kind: "clear" }));
    expect(replayed).toEqual(live);
  });

  it("matches tx events by eventIds and ignores ones from a previous run", () => {
    const dec = { id: id(), t: 1000, type: "agent_decision", agent: "sentinel", corridor: "USD-JPY", risk: 0.5, action: "hold", explanation: "x" } as const;
    let s = fold([dec]);
    const txNew: VolatoneEvent = { id: id(), t: 2000, type: "tx_confirmed", signature: "sig1", eventIds: [dec.id], confirmMs: 900 };
    s = fold([txNew], s);
    expect(s.txs).toHaveLength(1);
    s = fold([{ id: id(), t: 0, type: "reset" }], s);
    expect(s.txs).toHaveLength(0);
    // The old run's tx arrives after the reset: it matches nothing in the new run.
    s = fold([{ id: id(), t: 500, type: "tx_failed", eventIds: [dec.id], error: "rpc busy" }], s);
    expect(s.txs).toHaveLength(0);
  });
});

describe("prompts", () => {
  // DECISION_POINTS[0] = USD-JPY at second 25, open for 8 seconds.
  it("are all upcoming before the run starts", () => {
    expect(promptViews(initialState()).every((p) => p.status === "upcoming")).toBe(true);
  });

  it("open at the tick at second 25 and close at second 33", () => {
    expect(promptViews(fold([tick(24_000, "USD-JPY", "storm")]))[0].status).toBe("upcoming");
    const open = fold([tick(25_000, "USD-JPY", "storm")]);
    expect(openPrompt(open)?.corridor).toBe("USD-JPY");
    expect(promptViews(fold([tick(33_000, "USD-JPY", "storm")]))[0].status).toBe("missed");
  });

  it("an answered prompt is no longer open and links its outcome later", () => {
    const move: VolatoneEvent = { id: id(), t: 27_000, type: "player_move", corridor: "USD-JPY", action: "hedge" };
    let s = fold([tick(27_000, "USD-JPY", "storm"), move]);
    expect(openPrompt(s)).toBeUndefined();
    expect(promptViews(s)[0].status).toBe("answered");
    s = fold([{ id: id(), t: 40_000, type: "player_outcome", moveId: move.id, result: "good", reason: "r" }], s);
    expect(promptViews(s)[0].outcome?.result).toBe("good");
  });

  it("a move on another corridor does not answer the prompt", () => {
    const s = fold([tick(27_000, "USD-JPY", "storm"), { id: id(), t: 27_000, type: "player_move", corridor: "EUR-USD", action: "hold" }]);
    expect(openPrompt(s)?.corridor).toBe("USD-JPY");
  });
});

describe("derived values", () => {
  it("indexSeries holds the mean risk by replay second; the last tick of a second wins", () => {
    const s = fold([
      tick(0, "USD-JPY", "calm", 0.4), tick(0, "EUR-JPY", "calm", 0.4), tick(0, "EUR-USD", "calm", 0.4), tick(0, "GBP-USD", "calm", 0.4),
      tick(1000, "USD-JPY", "storm", 0.8), tick(1000, "EUR-JPY", "calm", 0.4), tick(1000, "EUR-USD", "calm", 0.4), tick(1000, "GBP-USD", "calm", 0.4),
    ]);
    expect(s.indexSeries[0]).toBeCloseTo(0.4);
    expect(s.indexSeries[1]).toBeCloseTo(0.5);
    expect(stormIndex(s)).toBeCloseTo(0.5);
    expect(s.corridorSeries["USD-JPY"][1]).toBe(0.8);
    expect(s.corridorSeries["EUR-JPY"][0]).toBe(0.4);
  });

  it("feed mixes decisions, moves and outcomes, newest first", () => {
    const dec: VolatoneEvent = { id: id(), t: 1, type: "agent_decision", agent: "sentinel", corridor: "USD-JPY", risk: 0.5, action: "hold", explanation: "x" };
    const mv: VolatoneEvent = { id: id(), t: 2, type: "player_move", corridor: "USD-JPY", action: "hedge" };
    const out: VolatoneEvent = { id: id(), t: 3, type: "player_outcome", moveId: mv.id, result: "good", reason: "r" };
    expect(fold([dec, mv, out]).feed.map((f) => f.type)).toEqual(["player_outcome", "player_move", "agent_decision"]);
  });

  it("cyclone risk follows the worse Japanese corridor", () => {
    const s = fold([tick(1000, "USD-JPY", "spreading", 0.4), tick(1000, "EUR-JPY", "storm", 0.9), tick(1000, "GBP-USD", "calm", 0.99)]);
    expect(cycloneRisk(s)).toBe(0.9);
    expect(worstState(s, ["USD-JPY", "GBP-USD"])).toBe("spreading");
  });

  it("secondsLeft counts down from 8 while a prompt is open and is 0 otherwise", () => {
    const at = (ms: number) => promptViews(fold([tick(ms, "USD-JPY", "storm")]))[0];
    expect(secondsLeft(fold([tick(25_000, "USD-JPY", "storm")]), at(25_000))).toBe(8);
    expect(secondsLeft(fold([tick(32_000, "USD-JPY", "storm")]), at(32_000))).toBe(1);
    expect(secondsLeft(fold([tick(33_000, "USD-JPY", "storm")]), at(33_000))).toBe(0);
  });

  it("autopilot follows Sentinel's latest view of that corridor, or holds if there is none", () => {
    const d = (action: "hedge" | "reduce"): VolatoneEvent =>
      ({ id: id(), t: 1, type: "agent_decision", agent: "sentinel", corridor: "EUR-USD", risk: 0.7, action, explanation: "x" });
    const s = fold([d("hedge"), d("reduce")]);
    expect(autopilotAction(s, "EUR-USD")).toBe("reduce");
    expect(autopilotAction(s, "USD-JPY")).toBe("hold");
  });
});
