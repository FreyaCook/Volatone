// The batching rule: which logged moves go into which devnet transaction, and when.
//
//  - Logged on-chain: agent_decision, player_move, player_outcome. Nothing else (no padding).
//  - A player_move is sent straight away, taking everything already waiting with it.
//  - Otherwise a batch is sent once the oldest waiting event has waited FLUSH_AFTER_MS.
//    (player_outcome has no shortcut: it rides in the next batch.)
//  - At most MAX_PER_TX events per transaction; bigger batches are split, in order.
//  - On Reset storm, whatever is waiting is still sent (flushAll), so every announced
//    decision really is logged. Its tx_confirmed may arrive after the reset.
//
// This file is pure (no timers, no network): the caller passes the time in and sends
// the batches it gets back. sendBatch() below does the sending and reporting.

import type {
  AgentDecisionEvent,
  PlayerMoveEvent,
  PlayerOutcomeEvent,
  TxConfirmedEvent,
  TxFailedEvent,
} from "@volatone/shared";
import type { IdSource } from "../ids";

export type LoggableEvent = AgentDecisionEvent | PlayerMoveEvent | PlayerOutcomeEvent;
export type Batch = LoggableEvent[];

export const FLUSH_AFTER_MS = 3000;
/** Keeps each transaction well under Solana's 1232-byte limit (compact records, no text). */
export const MAX_PER_TX = 8;

export class Batcher {
  private pending: { event: LoggableEvent; queuedAt: number }[] = [];

  /** Queue an event. Returns batches to send now (non-empty only for a player_move). */
  push(event: LoggableEvent, nowMs: number): Batch[] {
    this.pending.push({ event, queuedAt: nowMs });
    return event.type === "player_move" ? this.flushAll() : [];
  }

  /** Call regularly (e.g. every 250 ms). Returns batches whose wait is over. */
  due(nowMs: number): Batch[] {
    if (this.pending.length === 0) return [];
    if (nowMs - this.pending[0].queuedAt < FLUSH_AFTER_MS) return [];
    return this.flushAll();
  }

  /** Send everything waiting (used for player moves and on Reset storm). */
  flushAll(): Batch[] {
    const events = this.pending.map((p) => p.event);
    this.pending = [];
    const batches: Batch[] = [];
    for (let i = 0; i < events.length; i += MAX_PER_TX) batches.push(events.slice(i, i + MAX_PER_TX));
    return batches;
  }

  get waiting(): number {
    return this.pending.length;
  }
}

/** Sends one batch as one devnet transaction. Resolves with its signature once "confirmed". */
export type SendTx = (batch: Batch) => Promise<{ signature: string }>;

/**
 * Sends a batch and reports the result as a tx_confirmed or tx_failed event.
 * confirmMs is our own measurement: time from send to "confirmed" commitment.
 * `t` is the replay time when the result arrived (from the caller's replay clock).
 */
export async function sendBatch(
  batch: Batch,
  send: SendTx,
  ids: IdSource,
  clock: { nowMs(): number; replayT(): number },
): Promise<TxConfirmedEvent | TxFailedEvent> {
  const eventIds = batch.map((e) => e.id);
  const started = clock.nowMs();
  try {
    const { signature } = await send(batch);
    return {
      id: ids.next(),
      t: clock.replayT(),
      type: "tx_confirmed",
      signature,
      eventIds,
      confirmMs: Math.round(clock.nowMs() - started),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: ids.next(),
      t: clock.replayT(),
      type: "tx_failed",
      eventIds,
      error: message.slice(0, 200),
    };
  }
}
