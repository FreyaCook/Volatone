import "./fonts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Action } from "@volatone/shared";
import type { Speed } from "./clientMessage";
import { announce } from "./announce";
import { clipsForChange, freshFlags, introFor, type ClipId } from "./narration";
import { Narrator } from "./narrator";
import { Sound, tensionFor } from "./sound";
import { freshMusicSeen, maxStress, musicEvents } from "./music";
import { autopilotAction, openPrompt, stormCount } from "./state";
import { MOCK, useFeed } from "./useFeed";
import { useStateChanges } from "./useStateChanges";
import { WeatherChart } from "./chart/WeatherChart";
import { Barograph } from "./chart/Barograph";
import { Dispatches } from "./components/Dispatches";
import { Teleprinter } from "./components/Teleprinter";
import { Desk } from "./desk/Desk";
import { AfterAction } from "./components/AfterAction";
import { tplus } from "./format";

// TODO: set to true (or delete this flag) after merging the engine branch: shared/protocol.ts will then
// carry the optional `speed` on start/reset. Until then the speed keys are disabled outside mock mode.
const PROTOCOL_HAS_SPEED = true;
const SPEED_ENABLED = MOCK || PROTOCOL_HAS_SPEED;
const AUTOPILOT_DELAY_MS = 2500;

const sound = new Sound();
const narrator = new Narrator();
// Lines the aria-live region would not otherwise say (decisions, state changes, prompts and outcomes are already announced).
const SPOKEN_ONLY: ClipId[] = ["intro", "start", "easing", "end"];

export default function App() {
  const { state, conn, send, report } = useFeed();
  const [speed, setSpeed] = useState<Speed>(1);
  const [muted, setMuted] = useState(false);
  const [live, setLive] = useState<string[]>([]);
  const [autoPrompts, setAutoPrompts] = useState<Record<string, true>>({});

  const prompt = openPrompt(state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const speedField = SPEED_ENABLED ? { speed } : {};

  const introPlayed = useRef(false);
  const flags = useRef(freshFlags());
  const musicSeen = useRef(freshMusicSeen());
  const [caption, setCaption] = useState<{ id: ClipId; text: string } | null>(null);

  const start = useCallback(() => {
    // First START in this page session: intro, then "start" (the click also unlocks audio).
    if (introFor(introPlayed.current, speed)) narrator.play("intro", "start");
    introPlayed.current = true;
    send({ type: "start", ...speedField });
  }, [send, speed]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = () => { setAutoPrompts({}); musicSeen.current = freshMusicSeen(); sound.resetMusic(); send({ type: "reset", ...speedField }); };
  const move = useCallback((action: Action) => {
    const p = openPrompt(stateRef.current);
    if (p) send({ type: "player_move", corridor: p.corridor, action });
  }, [send]);

  // Sound starts only after the first click or key press.
  useEffect(() => {
    const go = () => sound.start();
    window.addEventListener("pointerdown", go, { once: true });
    window.addEventListener("keydown", go, { once: true });
    return () => { window.removeEventListener("pointerdown", go); window.removeEventListener("keydown", go); sound.dispose(); };
  }, []);
  useEffect(() => { sound.setTension(tensionFor(stormCount(state))); sound.setStress(maxStress(state)); }, [state]);
  useEffect(() => { sound.setMuted(muted); narrator.setMuted(muted); }, [muted]);
  useEffect(() => {
    narrator.onCaption = (c) => {
      sound.setDucked(c !== null); // voice on: music and drone duck
      setCaption(c);
      if (c && SPOKEN_ONLY.includes(c.id)) setLive((l) => [...l, c.text].slice(-4));
    };
    void narrator.load();
  }, []);

  // aria-live announcements and sound cues, from what changed in the state.
  useStateChanges(state, conn, (prev, next) => {
    const msgs = announce(prev, next);
    if (msgs.length) setLive((l) => [...l, ...msgs].slice(-4));
    if (next.decisions.length > prev.decisions.length) sound.cue("decision");
    if (openPrompt(next)?.id !== openPrompt(prev)?.id && openPrompt(next)) sound.cue("prompt");
    for (const [id, o] of Object.entries(next.outcomes)) if (!prev.outcomes[id]) sound.cue(o.result);
    const me = musicEvents(prev, next, musicSeen.current);
    musicSeen.current = me.seen;
    if (me.newRun) sound.resetMusic();
    if (me.stormHit) sound.stormHit();
    if (me.ended) sound.endMusic();
    const n = clipsForChange(prev, next, flags.current, speed);
    flags.current = n.flags;
    n.clips.forEach((c) => narrator.play(c));
  });

  // Keyboard: 1, 2, 3 answer an open prompt; Space starts (the protocol has no pause).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const keyed: Record<string, Action> = { "1": "hedge", "2": "hold", "3": "reduce" };
      if (keyed[e.key]) move(keyed[e.key]);
      else if (e.key === " " && !(e.target instanceof HTMLButtonElement) && stateRef.current.status !== "running" && conn === "open") {
        e.preventDefault();
        start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, start, conn]);

  // Rush only: autopilot plays Sentinel's latest view if the player has not clicked in 2.5 real seconds.
  const autopilot = SPEED_ENABLED && speed === 3;
  const promptId = prompt?.id;
  useEffect(() => {
    if (!autopilot || !promptId) return;
    const timer = setTimeout(() => {
      const p = openPrompt(stateRef.current);
      if (!p || p.id !== promptId) return;
      setAutoPrompts((a) => ({ ...a, [p.id]: true }));
      send({ type: "player_move", corridor: p.corridor, action: autopilotAction(stateRef.current, p.corridor) });
    }, AUTOPILOT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autopilot, promptId, send]);

  const connText = MOCK ? "MOCK MODE · FAKE EVENTS" : conn === "open" ? "CONNECTED" : conn === "connecting" ? "CONNECTING…" : "DISCONNECTED · RETRYING…";

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>VOLATONE</h1>
          <p className="tagline">Hear the storm before it breaks</p>
        </div>
        <div className="grow" />
        <div className="plates">
          <div><span>CHART NO.</span>20261114</div>
          <div><span>SCENARIO</span>Tokyo surprise</div>
          <div><span>REPLAY CLOCK</span>{tplus(state.t)} of 150 s</div>
          <div><span>NETWORK</span>Solana devnet</div>
          <div><span>FUNDS</span>Fake money</div>
        </div>
        <div className="status-col">
          <span className={`conn conn-${conn}`} role="status">{connText}</span>
          <button className="mute" aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
            {muted ? "🔇 SOUND OFF" : "🔊 SOUND ON"}
          </button>
        </div>
      </header>
      <p className="intro">
        A practice simulation for new currency traders, designed to help you notice risk building. Agent decisions are computed by code; Gemini only wrote the cached explanations. Fake money on Solana devnet. Narration is pre-generated with ElevenLabs, not a live AI voice.
      </p>

      {conn !== "open" && !MOCK && (
        <p className="banner" role="status">Can't reach the replay server yet. Trying again every few seconds. Start the backend, or add <code>?mock=1</code> to the address to play a local demo.</p>
      )}

      {caption && <p className="caption" aria-hidden="true"><span>NARRATION</span> {caption.text}</p>}

      <div className="upper">
        <div className="chart-col">
          <div className="chart-frame"><i className="tape-a" /><i className="tape-b" /><div className="ring1"><div className="ring2"><WeatherChart state={state} /></div></div></div>
          <Barograph state={state} />
        </div>
        <div className="side-col">
          <div className="side-inner">
            <Dispatches state={state} autoPrompts={autoPrompts} />
            <Teleprinter state={state} mock={MOCK} />
          </div>
        </div>
      </div>

      <Desk state={state} prompt={prompt} speed={speed} speedEnabled={SPEED_ENABLED} autopilot={autopilot} conn={conn}
        onSpeed={setSpeed} onStart={start} onReset={reset} onMove={move} />

      {state.status === "finished" && <AfterAction report={report} mock={MOCK} />}

      <footer className="foot">Simulation. Fake money. Solana devnet. Not financial advice.</footer>
      <div className="sr" aria-live="polite" aria-atomic="false">{live.map((m, i) => <p key={`${i}-${m}`}>{m}</p>)}</div>
    </div>
  );
}
