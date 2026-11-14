// Event ids: "evt_0001", "evt_0002", ... Unique across runs: never restarts on reset.

export interface IdSource {
  next(): string;
}

export function createIdSource(start = 1): IdSource {
  let n = start;
  return { next: () => `evt_${String(n++).padStart(4, "0")}` };
}
