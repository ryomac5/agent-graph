export interface MdSpan { type: "text" | "strong" | "code"; text: string }
export type MdLine =
  | { type: "heading"; level: number; spans: MdSpan[] }
  | { type: "bullet"; indent: number; spans: MdSpan[] }
  | { type: "line"; spans: MdSpan[] };

export function inlineSpans(line: string): MdSpan[];
export function parseMarkdown(text: unknown): MdLine[];
