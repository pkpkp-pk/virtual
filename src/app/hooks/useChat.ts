"use client";

import { useCallback, useRef, useState } from "react";
import type { PathfinderResult } from "@/lib/types";

// Page-owned chat state + a streaming send, so the chat panel AND external
// triggers (map "route here", alert clicks) can all call send(). Reads the
// NDJSON stream from /api/chat and updates the assistant message live.

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  routeResult?: PathfinderResult | null;
  error?: boolean;
  degraded?: boolean;
}

interface StreamEvent {
  type: "text" | "route" | "done" | "error";
  delta?: string;
  routeResult?: PathfinderResult | null;
  degraded?: boolean;
  error?: string;
}

const ORIGIN_KEYWORDS = /\b(from|at|estoy|desde|de|my seat|i'm|im)\b/i;

export interface UseChatOptions {
  onRouteResult: (r: PathfinderResult | null) => void;
  boundOrigin?: string;
}

export function useChat({ onRouteResult, boundOrigin }: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [accessible, setAccessible] = useState(false);
  const [loading, setLoading] = useState(false);
  const nextId = useRef(1);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const send = useCallback(
    async (text: string) => {
      const raw = text.trim();
      if (!raw || loading) return;
      // Pre-fill origin from the bound ticket when the fan didn't name one.
      const query =
        boundOrigin && !ORIGIN_KEYWORDS.test(raw) ? `From ${boundOrigin}, ${raw}` : raw;
      const userId = nextId.current++;
      const assistantId = nextId.current++;
      setMessages((m) => [
        ...m,
        { id: userId, role: "user", text: raw },
        { id: assistantId, role: "assistant", text: "" },
      ]);
      setInput("");
      setLoading(true);
      const history = messagesRef.current
        .filter((m) => !m.error && m.text.trim())
        .slice(-6)
        .map((m) => ({ role: m.role, text: m.text }));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, accessible, history }),
        });
        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          setMessages((m) =>
            m.map((x) =>
              x.id === assistantId
                ? { ...x, text: `Error: ${errText || res.statusText}`, error: true }
                : x
            )
          );
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let routeResult: PathfinderResult | null = null;
        let degraded = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let evt: StreamEvent;
            try {
              evt = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }
            if (evt.type === "text" && evt.delta) {
              setMessages((m) =>
                m.map((x) =>
                  x.id === assistantId ? { ...x, text: x.text + evt.delta } : x
                )
              );
            } else if (evt.type === "route" && evt.routeResult) {
              // The deterministic route arrives ~15s before the LLM prose — apply
              // it immediately so the map + "Why this route?" panel render the
              // real answer while the explanation streams in.
              routeResult = evt.routeResult;
              setMessages((m) =>
                m.map((x) => (x.id === assistantId ? { ...x, routeResult } : x))
              );
              onRouteResult(routeResult);
            } else if (evt.type === "done") {
              routeResult = evt.routeResult ?? null;
              degraded = evt.degraded === true;
            } else if (evt.type === "error") {
              setMessages((m) =>
                m.map((x) =>
                  x.id === assistantId
                    ? { ...x, text: `Error: ${evt.error}`, error: true }
                    : x
                )
              );
            }
          }
        }
        setMessages((m) =>
          m.map((x) => (x.id === assistantId ? { ...x, routeResult, degraded } : x))
        );
        onRouteResult(routeResult);
      } catch (e) {
        setMessages((m) =>
          m.map((x) =>
            x.id === assistantId
              ? {
                  ...x,
                  text: `Network error: ${e instanceof Error ? e.message : String(e)}`,
                  error: true,
                }
              : x
          )
        );
      } finally {
        setLoading(false);
      }
    },
    [loading, accessible, boundOrigin, onRouteResult]
  );

  return { messages, input, setInput, accessible, setAccessible, loading, send };
}

export type Chat = ReturnType<typeof useChat>;
