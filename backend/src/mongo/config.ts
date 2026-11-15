import { MongoClient } from "mongodb";

/** MONGODB=on|off. Unset: on only if MONGODB_URI is set. "on" without a URI stays off. */
export function mongoEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.MONGODB?.trim().toLowerCase() === "off") return false;
  return !!env.MONGODB_URI?.trim();
}

/** Short timeouts and a small pool. The URI is used as given and never logged. */
export function createClient(uri: string): MongoClient {
  return new MongoClient(uri, { serverSelectionTimeoutMS: 4000, connectTimeoutMS: 4000, maxPoolSize: 3 });
}

/** Strings that must never appear in a log line: the URI and its password. */
export function secretsOf(uri: string): string[] {
  const out = [uri];
  try { out.push(decodeURIComponent(new URL(uri).password)); } catch { /* not a URL */ }
  return out;
}
