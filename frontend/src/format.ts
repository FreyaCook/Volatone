export const pad3 = (ms: number) => String(Math.floor(ms / 1000)).padStart(3, "0");
export const tplus = (ms: number) => `T+${pad3(ms)}`;
export const shortSig = (sig: string) => (sig.length > 18 ? `${sig.slice(0, 8)}…${sig.slice(-5)}` : sig);
export const explorerUrl = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const pct = (risk: number) => Math.round(risk * 100);
