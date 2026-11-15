// Checks the MongoDB connection end to end and cleans up after itself.
//   - connects, inserts one test document into a collection named runs_check (database "volatone"),
//     reads it back, prints timings, then deletes that one document. It drops nothing.
//   - Prints no URI, host or password: only timings and plain-words results.
//
// Run:  ENV_FILE=/path/to/.env npm run mongo-check -w backend

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { REPO_ROOT } from "../src/chain/sender";
import { createClient, secretsOf } from "../src/mongo/config";
import { safeError } from "../src/tiger/queue";

const envFile = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error("MONGODB_URI not found (looked in the environment and " + (existsSync(envFile) ? "the env file" : "no env file") + ").");
  process.exit(1);
}

const ms = (t0: number) => `${Math.round(performance.now() - t0)} ms`;
const client = createClient(uri);
const id = randomUUID();
let exit = 0;

/** Plain-words explanation for the common failures. */
function explain(e: unknown): string {
  const err = e as { code?: number | string; codeName?: string; name?: string; message?: string };
  const msg = String(err?.message ?? "");
  if (err?.code === 18 || err?.codeName === "AuthenticationFailed" || /auth/i.test(msg)) {
    return "Authentication failed: the username or password in MONGODB_URI is wrong, or that user has no access to this cluster.";
  }
  if (err?.name === "MongoServerSelectionError") {
    return "Could not reach the cluster within 4 seconds. Check the Atlas network access list (this machine's IP must be allowed) and that the cluster is not paused.";
  }
  if (/ENOTFOUND|querySrv/i.test(msg)) return "The cluster address in MONGODB_URI could not be looked up (DNS).";
  return safeError(e, secretsOf(uri!));
}

try {
  const col = client.db("volatone").collection("runs_check");

  let t = performance.now();
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  console.log(`connect + ping: ${ms(t)}`);

  t = performance.now();
  await col.insertOne({ _id: id as never, note: "mongo-check", at: new Date() });
  console.log(`inserted 1 document into volatone.runs_check: ${ms(t)}`);

  t = performance.now();
  const back = await col.findOne({ _id: id as never });
  console.log(`read it back: ${back ? "found" : "NOT FOUND"}, ${ms(t)}`);
  if (!back) exit = 1;

  t = performance.now();
  const del = await col.deleteOne({ _id: id as never });
  console.log(`deleted it: ${del.deletedCount} document(s), ${ms(t)}. Nothing else was touched or dropped.`);
} catch (e) {
  console.error("mongo-check failed: " + explain(e));
  exit = 1;
} finally {
  await client.close().catch(() => {});
}
process.exit(exit);
