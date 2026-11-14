import { useState } from "react";
import type { Speed } from "./clientMessage";
import { useFeed, MOCK } from "./useFeed";
import { TopBar } from "./components/TopBar";
import { WorldMap } from "./components/WorldMap";
import { SidePanel } from "./components/SidePanel";
import { Footer } from "./components/Footer";

export default function App() {
  const { state, conn, send } = useFeed();
  const [speed, setSpeed] = useState<Speed>(1);

  return (
    <div className="app">
      <TopBar
        status={state.status} t={state.t} conn={conn} mock={MOCK} speed={speed} onSpeed={setSpeed}
        onStart={() => send({ type: "start", speed })}
        onReset={() => send({ type: "reset", speed })}
      />
      <main className="main">
        <div className="mapwrap"><WorldMap state={state} /></div>
        <SidePanel state={state} />
      </main>
      <Footer />
    </div>
  );
}
