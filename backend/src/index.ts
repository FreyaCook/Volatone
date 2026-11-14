import { WebSocketServer } from "ws";
import type { VolatoneEvent } from "@volatone/shared";

const port = Number(process.env.PORT ?? 8080);
const wss = new WebSocketServer({ port });

export function broadcast(event: VolatoneEvent): void {
  const data = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

wss.on("listening", () => console.log(`Volatone WebSocket feed on ws://localhost:${port}`));
