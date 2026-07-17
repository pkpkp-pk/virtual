// CLI entrypoint for the simulation tick: `npm run sim:tick`.
// Computes jitter(now) and runs the alert-detection cycle (events + FCM).

import { tickOnce } from "./tick";

async function main() {
  const res = await tickOnce();
  console.log(
    `[sim/tick] t=${res.t.toFixed(0)}s phase=${res.phase} closedGates=[${res.closedGates.join(",")}]`
  );
  console.log(
    `[sim/tick] events=${res.events.length}`,
    res.events.map((e) => e.message).join(" | ") || "(none)"
  );
  console.log(
    "[sim/tick] hotspots:",
    res.hotspots.map((h) => `${h.label} ${Math.round(h.capacityPct * 100)}%`).join(" | ")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

