# Volatone - shared context

Read this first in every Claude session. If something here changes, update it.

## What it is
Tagline: "Hear the storm before it breaks."
A replay of a hard-coded market storm. A world map shows currency corridors going calm -> spreading -> storm. Three independent agents (Sentinel, Opportunist, Strategist) score risk in plain code. Gemini only turns their results into plain-English explanations. The player can hedge, hold or reduce. Music is generated in the browser (Web Audio API) and gets tenser as risk rises.

## Hard rules (keep every claim true)
- Solana DEVNET only, fake money only (devnet SOL + custom demo SPL tokens: demo GBP, EUR, USD, JPY).
- Every agent decision and player move is a real devnet transaction (small custom Anchor program, worker on Vultr). Batched. Meaningful events only, no padding.
- Say "confirmed in about a second", not "sub-second finality". Say "transfers/logged moves", not "swaps".
- Report only our own measured numbers (tx count, latency).
- Not financial advice. A simulation. Pitch as "designed to help", not proven.

## Stack
- Backend: TypeScript/Node on Vultr (agents + transaction worker + WebSocket feed)
- Frontend: React + map (deck.gl or react-globe.gl - undecided)
- Chain: Solana devnet, Anchor program, free-tier RPC provider (NOT our own node)
- Music: Web Audio API. Narration: ElevenLabs (pre-generated). Explanations: Gemini (cached, with fallback text)
- Data: Tiger Data for time-series ticks (cut-list item)

## Event format (DRAFT - to be finalised with Opus before coding)
All parts of the system talk through one event shape:
```json
{
  "id": "evt_0001",
  "t": 0,
  "type": "tick | agent_decision | player_move | escalation",
  "corridor": "GBP-USD",
  "risk": 0.0,
  "state": "calm | spreading | storm",
  "agent": "sentinel | opportunist | strategist | player",
  "action": "none | hedge | hold | reduce",
  "explanation": "plain-English text",
  "txSignature": null
}
```

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
- SGX data: use if usable, else synthetic.
- Gate: custom Solana program must work by 22:30, else fall back.
