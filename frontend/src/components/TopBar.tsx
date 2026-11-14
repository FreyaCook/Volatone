import type { Speed } from "../clientMessage";
import type { ConnStatus } from "../transport";
import type { RunStatus } from "../state";
import { clock } from "../theme";

const SPEEDS: { value: Speed; label: string }[] = [
  { value: 1, label: "Normal" },
  { value: 2, label: "Fast (2x)" },
  { value: 3, label: "Rush (3x)" },
];

interface Props {
  status: RunStatus;
  t: number;
  conn: ConnStatus;
  mock: boolean;
  speed: Speed;
  onSpeed: (s: Speed) => void;
  onStart: () => void;
  onReset: () => void;
}

const CONN_TEXT: Record<ConnStatus, string> = { open: "Connected", connecting: "Connecting…", closed: "Disconnected, retrying…" };

export function TopBar({ status, t, conn, mock, speed, onSpeed, onStart, onReset }: Props) {
  const ready = conn === "open";
  return (
    <header className="topbar">
      <div className="brand">
        <h1>Volatone</h1>
        <p>Hear the storm before it breaks.</p>
      </div>

      <div className="controls">
        <div className="speed" role="radiogroup" aria-label="Replay speed (choose before starting)">
          {SPEEDS.map((s) => (
            <label key={s.value} className={speed === s.value ? "on" : ""}>
              <input type="radio" name="speed" checked={speed === s.value} disabled={status === "running"} onChange={() => onSpeed(s.value)} />
              {s.label}
            </label>
          ))}
        </div>
        <button className="primary" onClick={onStart} disabled={!ready || status === "running"}>
          {status === "finished" ? "Play again" : "Start storm"}
        </button>
        <button onClick={onReset} disabled={!ready}>Reset storm</button>
      </div>

      <div className="status">
        <span className={`conn conn-${conn}`}>{mock ? "Mock mode" : CONN_TEXT[conn]}</span>
        <span className="clock" aria-label="Replay time">{status === "idle" ? "Ready" : `${clock(t)} / 2:30`}</span>
      </div>
    </header>
  );
}
