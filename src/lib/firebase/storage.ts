// Cloud Storage helper (Phase 5): accessibility entrance photos.
// Each gate/section may have a photo at `accessibility/{nodeId}.jpg` (uploaded
// manually) showing the accessible entrance — ramp/elevator location — so the
// navigator can surface "here's the accessible entrance" visually, beyond a
// boolean flag. Tolerates missing photos (returns null).

import { getDownloadURL, ref } from "firebase/storage";
import { getStorageClient } from "./client";

/** Resolve the accessibility photo URL for a node, or null if unavailable. */
export async function accessPhotoUrl(nodeId: string): Promise<string | null> {
  const storage = getStorageClient();
  if (!storage) return null;
  try {
    return await getDownloadURL(ref(storage, `accessibility/${nodeId}.jpg`));
  } catch {
    return null;
  }
}
