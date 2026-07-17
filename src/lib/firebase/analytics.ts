// Analytics helper (Phase 6): log fan-behavior events to Firebase Analytics so
// organizers can see which gates/sections get the most requests, when egress
// routing peaks, etc. Best-effort — failures are swallowed (analytics must never
// break the UX). No-op when Firebase isn't configured.

import { logEvent } from "firebase/analytics";
import { getAnalyticsClient } from "./client";

export async function logAnalytics(
  name: string,
  params?: Record<string, unknown>
): Promise<void> {
  const a = await getAnalyticsClient();
  if (!a) return;
  try {
    logEvent(a, name as never, params as never);
  } catch {
    /* ignore */
  }
}
