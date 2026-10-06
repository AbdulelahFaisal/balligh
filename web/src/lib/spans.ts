export interface Highlight {
  text: string;
  id: string | null;
}

export function highlightSegments(text: string, ranges: { id: string; start: number; end: number }[]): Highlight[] {
  const codePoints = Array.from(text);
  const slice = (a: number, b?: number) => codePoints.slice(a, b).join("");
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Highlight[] = [];
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.end > codePoints.length) continue;
    if (r.start > pos) out.push({ text: slice(pos, r.start), id: null });
    out.push({ text: slice(r.start, r.end), id: r.id });
    pos = r.end;
  }
  if (pos < codePoints.length) out.push({ text: slice(pos), id: null });
  return out;
}
