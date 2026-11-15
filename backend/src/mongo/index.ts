// Wires MongoDB into the backend. Returns null when it is switched off.
import { mongoEnabled, createClient, secretsOf } from "./config";
import { MongoStore, offRuns, type RunsCollection } from "./store";

export function createMongo(env: NodeJS.ProcessEnv, log: (m: string) => void): MongoStore | null {
  if (!mongoEnabled(env)) return null;
  const uri = env.MONGODB_URI!.trim();
  let client = createClient(uri);
  let ready = false;
  // Connect explicitly, so a failure shows its real cause. After any failure the client is replaced:
  // a driver client whose first connection failed can stay closed ("Topology is closed") for good.
  const getCollection = async (): Promise<RunsCollection> => {
    if (!ready) {
      await client.connect();
      ready = true;
    }
    return client.db("volatone").collection("runs") as unknown as RunsCollection;
  };
  const resetClient = () => {
    const old = client;
    client = createClient(uri);
    ready = false;
    void old.close().catch(() => {});
  };
  return new MongoStore(getCollection, log, secretsOf(uri), 5000, resetClient);
}

export { offRuns };
export { RunCollector } from "./collector";
