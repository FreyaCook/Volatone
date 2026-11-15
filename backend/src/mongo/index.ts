// Wires MongoDB into the backend. Returns null when it is switched off.
import { mongoEnabled, createClient, secretsOf } from "./config";
import { MongoStore, offRuns, type RunsCollection } from "./store";

export function createMongo(env: NodeJS.ProcessEnv, log: (m: string) => void): MongoStore | null {
  if (!mongoEnabled(env)) return null;
  const uri = env.MONGODB_URI!.trim();
  const client = createClient(uri);
  // The client connects lazily on first use; a failed attempt is retried by the driver on the next call.
  const getCollection = async (): Promise<RunsCollection> => client.db("volatone").collection("runs") as unknown as RunsCollection;
  return new MongoStore(getCollection, log, secretsOf(uri));
}

export { offRuns };
export { RunCollector } from "./collector";
