// The Tiger writer. The replay never waits on it: events are mapped to rows synchronously (cheap, in
// a try/catch) and pushed to a bounded queue; a background timer flushes the queue. If the database
// is slow or down, rows pile up to the cap (the oldest are then dropped and counted), a circuit
// breaker stops trying for a while, and nothing else is affected.
import type pg from "pg";
import type { VolatoneEvent } from "@volatone/shared";
import { BoundedQueue, CircuitBreaker, logOnce, safeError } from "./queue";
import { RowMapper, type MapperDeps, type Row } from "./rows";
import { ensureSchema, type SchemaInfo } from "./schema";

export const QUEUE_MAX = 5000;
export const FLUSH_EVERY_MS = 1000;
const BATCH_ROWS = 1000;

export class TigerWriter {
  readonly queue = new BoundedQueue<Row>(QUEUE_MAX);
  readonly breaker = new CircuitBreaker(3, 30_000);
  readonly mapper: RowMapper;
  schema: SchemaInfo | null = null;
  written = 0;
  private flushing = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly note: (m: string) => void;

  constructor(private readonly pool: pg.Pool, mapper: MapperDeps, log: (m: string) => void, private readonly secrets: string[] = []) {
    this.mapper = new RowMapper(mapper);
    this.note = logOnce(log);
  }

  /** Listener for engine.subscribe. Synchronous, never throws, never awaits. */
  onEvent = (e: VolatoneEvent): void => {
    try {
      for (const row of this.mapper.handle(e)) this.queue.push(row);
    } catch (err) {
      this.note(`tiger: could not map an event (${safeError(err, this.secrets)})`);
    }
  };

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
    await this.pool.end().catch(() => {});
  }

  get runId() { return this.mapper.runId; }

  /** One background flush. Never throws. */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.size === 0 || !this.breaker.canTry(Date.now())) return;
    this.flushing = true;
    const rows = this.queue.take(BATCH_ROWS);
    try {
      if (!this.schema) this.schema = await ensureSchema(this.pool, this.note);
      await insertRows(this.pool, rows);
      this.written += rows.length;
      this.breaker.success();
    } catch (err) {
      this.queue.requeue(rows);
      this.breaker.failure(Date.now());
      this.note(`tiger: write failed (${safeError(err, this.secrets)}); the replay is unaffected`);
    } finally {
      this.flushing = false;
    }
  }

  /** Flush until the queue is empty or a write fails (used before building the report). */
  async drain(maxMs = 4000): Promise<void> {
    const until = Date.now() + maxMs;
    while (this.queue.size > 0 && Date.now() < until && this.breaker.canTry(Date.now())) {
      const before = this.queue.size;
      await this.flush();
      if (this.queue.size >= before) break; // no progress
    }
  }
}

export async function insertRows(pool: pg.Pool, rows: Row[]): Promise<void> {
  const by = <T extends Row["table"]>(t: T) => rows.filter((r): r is Extract<Row, { table: T }> => r.table === t);
  const runs = by("runs"), ticks = by("risk_ticks"), events = by("events"), txs = by("tx_log");
  for (const r of runs) {
    await pool.query(`INSERT INTO runs (run_id, scenario, seed, speed, started_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [r.run_id, r.scenario, r.seed, r.speed, r.started_at]);
  }
  if (ticks.length) {
    await pool.query(`INSERT INTO risk_ticks (ts, run_id, corridor, replay_t, risk, state)
      SELECT * FROM unnest($1::timestamptz[], $2::uuid[], $3::text[], $4::int[], $5::float8[], $6::text[])`,
      [ticks.map((r) => r.ts), ticks.map((r) => r.run_id), ticks.map((r) => r.corridor), ticks.map((r) => r.replay_t), ticks.map((r) => r.risk), ticks.map((r) => r.state)]);
  }
  if (events.length) {
    await pool.query(`INSERT INTO events (ts, run_id, replay_t, kind, actor, corridor, action, detail)
      SELECT ts, run_id, replay_t, kind, actor, corridor, action, detail::jsonb
      FROM unnest($1::timestamptz[], $2::uuid[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
        AS t(ts, run_id, replay_t, kind, actor, corridor, action, detail)`,
      [events.map((r) => r.ts), events.map((r) => r.run_id), events.map((r) => r.replay_t), events.map((r) => r.kind), events.map((r) => r.actor), events.map((r) => r.corridor), events.map((r) => r.action), events.map((r) => r.detail)]);
  }
  if (txs.length) {
    await pool.query(`INSERT INTO tx_log (ts, run_id, replay_t, signature, events, confirm_ms, ok)
      SELECT * FROM unnest($1::timestamptz[], $2::uuid[], $3::int[], $4::text[], $5::int[], $6::int[], $7::boolean[])`,
      [txs.map((r) => r.ts), txs.map((r) => r.run_id), txs.map((r) => r.replay_t), txs.map((r) => r.signature), txs.map((r) => r.events), txs.map((r) => r.confirm_ms), txs.map((r) => r.ok)]);
  }
}
