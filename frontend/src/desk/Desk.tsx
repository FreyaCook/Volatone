import type { Action, Corridor } from "@volatone/shared";
import type { Speed } from "../clientMessage";
import { CORRIDORS, promptViews, secondsLeft, stormIndex, type PromptView, type State } from "../state";
import { STATE_COLOR, STATE_NAME } from "../chart/geometry";
import { pct, tplus } from "../format";

const SCOPE_D = "M0 20 L5 12 L10 26 L16 8 L22 30 L28 16 L34 24 L40 10 L46 32 L52 14 L58 22 L64 6 L70 28 L76 18 L82 34 L88 12 L94 24 L100 20 L105 12 L110 26 L116 8 L122 30 L128 16 L134 24 L140 10 L146 32 L152 14 L158 22 L164 6 L170 28 L176 18 L182 34 L188 12 L194 24 L200 20";
const LABEL: Record<Corridor, { text: string; rot: string }> = {
  "USD-JPY": { text: "USD/JPY", rot: "rotate(-2deg)" },
  "EUR-JPY": { text: "EUR/JPY", rot: "rotate(1.5deg)" },
  "EUR-USD": { text: "EUR/USD", rot: "rotate(-1deg)" },
  "GBP-USD": { text: "GBP/USD", rot: "rotate(2deg)" },
};
const SPEEDS: { value: Speed; label: string }[] = [
  { value: 1, label: "NORMAL" },
  { value: 2, label: "FAST 2×" },
  { value: 3, label: "RUSH 3×" },
];
const MOVES: { action: Action; key: number; swatch: string }[] = [
  { action: "hedge", key: 1, swatch: "#ffb000" },
  { action: "hold", key: 2, swatch: "#fffaf0" },
  { action: "reduce", key: 3, swatch: "#ff4a1c" },
];

interface Props {
  state: State;
  prompt: PromptView | undefined; // the open prompt, if any
  speed: Speed;
  speedEnabled: boolean;
  autopilot: boolean; // Rush: autopilot is armed
  conn: "connecting" | "open" | "closed";
  onSpeed: (s: Speed) => void;
  onStart: () => void;
  onReset: () => void;
  onMove: (a: Action) => void;
}

export function Desk(p: Props) {
  const { state } = p;
  const running = state.status === "running";
  const idx = stormIndex(state);
  const needle = -48 + idx * 100 * 0.96;
  const idxColor = idx >= 0.62 ? STATE_COLOR.storm : idx >= 0.3 ? STATE_COLOR.spreading : STATE_COLOR.calm;
  return (
    <div className="desk">
      <i className="screw tl" /><i className="screw tr" /><i className="screw bl" /><i className="screw br" />
      <div className="desk-row">
        <div className="desk-col transport">
          <h3>TRANSPORT</h3>
          <div className="counter" aria-label="Replay counter"><span>{tplus(state.t)}</span><small> s</small></div>
          <div className="btn-row">
            <button className="key key-cream" onClick={p.onStart} disabled={p.conn !== "open" || running}>
              <i className="lamp" style={{ background: running ? "#ff4a1c" : "#6b6456" }} />START
            </button>
            <button className="key key-dark reset" onClick={p.onReset} disabled={p.conn !== "open"}>RESET</button>
          </div>
          <h3>TAPE SPEED</h3>
          <div className="speed-row" role="radiogroup" aria-label="Tape speed">
            {SPEEDS.map((s) => (
              <button key={s.value} role="radio" aria-checked={p.speed === s.value} className="key key-dark speed"
                disabled={!p.speedEnabled || running} onClick={() => p.onSpeed(s.value)}
                title={p.speedEnabled ? undefined : "Speed control needs the engine update (not merged yet)"}>
                <i className="led-bar" style={{ background: p.speed === s.value ? "#ffb000" : "#4a443a" }} />{s.label}
              </button>
            ))}
          </div>
          {!p.speedEnabled && <p className="note-dark">Speed control is waiting for the backend update. Normal speed only.</p>}
        </div>

        <div className="desk-col channels-wrap">
          <h3>CORRIDOR CHANNELS</h3>
          <div className="channels">
            {CORRIDORS.map((c) => {
              const v = state.corridors[c];
              const col = STATE_COLOR[v.state];
              const r = pct(v.risk);
              return (
                <div key={c} className="channel">
                  <div className="tape" style={{ transform: LABEL[c].rot }}>{LABEL[c].text}</div>
                  <div className="scope" aria-hidden="true">
                    <div style={{ height: 40, transform: `scaleY(${(0.12 + v.risk * 0.88).toFixed(2)})`, transition: "transform .3s linear" }}>
                      <svg className="scope-trace" viewBox="0 0 200 40" preserveAspectRatio="none">
                        <path d={SCOPE_D} fill="none" stroke={col} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
                      </svg>
                    </div>
                  </div>
                  <div className="fader-row" aria-hidden="true">
                    <div className="meter"><div className="meter-fill" style={{ height: `${r}%` }}><div className="meter-grad" /></div><div className="meter-mask" /></div>
                    <div className="fader"><div className="slot" /><div className="cap" style={{ bottom: Math.round(v.risk * 124) }} /></div>
                    <div className="scale"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
                  </div>
                  <div className="big-pct" style={{ color: col }}>{r}<small>%</small></div>
                  <div className="state-name" style={{ color: col }}>{STATE_NAME[v.state]}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="desk-col master">
          <h3>MASTER</h3>
          <div className="vu">
            <svg width="240" height="150" viewBox="0 0 240 150" role="img" aria-label={`Storm index ${pct(idx)} percent`}>
              <defs><radialGradient id="vuface" cx="50%" cy="100%" r="90%"><stop offset="0" stopColor="#fff3cf" /><stop offset="1" stopColor="#e6d6a8" /></radialGradient></defs>
              <rect width="240" height="150" fill="url(#vuface)" />
              <path d="M56.1 80.5 A86 86 0 0 1 183.9 80.5" fill="none" stroke="#1a1a18" strokeWidth="1.5" />
              <path d="M137.1 53.7 A86 86 0 0 1 183.9 80.5" fill="none" stroke="#c8321a" strokeWidth="5" />
              <g stroke="#1a1a18" strokeWidth="1.4" fontFamily="'IBM Plex Mono', monospace" fontSize="11" textAnchor="middle">
                {[-48, -38.4, -28.8, -19.2, -9.6, 0, 9.6, 19.2, 28.8, 38.4, 48].map((deg, i) => (
                  <g key={deg} transform={`rotate(${deg} 120 138)`}>
                    <line x1="120" y1={i % 2 === 0 ? 42 : 46} x2="120" y2="52" />
                    {i % 2 === 0 && <text x="120" y="36" stroke="none" fill={i >= 8 ? "#b8290f" : "#1a1a18"}>{i * 10}</text>}
                  </g>
                ))}
              </g>
              <text x="120" y="108" textAnchor="middle" fontFamily="'Barlow Condensed', sans-serif" fontWeight="700" fontSize="14" letterSpacing="2.5" fill="#1a1a18">STORM INDEX</text>
              <g style={{ transform: `rotate(${needle.toFixed(1)}deg)`, transformOrigin: "120px 138px", transition: "transform .3s linear" }}>
                <g className="jit"><line x1="120" y1="138" x2="120" y2="50" stroke="#1a1a18" strokeWidth="1.8" strokeLinecap="round" /></g>
              </g>
              <circle cx="120" cy="138" r="10" fill="#1a1a18" />
            </svg>
          </div>
          <div className="big-idx" style={{ color: idxColor }}>{pct(idx)}<small>%</small></div>
          <p className="note-dark center">Average risk across the four corridors</p>
        </div>

        <YourMove {...p} />
      </div>
    </div>
  );
}

function YourMove({ state, prompt, onMove, autopilot }: Props) {
  const open = !!prompt;
  const left = prompt ? secondsLeft(state, prompt) : 0;
  const idle = state.status === "idle";
  const all = promptsSummary(state);
  const latestAnswered = all.answered.at(-1);
  let title = "Press START to begin";
  if (open) title = `${prompt.corridor}: hedge, hold or reduce?`;
  else if (!idle && all.next) title = `Standing by. Next prompt at ${tplus(all.next.opensT)}`;
  else if (!idle) title = "Standing by. No prompts left in this replay";

  let note = "";
  if (open) note = `${left} s left`;
  else if (latestAnswered?.move && !latestAnswered.outcome) note = `Move logged: ${latestAnswered.move.action.toUpperCase()} on ${latestAnswered.corridor}. Outcome follows the 15 s look-ahead.`;
  else if (all.lastMissed && (!latestAnswered || all.lastMissed.opensT > latestAnswered.opensT)) note = `${all.lastMissed.corridor} prompt missed. Nothing was logged.`;

  const outcome = [...all.answered].reverse().find((a) => a.outcome);
  const picked = prompt ? undefined : latestAnswered?.move?.action;
  return (
    <div className="desk-col yourmove">
      <h3>YOUR MOVE</h3>
      <div className="move-title">{title}</div>
      <div className="leds-row">
        {Array.from({ length: 8 }, (_, i) => (
          <i key={i} className="led" style={i < left ? { background: "#ffb000", boxShadow: "0 0 8px #ffb000" } : undefined} />
        ))}
        <span className="note-dark">{note}</span>
      </div>
      <div className="move-keys">
        {MOVES.map((m) => (
          <button key={m.action} className={`key key-cream move ${picked === m.action ? "picked" : ""}`} disabled={!open}
            onClick={() => onMove(m.action)} aria-keyshortcuts={String(m.key)}>
            <span className="swatch" style={{ background: m.swatch }} />{m.action.toUpperCase()}<small>KEY {m.key}</small>
          </button>
        ))}
      </div>
      {autopilot && <p className="autopilot"><b>AUTOPILOT ARMED (RUSH)</b>: if you have not clicked 2.5 s after a prompt opens, it plays Sentinel's latest view for you and says so.</p>}
      {outcome?.outcome && (
        <p className={`outcome outcome-${outcome.outcome.result}`}>
          <b>{outcome.outcome.result === "good" ? "✓ GOOD" : "✗ POOR"}</b> {outcome.corridor}: {outcome.outcome.reason}
        </p>
      )}
      <p className="note-dark">Eight replay seconds per decision. Every move is logged on Solana devnet.</p>
    </div>
  );
}

function promptsSummary(s: State) {
  const v = promptViews(s);
  return {
    answered: v.filter((p) => p.status === "answered"),
    next: v.find((p) => p.status === "upcoming"),
    lastMissed: [...v].reverse().find((p) => p.status === "missed"),
  };
}
