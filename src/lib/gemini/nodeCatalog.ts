// Node catalog + resolver: gives the model a fixed list of routable locations
// (id, label, type, accessibility) and resolves the ids it returns back to
// graph nodes. The model does the language understanding (multilingual / garbled
// input -> node id); this module just validates and normalizes.

import { NODE_MAP, nodeLabel } from "../graph/stadiumGraph";

export interface CatalogEntry {
  id: string;
  label: string;
  type: string;
  accessible: boolean;
}

export const NODE_CATALOG: CatalogEntry[] = Object.values(NODE_MAP).map((n) => ({
  id: n.id,
  label: n.label,
  type: n.type,
  accessible: n.accessible,
}));

/** Compact catalog text for the system prompt. */
export function catalogText(): string {
  return NODE_CATALOG.map(
    (e) => `- ${e.id} — ${e.label} (${e.type}${e.accessible ? "" : ", NOT accessible"})`
  ).join("\n");
}

/** Resolve a model-supplied id/label to a real node id. Returns null if no match. */
export function resolveNode(raw: string): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (NODE_MAP[raw]) return raw;
  // exact id match (case-insensitive)
  const byId = Object.keys(NODE_MAP).find((id) => id.toLowerCase() === v);
  if (byId) return byId;
  // label substring match (handles "section 126", "gate c", "restrooms n")
  const byLabel = Object.values(NODE_MAP).find((n) =>
    n.label.toLowerCase().includes(v)
  );
  if (byLabel) return byLabel.id;
  // bare token like "126" -> match label containing it
  const byToken = Object.values(NODE_MAP).find((n) =>
    n.label.toLowerCase().includes(` ${v}`) || n.label.toLowerCase().endsWith(v)
  );
  return byToken?.id ?? null;
}

export { nodeLabel };
