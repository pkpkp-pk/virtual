"use client";

import { useState } from "react";
import { NODE_LIST } from "@/lib/graph/stadiumGraph";
import { useI18n } from "@/lib/i18n";
import type { TicketProfile } from "@/lib/firebase/profile";

const GATES = NODE_LIST.filter((n) => n.type === "gate");
const SECTIONS = NODE_LIST.filter((n) => n.type === "section");

export interface TicketBinderProps {
  bound: TicketProfile | null;
  onBind: (p: TicketProfile) => Promise<void>;
}

/** Small form to bind the fan's ticket (gate + section + row) so alerts are
 *  personalized to their gate and routes can pre-fill their origin. */
export default function TicketBinder({ bound, onBind }: TicketBinderProps) {
  const { t } = useI18n();
  const [gate, setGate] = useState(bound?.ticketGate ?? "");
  const [section, setSection] = useState(bound?.ticketSection ?? "");
  const [row, setRow] = useState(bound?.ticketRow ?? "");
  const [saving, setSaving] = useState(false);

  const saved = bound?.ticketGate || bound?.ticketSection;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!gate && !section) return;
    setSaving(true);
    try {
      await onBind({ ticketGate: gate || undefined, ticketSection: section || undefined, ticketRow: row || undefined });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 text-sm">
      <div className="text-xs text-slate-400">
        {saved
          ? `Bound to ${bound?.ticketGate ?? ""}${bound?.ticketSection ? " · " + bound?.ticketSection : ""}${bound?.ticketRow ? " Row " + bound?.ticketRow : ""} — update anytime.`
          : t("ticket.hint")}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          value={gate}
          onChange={(e) => setGate(e.target.value)}
          className="rounded-lg bg-slate-900 px-2 py-1.5 text-xs text-slate-100 ring-1 ring-slate-700 outline-none focus:ring-teal-400"
        >
          <option value="">{t("ticket.gate")}</option>
          {GATES.map((g) => (
            <option key={g.id} value={g.id}>{g.label}</option>
          ))}
        </select>
        <select
          value={section}
          onChange={(e) => setSection(e.target.value)}
          className="rounded-lg bg-slate-900 px-2 py-1.5 text-xs text-slate-100 ring-1 ring-slate-700 outline-none focus:ring-teal-400"
        >
          <option value="">{t("ticket.section")}</option>
          {SECTIONS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>
      <input
        value={row}
        onChange={(e) => setRow(e.target.value)}
        placeholder={t("ticket.row")}
        className="w-full rounded-lg bg-slate-900 px-3 py-1.5 text-xs text-slate-100 ring-1 ring-slate-700 outline-none focus:ring-teal-400"
      />
      <button
        type="submit"
        disabled={saving || (!gate && !section)}
        className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-900 disabled:opacity-40"
      >
        {saving ? t("ticket.saving") : t("ticket.bind")}
      </button>
    </form>
  );
}

