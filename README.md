# Volatone

**Hear the storm before it breaks.**

## 1. What Volatone is

Volatone is a practice simulation for new currency traders: a flight simulator for market storms.

It replays one hard-coded, synthetic storm, "Tokyo surprise" (generator seed 20261114), on a weather-chart style map. A surprise policy signal from Tokyo moves the yen, and the stress spreads across four currency corridors: USD-JPY, EUR-JPY, EUR-USD and GBP-USD. Each corridor goes from calm, to spreading, to storm, and back.

Three agents score the risk as the storm builds: Sentinel, Opportunist and Strategist. They are plain code and each has its own rules. At four decision points the player has eight replay seconds to choose **hedge**, **hold** or **reduce** for one corridor. Fifteen replay seconds later, the player is shown how the move turned out, judged by fixed rules against the storm data, with a short reason.

The money is fake, the storm is synthetic, and the replay is identical every time. This is not live market data, not a prediction and not financial advice. Volatone is designed to help people get a feel for how a crisis unfolds; nobody has shown that it improves real trading.

The replay is built from a data file (`backend/src/storm/storm.json`) so that more scenarios can be added. There is one scenario today.

## 2. Live demo

http://78.141.224.216/

It is hosted on Vultr. This server will be taken down after the hackathon judging. Open it over plain http, not https.

Press START. Keys 1, 2 and 3 answer a decision prompt (hedge, hold, reduce) while one is open. The first click also starts the sound; there is a mute button at the top right. Tape speed has three settings: Normal, Fast (2x) and Rush (3x). In Rush only, if you have not answered 2.5 real seconds after a prompt opens, an on-screen "autopilot" plays Sentinel's latest view for you and says so.

## 3. How it uses Solana (devnet only)

Everything on Solana happens on **devnet**, with fake money (devnet SOL).

- Program: an Anchor program called `volatone_log`, program id [`2jHECa8gr3VFYTuBvRxmB4BtX3DasybJFKixp5348HeN`](https://explorer.solana.com/address/2jHECa8gr3VFYTuBvRxmB4BtX3DasybJFKixp5348HeN?cluster=devnet).
- What is logged: every agent decision, every player move and every player outcome is logged as an event. Nothing else is, and a prompt the player misses logs nothing. The on-chain records are compact (they do not contain the explanation text).
- Batching: events are batched, up to 8 per devnet transaction. A player move is sent straight away, together with anything already waiting. Everything else waits for the next batch, which is sent once the oldest waiting event has waited 3 seconds.
- Fallback: if the program transaction fails, the same batch is logged through the Solana Memo program instead. Setting `LOG_VIA=memo` forces the memo path.
- On screen: the "teleprinter" shows each batch as it is confirmed, with the number of events, the confirmation time, a shortened signature and a link to Solana Explorer (devnet cluster). A failed batch is shown as "NOT LOGGED".
- Measured on the Vultr-hosted server: 20 transactions confirmed, between 796 and 1,390 ms, mean about 1,066 ms. In short, confirmation typically takes about a second. The time is measured by the backend from sending the transaction to the "confirmed" commitment, by polling every 150 ms, so a reading can be up to about 150 ms high. These are our own measurements, not a benchmark of Solana.
- The player's moves are called "logged moves". Volatone does not swap or trade anything.

The transactions are sent by the backend, not by the browser. The browser never holds a key.

## 4. How it uses Vultr

The backend is a Node and TypeScript WebSocket server. It runs the replay, the agents and the Solana sender. It runs on a Vultr cloud compute instance in London (vc2-1c-2gb, Ubuntu 24.04), managed by systemd. nginx on the same instance serves the built frontend.

The devnet transactions are sent from that server, not from the browser.

## 5. Where AI is used

- **Agents: no AI.** Sentinel, Opportunist and Strategist are plain code. Their decisions and risk scores are computed by fixed rules.
- **Explanations: Gemini, pre-generated.** Gemini only wrote the short sentence shown under each agent decision. It was run once, the text was validated and cached in `backend/src/agents/explanations.json`, and the server reads the cache. Nothing is generated live. Any decision without a valid cached sentence uses a plain fallback sentence.
- **Narration: ElevenLabs, pre-generated.** The spoken lines were generated once with ElevenLabs text-to-speech and saved as mp3 files in `frontend/public/narration/`. They are not a live AI voice. Each spoken line is also shown as an on-screen caption.
- **Music: generated live in the browser, no AI.** The music is made by the Web Audio API from the replay's risk scores: a slow chord pad, plus a low pulse, a closing filter and one dissonant note that grow as the highest corridor risk rises, and one deep hit the first time a corridor reaches storm. It uses no samples, no audio files and no AI music.

## 6. Architecture

```
storm.json (seeded, synthetic)
      |
      v
replay engine ---> agents (Sentinel, Opportunist, Strategist)
      |                 |  cached explanation text
      |                 v
      +-------> WebSocket feed (VolatoneEvent JSON) -----> frontend (React)
      |                                                       |
      |                                    player_move / start / reset
      |                                                       |
      |  <----------------------------------------------------+
      |
      +-> batcher -> sender -> Solana devnet (volatone_log, memo fallback)
                         |
                         +-> tx_confirmed / tx_failed back into the feed
```

The frontend rebuilds everything on screen from the event stream, with one pure reducer. The prompts are not sent by the server: the browser works out when one is open from the tick times.

| Folder | What is in it |
| --- | --- |
| `backend/` | Node and TypeScript server: replay engine, agents, Solana batcher and sender, WebSocket feed, and the one-off scripts (storm generator, explanations, narration). |
| `frontend/` | Vite, React and TypeScript app: the weather chart, dispatches, teleprinter, mixing desk, narration player and Web Audio music. Includes a mock mode. |
| `shared/` | The event types (`events.ts`) and the WebSocket protocol (`protocol.ts`), shared by backend and frontend. |
| `programs-anchor/` | The `volatone_log` Anchor program (Rust). |

`CONTEXT.md` has the detailed WebSocket protocol.

## 7. Run it locally

You need Node 22. For real devnet logging you also need a Solana devnet wallet with some devnet SOL.

```
npm install
cp .env.example .env
```

Variables in `.env` (never commit it):

| Variable | When you need it |
| --- | --- |
| `SOLANA_RPC_URL` | Optional. The devnet RPC endpoint to use; the default is `https://api.devnet.solana.com`. |
| `LOG_VIA` | Optional. Set to `memo` to skip the program and log through the Memo program only. |
| `GEMINI_API_KEY` | Only to regenerate the cached explanations. |
| `ELEVENLABS_API_KEY` | Only to regenerate the narration clips. |
| `PORT` | Optional. The backend's WebSocket port; the default is 8080. |

For real devnet logging the backend signs with a keypair file at `.keys/volatone-wallet.json` (git-ignored), or at the path in `WALLET_PATH`. `create-wallet.sh` makes one with the Solana CLI. Fund the wallet with devnet SOL from a faucet. Never share or commit the keypair.

Run the backend (terminal 1):

```
npm run dev -w backend                # with real devnet logging
CHAIN=off npm run dev -w backend      # no Solana sending, no keys needed
```

`TICK_MS=250` in front of either command makes the replay run faster (milliseconds per replay second; the default is 1000).

Run the frontend (terminal 2), then open http://localhost:5173/:

```
npm run dev -w frontend
```

The frontend connects to `ws://localhost:8080`. To point it elsewhere, set `VITE_WS_URL` (for example `VITE_WS_URL=ws://host:8080 npm run build -w frontend`).

**Mock mode:** open http://localhost:5173/?mock=1. The page plays a fake event stream locally with the same event types, so it needs no backend and no keys. Transaction lines are marked "SIMULATED", with no confirmation times or Explorer links. Add `&tick=250` to speed it up.

Tests and type checks:

```
npm test                  # backend tests
npm test -w frontend      # frontend tests
npm run typecheck         # all workspaces
```

One-off scripts (each has a `--dry-run` that calls nothing):

```
npm run make-explanations -w backend
npm run make-narration -w backend
```

## 8. Honest limits

- It is a simulation. Everything is on Solana devnet, with fake money.
- There is one scenario, one fixed synthetic storm. It is not live market data and not a forecast.
- A person chooses moves inside a fixed replay. The storm does not react to what the player does.
- The agents are simple, hand-written rules. They are not trading advice.
- The outcome of a move is judged by fixed rules against the storm data, over a short look-ahead.
- Not financial advice. Nothing here claims to improve real trading.
- Transaction timings are our own measurements from one server on one day.

## 9. Credits

Built solo by Freya at DurHack 2026. Built with Claude Code.
