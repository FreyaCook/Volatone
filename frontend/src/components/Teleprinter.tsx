import { useEffect, useRef } from "react";
import type { State } from "../state";
import { explorerUrl, shortSig, tplus } from "../format";

export function Teleprinter({ state, mock }: { state: State; mock: boolean }) {
  // Newest line is on top: keep the tape scrolled to it when a new line arrives.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [state.txs.length]);
  return (
    <section className="tele" aria-label="Solana devnet log">
      <h2>TELEPRINTER · SOLANA DEVNET LOG</h2>
      {state.txs.length === 0 ? (
        <p className="tele-line">Line open. Nothing logged yet.</p>
      ) : (
        <ul ref={list}>
          {state.txs.map((x) => {
            const n = x.eventIds.length;
            const events = `${n} ${n === 1 ? "EVENT" : "EVENTS"}`;
            if (x.type === "tx_failed") {
              return <li key={x.id} className="tele-line"><span>{tplus(x.t)}</span><span>{events}</span><span>NOT LOGGED. Will not retry in this replay: {x.error}</span></li>;
            }
            return mock ? (
              <li key={x.id} className="tele-line"><span>{tplus(x.t)}</span><span>{events}</span><span>SIMULATED</span></li>
            ) : (
              <li key={x.id} className="tele-line">
                <span>{tplus(x.t)}</span><span>{events}</span><span>{x.confirmMs.toLocaleString("en-US")} MS</span>
                <span title={x.signature}>{shortSig(x.signature)}</span>
                <a href={explorerUrl(x.signature)} target="_blank" rel="noreferrer">Explorer<span className="sr"> (opens in a new tab)</span></a>
              </li>
            );
          })}
        </ul>
      )}
      <p className="note-dark">Each line is one batched devnet transaction of up to 8 logged events. Fake money.{mock ? " Mock mode: nothing here is real." : ""}</p>
    </section>
  );
}
