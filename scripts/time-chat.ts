// Timing harness for /api/chat latency. Calls runChatStream directly (no HTTP
// layer) and logs: time-to-route (deterministic result available), time-to-
// first-token (LLM prose starts), total time, and any failure. Single model
// (gemini-3.1-flash-lite). Run: npx tsx --env-file=.env.local scripts/time-chat.ts "q"
import { runChatStream } from "../src/lib/gemini/client";

async function main() {
  const query = process.argv[2] ?? "What is the fastest way to my seat in section 126 from the entrance?";
  const t0 = Date.now();
  let firstTokenAt: number | null = null;
  let routeAt: number | null = null;
  let chars = 0;
  console.log(`[t=${((Date.now() - t0) / 1000).toFixed(2)}s] query: "${query}"`);
  const out = await runChatStream(
    query,
    undefined,
    (delta) => {
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        console.log(`[t=${((firstTokenAt - t0) / 1000).toFixed(2)}s] FIRST TOKEN`);
      }
      chars += delta.length;
    },
    (r) => {
      routeAt = Date.now();
      console.log(
        `[t=${((routeAt - t0) / 1000).toFixed(2)}s] ROUTE READY: winner=${r.winner?.gateCapacities?.[0]?.id ?? "none"}`
      );
    }
  );
  const tEnd = Date.now();
  console.log(`---`);
  console.log(`total: ${((tEnd - t0) / 1000).toFixed(2)}s`);
  console.log(`time-to-route: ${routeAt ? ((routeAt - t0) / 1000).toFixed(2) : "—"}s`);
  console.log(`time-to-first-token: ${firstTokenAt ? ((firstTokenAt - t0) / 1000).toFixed(2) : "—"}s`);
  console.log(`chars streamed: ${chars}`);
  console.log(`degraded: ${out.degraded ?? false}`);
  console.log(`occupancySource: ${out.occupancySource}`);
  console.log(`route winner: ${out.routeResult?.winner?.gateCapacities?.[0]?.id ?? "none"}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
