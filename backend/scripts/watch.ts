// Watch a replay in the terminal: connects to the WebSocket feed and prints events one per line.
// Ticks are folded into one line per replay second (all four corridors).
//   npm run watch -w backend                    start (or join) a run and watch it
//   npm run watch -w backend -- --autoplay      also answer each prompt with the agents' majority view
//   npm run watch -w backend -- --reset         reset the storm first, then watch from t = 0
//   npm run watch -w backend -- --no-ticks      hide the per-second tick lines
//   --url ws://host:port                        (default ws://localhost:$PORT or 8080)
// Sending "start" while a run is going does nothing; when a run has finished it starts a new one.

import { parseArgs } from "node:util";
import WebSocket from "ws";
import type { Action, AgentName, Corridor, TickEvent, VolatoneEvent } from "@volatone/shared";
import { DECISION_POINTS, PROMPT_SECONDS, type ClientMessage } from "@volatone/shared/protocol";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: `ws://localhost:${process.env.PORT ?? 8080}` },
    autoplay: { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
    "no-ticks": { type: "boolean", default: false },
  },
});

const ws = new WebSocket(values.url!);
const send = (m: ClientMessage) => ws.send(JSON.stringify(m));

const secs = (t: number) => `${(t / 1000).toFixed(1).padStart(6)}s`;
const pct = (r: number) => `${Math.round(r * 100)}%`.padStart(4);
const NAME: Record<AgentName, string> = { sentinel: "Sentinel", opportunist: "Opportunist", strategist: "Strategist" };

// Per-run state, cleared on reset.
let ticks: TickEvent[] = [];
let views = new Map<string, Action>(); // `${agent}:${corridor}` -> latest announced action
let answered = new Set<string>();      // decision point ids with a player_move
let openDp: (typeof DECISION_POINTS)[number] | null = null;

/** The agents' majority view on a corridor (everyone starts on hold); hedge if all three differ. */
function majority(corridor: Corridor): Action {
  const counts = new Map<Action, number>();
  for (const a of ["sentinel", "opportunist", "strategist"] as AgentName[]) {
    const v = views.get(`${a}:${corridor}`) ?? "hold";
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const [best, n] = [...counts].sort((x, y) => y[1] - x[1])[0];
  return n >= 2 ? best : "hedge";
}

function onTick(e: TickEvent): void {
  ticks.push(e);
  if (ticks.length < 4) return;
  if (!values["no-ticks"]) {
    console.log(`${secs(e.t)}  ticks     ${ticks.map((x) => `${x.corridor} ${pct(x.risk)} ${x.state.padEnd(9)}`).join(" | ")}`);
  }
  ticks = [];

  const second = e.t / 1000;
  if (openDp && second >= openDp.second + PROMPT_SECONDS) {
    if (!answered.has(openDp.id)) console.log(`${secs(e.t)}  PROMPT    ${openDp.corridor} closed: missed (nothing logged)`);
    openDp = null;
  }
  const dp = DECISION_POINTS.find((d) => d.second === second);
  if (dp) {
    openDp = dp;
    console.log(`${secs(e.t)}  PROMPT    ${dp.corridor}: hedge, hold or reduce? (${PROMPT_SECONDS} s)`);
    if (values.autoplay && !answered.has(dp.id)) {
      // Answer after the agents at this second have spoken (they arrive right after the ticks).
      setTimeout(() => send({ type: "player_move", corridor: dp.corridor, action: majority(dp.corridor) }), 200);
    }
  }
}

function print(e: VolatoneEvent): void {
  const at = secs(e.t);
  switch (e.type) {
    case "tick":
      return onTick(e);
    case "escalation":
      return console.log(`${at}  ESCALATE  ${e.corridor}: ${e.from} -> ${e.to}`);
    case "agent_decision":
      views.set(`${e.agent}:${e.corridor}`, e.action);
      return console.log(`${at}  AGENT     ${NAME[e.agent].padEnd(11)} ${e.corridor} ${e.action.toUpperCase().padEnd(6)} (risk ${pct(e.risk)})  "${e.explanation}"  [${e.id}]`);
    case "player_move":
      if (openDp?.corridor === e.corridor) answered.add(openDp.id);
      return console.log(`${at}  YOU       ${e.corridor} ${e.action.toUpperCase()}  [${e.id}]`);
    case "player_outcome":
      return console.log(`${at}  OUTCOME   ${e.result.toUpperCase()}: ${e.reason}  [move ${e.moveId}]`);
    case "reset":
      ticks = [];
      views = new Map();
      answered = new Set();
      openDp = null;
      return console.log(`\n${at}  RESET     storm restarted  [${e.id}]`);
    case "tx_confirmed":
      return console.log(`${at}  TX OK     ${e.eventIds.length} events, confirmed in ${e.confirmMs} ms  https://explorer.solana.com/tx/${e.signature}?cluster=devnet`);
    case "tx_failed":
      return console.log(`${at}  TX FAILED ${e.eventIds.length} events: ${e.error}`);
  }
}

ws.on("open", () => {
  console.log(`connected to ${values.url}${values.autoplay ? " (autoplay)" : ""}`);
  send({ type: values.reset ? "reset" : "start" });
});
ws.on("message", (data) => print(JSON.parse(data.toString()) as VolatoneEvent));
ws.on("close", () => {
  console.log("disconnected");
  process.exit(0);
});
ws.on("error", (err) => {
  console.error(`could not connect to ${values.url}: ${err.message} (is the backend running? npm run dev -w backend)`);
  process.exit(1);
});
