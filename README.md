# Volatone

*Hear the storm before it breaks.*

Volatone is a practice game for people who are new to currency trading. Most beginners meet market stress for the first time with real money on the line. Here they practise first, with fake money. A storm called "Tokyo surprise" replays across four currency pairs (USD-JPY, EUR-JPY, EUR-USD and GBP-USD). At four decision points, the player chooses to **hedge**, **hold** or **reduce** their exposure.

It was built solo for DurHack 2026, whose theme was Composition. The storm composes the music live as risk builds, so a beginner can hear a storm coming as well as see it.

**Demo video and write-up:** [Devpost](https://devpost.com/software/volatone)

## What it does

- **Replays a storm** on a blue weather-chart map, at three speeds: Normal (about 150 s), Fast (2x) and Rush (3x, with a labelled autopilot).
- **Gives early warnings.** Three code-based agents (Sentinel, Opportunist and Strategist) say what they would do, each with a plain-English reason and a spoken narration.
- **Lets the player decide.** At each decision point the player chooses to hedge, hold or reduce.
- **Plays the storm as music.** The soundtrack changes as risk builds across the four pairs, and a mixing desk has a fader for each pair.
- **Logs every move.** Each agent view, move and outcome is written to Solana devnet, and the after-action report shows how many records were saved.
- **Scores good calls** with play tokens (VPLAY). They are a public score marker with no value.
- **Reports afterwards.** The after-action report shows peak risk per corridor and how each move turned out.
- **Remembers past runs,** so the last few attempts can be compared side by side.

## How it's built

- **Solana (devnet):** a custom Anchor program, `volatone_log`, records events in batches of up to 8 per transaction. Confirmation typically takes about a second (0.8 to 1.4 s in testing).
- **Front end:** React, Vite and TypeScript, connected to the server by WebSocket.
- **Back end:** Node and TypeScript, which holds the replay clock and the agents and makes every connection to Solana and the databases.
- **Music:** generated live in the browser with Web Audio, with no samples and no AI music.
- **Gemini:** wrote the plain-English explanations ahead of time, and they were checked and cached. The code makes the decisions, and nothing calls Gemini live.
- **ElevenLabs:** the narration was pre-generated.
- **Tiger Data:** stores each run's risk ticks, events and transaction log, and feeds the after-action report.
- **MongoDB Atlas:** stores a short summary of each completed run.
- **Vultr:** hosted the back end during DurHack.
- **Entire:** recorded the AI-assisted build sessions as local checkpoints.
- **Tests:** 136 back-end and 63 front-end tests.

## Good to know

- It is a simulation with fake money, on Solana devnet, which is a test network.
- Devnet records are not permanent, and the play tokens have no value.
- It is designed to help beginners practise, not proven to, and it is not financial advice.
- It hasn't been tested with real beginners yet.

## Project status

- **Archived after DurHack 2026** (15 November 2026).
- **The hosted demo is switched off.** The server has been shut down and the public link no longer works.
- **All API keys and database access used during the event have been deleted.**
- **No secrets are in this repo.** `.env.example` has empty values.
- **To run it yourself,** copy `.env.example` to `.env` and add your own keys.
