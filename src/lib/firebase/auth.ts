// Client-side Firebase Auth helpers (Phase 2: ticket binding).
// Anonymous auth is enough — it gives a stable uid to bind a ticket profile to,
// so alerts can be personalized ("your gate") and the seat remembered across
// sessions without asking the fan to create an account.

import {
  signInAnonymously,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { getAuthClient } from "./client";

/** Subscribe to auth state changes. Returns an unsubscribe fn (no-op if
 *  Firebase isn't configured). */
export function onAuthChange(cb: (user: User | null) => void): () => void {
  const a = getAuthClient();
  if (!a) return () => {};
  return onAuthStateChanged(a, cb);
}

/** Ensure there is a signed-in anonymous user; return the user or null. */
export async function ensureAnonymousUser(): Promise<User | null> {
  const a = getAuthClient();
  if (!a) return null;
  try {
    const res = await signInAnonymously(a);
    return res.user;
  } catch (err) {
    console.warn("[auth] signInAnonymously failed:", err);
    return null;
  }
}
