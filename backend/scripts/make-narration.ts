// Makes the narration clips ONCE with ElevenLabs text-to-speech and writes
//   frontend/public/narration/<id>.mp3  and  frontend/public/narration/narration.json
// The mp3 files and the manifest are committed, so the demo never calls ElevenLabs.
//
//  - Reads ELEVENLABS_API_KEY from the environment, after loading the file named by ENV_FILE
//    (or the repo .env). The key is only sent in the xi-api-key header: never printed or logged.
//  - Skips clips whose mp3 already exists unless --force is passed.
//  - Voice: a calm premade voice from GET /v1/voices (Daniel, George, Brian, in that order), or --voice <name|id>.
//  - Model: eleven_multilingual_v2 (stable, long-standing default); if the account rejects it
//    (HTTP 400/402/403) it falls back once to eleven_flash_v2_5. --model <id> uses only that model.
//
// Run:      ENV_FILE=/path/to/.env npm run make-narration -w backend
// Options:  --dry-run   print the lines and the character count, call nothing (no key needed)
//           --force     regenerate clips that already exist
//           --voice X   voice name or id        --model X   model id

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../src/chain/sender";

const API = "https://api.elevenlabs.io/v1";
const OUT_DIR = resolve(REPO_ROOT, "frontend/public/narration");
const PREFERRED_VOICES = ["Daniel", "George", "Brian"];
const MODELS = ["eleven_multilingual_v2", "eleven_flash_v2_5"];

export const CLIPS = [
  { id: "intro", text: "Welcome to Volatone. A practice storm for new currency traders. Simulation only, fake money. Hear the storm before it breaks." },
  { id: "start", text: "The replay begins. Four currency corridors, all calm." },
  { id: "spreading", text: "Stress is spreading. Watch the front." },
  { id: "storm", text: "Storm. This corridor has crossed the line." },
  { id: "prompt", text: "Your move. Hedge, hold, or reduce." },
  { id: "good", text: "Good call. Your move is logged on Solana devnet." },
  { id: "poor", text: "Not this time. Every move is a lesson, and it's logged." },
  { id: "easing", text: "The storm is passing." },
  { id: "end", text: "Replay complete. Every decision is recorded on Solana devnet. A simulation, not financial advice." },
] as const;

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    voice: { type: "string" },
    model: { type: "string" },
  },
});

const file = (id: string) => `${id}.mp3`;
const total = CLIPS.reduce((n, c) => n + c.text.length, 0);

async function main() {
  if (values["dry-run"]) {
    for (const c of CLIPS) console.log(`${c.id.padEnd(10)} (${String(c.text.length).padStart(3)} chars)  ${c.text}`);
    console.log(`\n${CLIPS.length} clips, ${total} characters in total. Dry run: nothing was sent.`);
    return;
  }

  const envFile = process.env.ENV_FILE ?? resolve(REPO_ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.error(`ELEVENLABS_API_KEY not found (looked in ${envFile} and the environment). Add it there and run again.`);
    process.exit(1);
  }
  const headers = { "xi-api-key": key };

  const todo = CLIPS.filter((c) => values.force || !existsSync(resolve(OUT_DIR, file(c.id))));
  mkdirSync(OUT_DIR, { recursive: true });

  let used = 0;
  if (todo.length) {
    const voice = await pickVoice(headers);
    console.log(`Voice: ${voice.name}. Generating ${todo.length} clip(s), ${todo.reduce((n, c) => n + c.text.length, 0)} characters.`);
    const models = values.model ? [values.model] : MODELS;
    let m = 0;
    for (const c of todo) {
      for (;;) {
        const res = await fetch(`${API}/text-to-speech/${voice.id}?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text: c.text, model_id: models[m], voice_settings: { stability: 0.6, similarity_boost: 0.75, speed: 0.95 } }),
        });
        if (res.ok) {
          writeFileSync(resolve(OUT_DIR, file(c.id)), Buffer.from(await res.arrayBuffer()));
          used += c.text.length;
          console.log(`  ${c.id}: ok (${models[m]})`);
          break;
        }
        const detail = (await res.text()).slice(0, 200);
        if ([400, 402, 403].includes(res.status) && m < models.length - 1) {
          console.log(`  ${models[m]} rejected (HTTP ${res.status}); trying ${models[m + 1]}`);
          m++;
          continue;
        }
        console.error(`  ${c.id}: failed, HTTP ${res.status}: ${detail}`);
        process.exit(1);
      }
    }
  } else {
    console.log("All clips already exist. Use --force to regenerate.");
  }

  const manifest = CLIPS.filter((c) => existsSync(resolve(OUT_DIR, file(c.id)))).map((c) => ({ id: c.id, text: c.text, file: file(c.id) }));
  writeFileSync(resolve(OUT_DIR, "narration.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote narration.json (${manifest.length} clips). Characters of ElevenLabs credit used this run: ${used}.`);
}

interface Voice { voice_id: string; name: string; category?: string }

async function pickVoice(headers: Record<string, string>) {
  const res = await fetch(`${API}/voices`, { headers });
  if (!res.ok) throw new Error(`Listing voices failed: HTTP ${res.status}`);
  const voices = ((await res.json()) as { voices: Voice[] }).voices;
  const premade = voices.filter((v) => v.category === "premade");
  const wanted = values.voice?.toLowerCase();
  const first = (name: string) => voices.find((v) => v.name.toLowerCase().startsWith(name.toLowerCase()));
  const v =
    (wanted && (voices.find((x) => x.voice_id === values.voice) ?? first(wanted))) ||
    PREFERRED_VOICES.map((n) => premade.find((x) => x.name.toLowerCase().startsWith(n.toLowerCase()))).find(Boolean) ||
    premade[0];
  if (!v) throw new Error("No usable voice found on this account.");
  return { id: v.voice_id, name: v.name.split(" - ")[0] };
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
