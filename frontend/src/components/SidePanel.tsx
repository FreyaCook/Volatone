// Stage 1 placeholder: shows the corridor states and the derived decision points.
// Stage 2 replaces this with the agent panel, prompt, outcomes and transaction feed.
import { CORRIDORS, promptViews, type State } from "../state";
import { STATE_ICON, STATE_LABEL, clock } from "../theme";

export function SidePanel({ state }: { state: State }) {
  return (
    <aside className="side">
      <section>
        <h2>Corridors</h2>
        <ul className="list">
          {CORRIDORS.map((c) => {
            const v = state.corridors[c];
            return (
              <li key={c} className={`st-${v.state}`}>
                <strong>{c}</strong>
                <span className="tag">{STATE_ICON[v.state]} {STATE_LABEL[v.state]}</span>
                <span>{Math.round(v.risk * 100)}%</span>
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h2>Decision points</h2>
        <ul className="list">
          {promptViews(state).map((p) => (
            <li key={p.id}>
              <strong>{p.corridor}</strong>
              <span>at {clock(p.opensT)}</span>
              <span className="tag">{p.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
