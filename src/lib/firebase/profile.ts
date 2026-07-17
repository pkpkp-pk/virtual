// Ticket profile (Phase 2): the fan's bound gate/section/row, stored in
// Firestore `users/{uid}` (owner-write per firestore.rules). Used to personalize
// FCM alerts (subscribe to `gate_{ticketGate}`) and pre-fill route origins.

import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirestoreClient } from "./client";

export interface TicketProfile {
  ticketGate?: string;
  ticketSection?: string;
  ticketRow?: string;
  updatedAt?: number;
}

/** Read a user's ticket profile once. Returns null if unset/unconfigured. */
export async function readProfile(
  uid: string
): Promise<TicketProfile | null> {
  const db = getFirestoreClient();
  if (!db) return null;
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists) return null;
  return snap.data() as TicketProfile;
}

/** Subscribe to a user's ticket profile (live). Returns an unsubscribe fn. */
export function subscribeProfile(
  uid: string,
  cb: (profile: TicketProfile | null) => void
): Unsubscribe {
  const db = getFirestoreClient();
  if (!db) return () => {};
  return onSnapshot(
    doc(db, "users", uid),
    (snap) => cb(snap.exists() ? (snap.data() as TicketProfile) : null),
    (err) => console.warn("[profile] subscribe failed:", err)
  );
}

/** Save (merge) the fan's ticket binding to their own profile doc. */
export async function writeProfile(
  uid: string,
  profile: TicketProfile
): Promise<void> {
  const db = getFirestoreClient();
  if (!db) throw new Error("Firestore not configured");
  await setDoc(
    doc(db, "users", uid),
    { ...profile, updatedAt: Date.now() },
    { merge: true }
  );
}
