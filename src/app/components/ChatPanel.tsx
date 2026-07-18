"use client";

import { useI18n } from "@/lib/i18n";
import type { Chat } from "@/app/hooks/useChat";
import Markdown from "./Markdown";

export interface ChatPanelProps {
  chat: Chat;
}

/** Presentational chat panel — state lives in the page (useChat) so external
 *  triggers (map "route here", alert clicks) can call chat.send(). Reads the
 *  live-streamed assistant text from chat.messages. */
export default function ChatPanel({ chat }: ChatPanelProps) {
  const { t, examples } = useI18n();
  const { messages, input, setInput, accessible, setAccessible, loading, send } = chat;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(input);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Live region: new messages are announced to SR users as they appear.
          aria-relevant="additions" (NOT "text") — including "text" would
          re-announce every partial mutation of the streaming assistant message,
          speaking overlapping fragments on each token. "additions" announces a
          message once when it's added, not on every text update. */}
      <div
        className="flex-1 space-y-3 overflow-y-auto pr-1"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">{t("chat.intro")}</p>
            <div className="flex flex-wrap gap-2">
              {examples.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-teal-400/60 hover:text-teal-300"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => {
          const isUser = m.role === "user";
          return (
            <div key={m.id} className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
              <div
                className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                  isUser
                    ? "bg-teal-400/90 text-slate-900"
                    : m.error
                    ? "bg-rose-500/80 text-white"
                    : "text-slate-900"
                }`}
                style={!isUser && !m.error ? { background: "var(--brand)" } : undefined}
                aria-hidden
              >
                {isUser ? "You" : m.error ? "!" : "✦"}
              </div>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
                  isUser
                    ? "whitespace-pre-wrap rounded-tr-sm bg-teal-500/15 text-teal-50 ring-1 ring-teal-400/25"
                    : m.error
                    ? "whitespace-pre-wrap rounded-tl-sm bg-rose-950/40 text-rose-200 ring-1 ring-rose-500/30"
                    : "rounded-tl-sm bg-slate-800/60 text-slate-100 ring-1 ring-white/5"
                }`}
              >
                {m.role === "assistant" && !m.error ? <Markdown text={m.text} /> : m.text}
                {m.degraded && (
                  <div className="mt-2 border-t border-amber-700/40 pt-2 text-xs text-amber-300">
                    Live explanation unavailable (LLM error/timeout). Showing the structured route
                    from the deterministic engine — see the “Why this route?” panel for the numbers.
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {loading && messages[messages.length - 1]?.text === "" && (
          // No nested role="status"/aria-live here: this indicator is a new
          // child of the role="log" aria-relevant="additions" container above,
          // which announces the added subtree (incl. the sr-only "Thinking…")
          // once. A nested live region would double-announce it.
          <div className="flex gap-2.5">
            <div
              className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold text-slate-900"
              style={{ background: "var(--brand)" }}
              aria-hidden
            >
              ✦
            </div>
            <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-slate-800/60 px-4 py-3 ring-1 ring-white/5">
              <span className="typing-dot" style={{ animationDelay: "0ms" }} aria-hidden />
              <span className="typing-dot" style={{ animationDelay: "150ms" }} aria-hidden />
              <span className="typing-dot" style={{ animationDelay: "300ms" }} aria-hidden />
              <span className="sr-only">{t("chat.thinking")}</span>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={accessible}
            onChange={(e) => setAccessible(e.target.checked)}
            className="h-3.5 w-3.5 accent-teal-400"
          />
          {t("accessible.label")}
        </label>
        <form onSubmit={submit} className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.composerLabel")}
            className="flex-1 rounded-xl bg-slate-900/80 px-3.5 py-2.5 text-sm text-slate-100 outline-none ring-1 ring-white/10 transition-shadow placeholder:text-slate-500 focus:ring-2 focus:ring-teal-400/60"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="btn-primary px-4 py-2.5 text-sm"
          >
            {t("chat.send")}
          </button>
        </form>
      </div>
    </div>
  );
}
