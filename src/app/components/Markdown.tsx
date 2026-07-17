"use client";

import { type ReactNode } from "react";

// Minimal, dependency-free markdown renderer for the subset Gemini emits:
// paragraphs, bullet lists (- or *), bold (** / __), italic (* / _). Nothing
// fancy — no headings, links, or code. Crucially, no raw HTML is ever injected:
// every token maps to a React element, so LLM output can't XSS the chat panel.
// (The text comes from Gemini, not the user, so the risk is low anyway — but
// never injecting HTML means it's zero.)

/** Render inline bold/italic to React nodes. Bold is matched before italic so
 *  `**x**` isn't seen as two italics. `[^*]+?` keeps a bold span from swallowing
 *  a later `*`. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*]+?)\*|_([^_]+?)_/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) nodes.push(<strong key={`${keyBase}-s${i}`}>{m[1]}</strong>);
    else if (m[2] !== undefined) nodes.push(<strong key={`${keyBase}-s${i}`}>{m[2]}</strong>);
    else if (m[3] !== undefined) nodes.push(<em key={`${keyBase}-e${i}`}>{m[3]}</em>);
    else if (m[4] !== undefined) nodes.push(<em key={`${keyBase}-e${i}`}>{m[4]}</em>);
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function Markdown({ text }: { text: string }) {
  // Split on blank lines into blocks; each block is either a bullet list (every
  // non-blank line starts with "- " or "* ") or a paragraph.
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((block, bi) => {
        const lines = block
          .split(/\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const isList = lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l));
        if (isList) {
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {lines.map((l, li) => (
                <li key={li}>
                  {renderInline(l.replace(/^[-*]\s+/, ""), `b${bi}-l${li}`)}
                </li>
              ))}
            </ul>
          );
        }
        return <p key={bi}>{renderInline(lines.join(" "), `b${bi}`)}</p>;
      })}
    </div>
  );
}
