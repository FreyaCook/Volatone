# Volatone - shared context

Read this first in every Claude session. If something here changes, update it.

## What it is
Tagline: "Hear the storm before it breaks."
A replay of a hard-coded market storm. A world map shows currency corridors going calm -> spreading -> storm. Three independent agents (Sentinel, Opportunist, Strategist) score risk in plain code. Gemini only turns their results into plain-English explanations. The player can hedge, hold or reduce. Music is generated in the browser (Web Audio API) and gets tenser as risk rises.

## Hard rules (keep every claim true)
- Solana DEVNET only, fake money only (devnet SOL + custom demo SPL tokens: demo GBP, EUR, USD, JPY).
- Every agent decision, player move and player outcome is logged in a real devnet transaction (small custom Anchor program, worker on Vultr). Batched: a player move is sent at once; everything else (including player_outcome) rides in the next batch, sent when the oldest waiting event has waited 3 s; max 8 per tx. Meaningful events only, no padding. A missed prompt logs nothing (UI shows "missed").
- Say "confirmed in about a second", not "sub-second finality". Say "transfers/logged moves", not "swaps".
- Report only our own measured numbers (tx count, latency).
- Not financial advice. A simulation. Pitch as "designed to help", not proven.

## Stack
- Backend: TypeScript/Node on Vultr (replay engine + agents + transaction worker + WebSocket feed, `backend/src/engine/`)
- Frontend: React + map (deck.gl or react-globe.gl - undecided)
- Chain: Solana devnet, Anchor program, free-tier RPC provider (NOT our own node)
- Music: Web Audio API. Narration: ElevenLabs (pre-generated). Explanations: Gemini (cached, with fallback text)
- Data: Tiger Data for time-series ticks (cut-list item)

## Event format
FINAL. Source of truth: `shared/events.ts` (discriminated union on `type`). Don't redefine event shapes anywhere else.
- Types: tick, agent_decision, player_move, player_outcome, escalation, reset, tx_confirmed, tx_failed.
- `t` = ms since the current run started (restarts at 0 after reset). Event ids never restart.
- Signatures arrive later in `tx_confirmed` (with `eventIds` and measured `confirmMs`), not on the decision itself.

## WebSocket protocol (backend <-> frontend)
Source of truth: `shared/events.ts` (server -> client) and `shared/protocol.ts` (client -> server, plus the prompt schedule). The frontend imports only from `@volatone/shared` and `@volatone/shared/protocol`.
- URL: `ws://localhost:8080` locally (`PORT` env var on the backend).
- Server -> client: every message is one `VolatoneEvent` as JSON. Nothing else is ever sent (no acks, no errors, no prompt messages).
- Client -> server: `{"type":"start","speed"?:1|2|3}`, `{"type":"player_move","corridor":"USD-JPY","action":"hedge"}`, `{"type":"reset","speed"?:1|2|3}`.
  - `start`: idle -> begin at `speed` (default 1). Running -> ignored (speed unchanged). Finished -> same as `reset` at `speed` (default 1).
  - `reset`: waiting events are still sent to devnet, then a `reset` event (t = 0, with `speed`) and the run restarts at t = 0. Keeps the current speed unless a new one is given. Event ids never restart.
- Speed: 1, 2 or 3 replay seconds per real second (any other value = invalid message, ignored). Only real-time pacing changes: every `t`, the 8 s prompt window and the 15 s look-ahead are in replay seconds, so they are identical at every speed. At speed 3 a prompt is open for about 2.7 real seconds. Devnet batching stays in real time (3 s wait), so at higher speeds more events share a transaction.
  - The `reset` event carries `speed` (optional field on `ResetEvent`). The very first run after the backend starts has no reset event, so a late joiner to that run can't read its speed from the feed; assume 1 unless this client started it.
  - Frontend should offer three speeds: **Normal** (1), **Fast** (2) and **Rush** (3). In Rush, prompts pass too quickly to answer comfortably, so the frontend runs a client-side autopilot that sends a move at each prompt, clearly labelled as autopilot in the UI (the moves are still real logged player moves). The backend has no autopilot.
- Bad messages are ignored silently: invalid JSON or shape, a move with no prompt open, the wrong corridor, a second move on the same prompt, or a move after the prompt closed. The UI should only enable the buttons while a prompt is open and unanswered, and treat the echoed `player_move` event as the confirmation.
- Late joiners / browser refresh: on connect the server first sends every event since the current run began (starting with its `reset` event, if the run began with one), then live events. Rebuild state by replaying them in order. tx_confirmed/tx_failed for the previous run can arrive after a reset; match them by `eventIds`.
- Order within one replay second: 4 `tick`s (corridor order), then `escalation`s, then `agent_decision`s, then any `player_outcome` due. Replay runs seconds 0..150 (`REPLAY_LAST_SECOND`), then finishes.
- No prompt event. Prompts are derived from tick times using `DECISION_POINTS` and `PROMPT_SECONDS` (8) in `shared/protocol.ts` (a backend test keeps them equal to storm.json). A prompt opens with the tick at `t = second*1000` and closes with the tick at `t = (second + 8)*1000`. No `player_move` in that window = "missed" (nothing is logged; the UI shows "missed").
- Outcomes: a move is judged at once (fixed rules, storm data only), but its `player_outcome` is sent when the 15 s look-ahead ends: at `t = (decision point second + 15)*1000`. If the storm is reset before then, that outcome is never sent (the move itself is still logged).
- tx events: `tx_confirmed` / `tx_failed` arrive about a second after their batch is sent. None at all when the backend runs with `CHAIN=off`.

## How to run
From the repo root:
- Tests: `npm test`
- Backend without Solana (local dev): `CHAIN=off npm run dev -w backend`
- Backend with real devnet logging: `npm run dev -w backend` (wallet at `.keys/volatone-wallet.json`, settings in `.env`)
- Faster replay for testing: put `TICK_MS=250` in front (ms per replay second, default 1000).
- Watch a run in a terminal: `npm run watch -w backend` (options after `--`: `--autoplay`, `--reset`, `--speed 1|2|3`, `--no-ticks`, `--url ws://host:port`).
- Regenerate Gemini explanations (one API request, needs `GEMINI_API_KEY` in `.env`): `npm run make-explanations -w backend`. Writes `backend/src/agents/explanations.json`; any explanation failing validation (one sentence, under 160 chars, no advice words like buy/sell/should/guaranteed, starts with the agent name, names the corridor) uses the plain-English fallback instead. `-- --dry-run` prints the prompt without calling the API; `-- --list-models` shows the eligible models (stable Flash-Lite text models first, then stable Flash) and which would be chosen; `-- --model <name>` forces one. On an HTTP 400 it tries the next eligible model, at most 3 requests in total.

## Cut list (cut in this order if behind)
1. Stretch: cNFT minting, ear-training, MongoDB
2. Tiger Data
3. ElevenLabs
4. Live Gemini calls (use cached text)
5. Custom Anchor program (fall back to memo + transfers)
NEVER cut: real Solana transactions, Vultr deploy, the map, basic music, Reset storm button.

## Decisions so far
- Name: Volatone. Working solo.
- Map library: undecided.
- SGX data: use if usable, else synthetic. Current storm is synthetic: `backend/src/storm/storm.json` (150 s, from seeded `backend/scripts/make-storm.ts`), locked by `npm test`.
- Agents announce a new action only after it holds 4 scores in a row (Strategist scores every 10 s); at a decision point they state any changed view at once. ~43 decisions, ~22 devnet txs per replay (simulated).
- Gate: custom Solana program must work by 22:30, else fall back.
