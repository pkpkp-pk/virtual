"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Lightweight i18n for the UI chrome (the chat *output* is already multilingual
// via Gemini; this closes the theme by localizing the chrome itself). EN + ES
// to start — extensible by adding a Lang + strings. Kept small on purpose:
// only the visible labels + example prompts, not every string.

export type Lang = "en" | "es";
export const LANGS: Lang[] = ["en", "es"];
export const LANG_LABEL: Record<Lang, string> = { en: "English", es: "Español" };

type Dict = Record<string, string>;

const STRINGS: Record<Lang, Dict> = {
  en: {
    "header.subtitle":
      "Deterministic graph pathfinder + Gemini tool-use. The LLM explains; it never computes the route.",
    "section.xai": "Why this route? (XAI)",
    "section.navigator": "Navigator",
    "section.ticket": "Your ticket",
    "section.controls": "Gate controls (demo)",
    "ticket.hint":
      "Bind your ticket for personalized alerts (your gate) and pre-filled routes.",
    "ticket.gate": "Entry gate…",
    "ticket.section": "Section…",
    "ticket.row": "Row (optional)",
    "ticket.bind": "Bind ticket",
    "ticket.saving": "Saving…",
    "accessible.label": "Wheelchair-accessible route",
    "chat.placeholder": "Where do you want to go?",
    "chat.send": "Send",
    "chat.thinking": "Thinking…",
    "chat.intro":
      "Ask for a route in any language. The pathfinder computes the fastest path from live crowd data; Gemini explains why.",
    "alert.expectDelays": "expect delays",
    "forecast.expected": "Expected to clear in",
    "forecast.min": "min",
    "forecast.notSoon": "not forecast to clear soon",
    "map.legend": "Legend",
    "map.routeHere": "Route here",
    "map.fromHere": "From here",
    "map.you": "You",
    "map.zoomIn": "Zoom in",
    "map.zoomOut": "Zoom out",
    "map.reset": "Reset view",
    "map.closed": "closed",
    "map.dismiss": "Close",
    "audio.read": "Read aloud",
    "audio.stop": "Stop",
    "lang.label": "Language",
    "chat.composerLabel": "Ask the navigator",
  },
  es: {
    "header.subtitle":
      "Buscador por grafos determinista + Gemini. El LLM explica; nunca calcula la ruta.",
    "section.xai": "¿Por qué esta ruta? (XAI)",
    "section.navigator": "Navegador",
    "section.ticket": "Tu entrada",
    "section.controls": "Controles de puertas (demo)",
    "ticket.hint":
      "Vincula tu entrada para alertas personalizadas (tu puerta) y rutas prellenadas.",
    "ticket.gate": "Puerta de entrada…",
    "ticket.section": "Sección…",
    "ticket.row": "Fila (opcional)",
    "ticket.bind": "Vincular entrada",
    "ticket.saving": "Guardando…",
    "accessible.label": "Ruta accesible en silla de ruedas",
    "chat.placeholder": "¿A dónde quieres ir?",
    "chat.send": "Enviar",
    "chat.thinking": "Pensando…",
    "chat.intro":
      "Pide una ruta en cualquier idioma. El buscador calcula la ruta más rápida con datos de multitud en vivo; Gemini explica por qué.",
    "alert.expectDelays": "espera retrasos",
    "forecast.expected": "Se despeja en aprox.",
    "forecast.min": "min",
    "forecast.notSoon": "no se prevé que se despeje pronto",
    "map.legend": "Leyenda",
    "map.routeHere": "Ruta aquí",
    "map.fromHere": "Desde aquí",
    "map.you": "Tú",
    "map.zoomIn": "Acercar",
    "map.zoomOut": "Alejar",
    "map.reset": "Restablecer vista",
    "map.closed": "cerrada",
    "map.dismiss": "Cerrar",
    "audio.read": "Leer en voz alta",
    "audio.stop": "Detener",
    "lang.label": "Idioma",
    "chat.composerLabel": "Pregunta al navegador",
  },
};

export const EXAMPLE_PROMPTS: Record<Lang, string[]> = {
  en: [
    "I just got to MetLife, what's the fastest way to section 126?",
    "I'm at Gate C, take me to section 126. Wheelchair accessible.",
    "Nearest restroom from Gate B",
    "Get me to Section 300 from the entry plaza",
    "Match is over — fastest way out to NJ Transit from section 126?",
  ],
  es: [
    "Llegué a MetLife, ¿cómo llego más rápido a la sección 126?",
    "Estoy en la puerta C, llévame a la sección 126. Accesible en silla de ruedas.",
    "Baño más cercano desde la puerta B",
    "Llévame a la sección 300 desde la entrada",
    "Se acabó el partido — ¿la salida más rápida al NJ Transit desde la sección 126?",
  ],
};

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
  examples: string[];
}

const I18nContext = createContext<I18nValue | null>(null);

const STORAGE_KEY = "stadium-lang";

export function I18nProvider({ children }: { children: ReactNode }) {
  // Lazy init reads the saved lang on the client's first render (SSR defaults
  // to "en"). Avoids a setState-in-effect; a saved non-"en" lang may cause a
  // cosmetic hydration diff on the language picker, which React patches.
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window === "undefined") return "en";
    const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
    return saved && LANGS.includes(saved) ? saved : "en";
  });

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  };

  // Keep <html lang> in sync so screen readers pronounce content in the chosen
  // language. Without this, switching to Spanish leaves <html lang="en">.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value: I18nValue = {
    lang,
    setLang,
    t: (key: string) => STRINGS[lang][key] ?? STRINGS.en[key] ?? key,
    examples: EXAMPLE_PROMPTS[lang],
  };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fallback (e.g., a component used outside the provider in a test) — English.
    return {
      lang: "en",
      setLang: () => {},
      t: (k: string) => STRINGS.en[k] ?? k,
      examples: EXAMPLE_PROMPTS.en,
    };
  }
  return ctx;
}
