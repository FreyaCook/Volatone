// MOCK mode (?mock=1): plays a fake event stream locally, using the same event types as the backend.
// It imitates the engine's rules (4 ticks per second, prompts from DECISION_POINTS, outcomes 15 s later,
// batched tx events). Signatures are fake. Add &tick=200 to make a replay second last 200 ms.
import type {
  Action, AgentName, Corridor, StormState, VolatoneEvent,
} from "@volatone/shared";
import { DECISION_POINTS, PROMPT_SECONDS, REPLAY_LAST_SECOND } from "@volatone/shared/protocol";
import type { ClientMessage } from "./clientMessage";
import type { Handlers, Transport } from "./transport";

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;

const CORRIDOR_ORDER: Corridor[] = ["USD-JPY", "EUR-JPY", "EUR-USD", "GBP-USD"];

// Risk keyframes [second, risk] per corridor: calm -> spreading -> storm -> easing.
const STORM: Record<Corridor, [number, number][]> = {
  "USD-JPY": [[0, 0.12], [12, 0.2], [20, 0.5], [28, 0.82], [45, 0.9], [60, 0.45], [75, 0.2], [150, 0.15]],
  "GBP-USD": [[0, 0.1], [55, 0.15], [64, 0.5], [72, 0.8], [88, 0.88], [105, 0.4], [120, 0.18], [150, 0.15]],
  "EUR-USD": [[0, 0.1], [78, 0.15], [86, 0.5], [95, 0.8], [112, 0.85], [130, 0.4], [150, 0.2]],
  "EUR-JPY": [[0, 0.1], [100, 0.18], [115, 0.5], [128, 0.8], [140, 0.9], [150, 0.7]],
};

export const riskAt = (c: Corridor, sec: number): number => {
  const k = STORM[c];
  let r = k[k.length - 1][1];
  for (let i = 1; i < k.length; i++) {
    if (sec <= k[i][0]) {
      const [t0, r0] = k[i - 1];
      const [t1, r1] = k[i];
      r = r0 + ((r1 - r0) * (sec - t0)) / (t1 - t0);
      break;
    }
  }
  const jitter = 0.02 * Math.sin(sec * 1.7 + c.length * 3); // deterministic, so every mock run is the same
  return Math.min(1, Math.max(0, r + jitter));
};

const stateOf = (r: number): StormState => (r >= 0.65 ? "storm" : r >= 0.35 ? "spreading" : "calm");
const AGENT_SCALE: Record<AgentName, number> = { sentinel: 1.1, opportunist: 0.75, strategist: 1 };
const actionOf = (r: number): Action => (r >= 0.6 ? "hedge" : r >= 0.35 ? "reduce" : "hold");

const WORDS: Record<AgentName, string> = {
  sentinel: "Sentinel watches for early warning signs",
  opportunist: "Opportunist looks for room to stay in",
  strategist: "Strategist weighs the longer picture",
};
const explain = (agent: AgentName, c: Corridor, action: Action) =>
  `${WORDS[agent]}: ${c} reads ${action === "hold" ? "steady" : "unsettled"}, so its view is ${action}. (mock text)`;

export function connectMock(h: Handlers, tickMs = 1000): Transport {
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  let sec = 0;
  let speed = 1;
  let running = false;
  let lastAction: Record<string, Action> = {};
  let lastState: Record<string, StormState> = {};
  let pendingOutcomes: { at: number; moveId: string; action: Action; corridor: Corridor }[] = [];
  let waiting: { id: string; since: number }[] = [];
  const answered = new Set<string>();

  const emit = (e: DistributiveOmit<VolatoneEvent, "id">): string => {
    const id = `evt_${String(++seq).padStart(4, "0")}`;
    h.onEvent({ id, ...e } as VolatoneEvent);
    return id;
  };

  const log = (id: string) => waiting.push({ id, since: sec });
  const flush = () => {
    if (!waiting.length) return;
    const batch = waiting.splice(0, 8);
    const sentAt = sec * 1000;
    const timeout = setTimeout(() => {
      timeouts.delete(timeout);
      emit({ type: "tx_confirmed", t: sentAt, signature: "MOCK" + Math.random().toString(36).slice(2, 12).padEnd(10, "x") + "0".repeat(70), eventIds: batch.map((b) => b.id), confirmMs: 700 + Math.round(Math.random() * 600) });
    }, 900 / speed);
    timeouts.add(timeout);
    if (waiting.length) flush();
  };

  const decide = (agent: AgentName, c: Corridor, force: boolean) => {
    const risk = Math.min(1, riskAt(c, sec) * AGENT_SCALE[agent]);
    const action = actionOf(risk);
    const key = agent + c;
    if (!force && lastAction[key] === action) return;
    lastAction[key] = action;
    log(emit({ type: "agent_decision", t: sec * 1000, agent, corridor: c, risk: +risk.toFixed(2), action, explanation: explain(agent, c, action) }));
  };

  const step = () => {
    for (const c of CORRIDOR_ORDER) {
      const risk = riskAt(c, sec);
      emit({ type: "tick", t: sec * 1000, corridor: c, risk: +risk.toFixed(2), state: stateOf(risk) });
    }
    for (const c of CORRIDOR_ORDER) {
      const s = stateOf(riskAt(c, sec));
      if (lastState[c] && lastState[c] !== s) emit({ type: "escalation", t: sec * 1000, corridor: c, from: lastState[c], to: s });
      lastState[c] = s;
    }
    const dp = DECISION_POINTS.find((d) => d.second === sec);
    for (const c of CORRIDOR_ORDER) {
      for (const a of ["sentinel", "opportunist", "strategist"] as AgentName[]) {
        if (a === "strategist" && sec % 10 !== 0 && !dp) continue;
        decide(a, c, !!dp && dp.corridor === c);
      }
    }
    for (const o of pendingOutcomes.filter((p) => p.at === sec)) {
      const good = o.action !== "hold" || riskAt(o.corridor, sec) < 0.5;
      log(emit({ type: "player_outcome", t: sec * 1000, moveId: o.moveId, result: good ? "good" : "poor", reason: good ? "Risk rose after your move, and your choice limited the exposure. (mock text)" : "Holding left the position open while risk rose. (mock text)" }));
    }
    pendingOutcomes = pendingOutcomes.filter((p) => p.at !== sec);
    if (waiting.length && sec - waiting[0].since >= 3) flush();
    if (sec >= REPLAY_LAST_SECOND) {
      clearInterval(timer);
      running = false;
      flush();
    }
    sec++;
  };

  const begin = (s: number) => {
    clearInterval(timer);
    flush();
    sec = 0; speed = s; running = true;
    lastAction = {}; lastState = {}; pendingOutcomes = []; answered.clear();
    timer = setInterval(step, tickMs / speed);
    step();
  };

  h.onStatus("open");

  return {
    send(m: ClientMessage) {
      if (m.type === "start") {
        if (!running) { if (sec > 0) emit({ type: "reset", t: 0 }); begin(m.speed ?? 1); }
      } else if (m.type === "reset") {
        emit({ type: "reset", t: 0 });
        begin(m.speed ?? speed);
      } else if (m.type === "player_move" && running) {
        const dp = DECISION_POINTS.find((d) => d.corridor === m.corridor && sec - 1 >= d.second && sec - 1 < d.second + PROMPT_SECONDS);
        if (!dp || answered.has(dp.id)) return;
        answered.add(dp.id);
        const moveId = emit({ type: "player_move", t: (sec - 1) * 1000, corridor: m.corridor, action: m.action });
        log(moveId);
        flush(); // a player move is sent at once
        pendingOutcomes.push({ at: dp.second + 15, moveId, action: m.action, corridor: m.corridor });
      }
    },
    close() {
      clearInterval(timer);
      timeouts.forEach(clearTimeout);
    },
  };
}
