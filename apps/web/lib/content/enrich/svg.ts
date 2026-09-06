// What an inline SVG in an article may contain. The infographic step writes
// only shapes and text; anything else in a stored figure means the markup was
// edited after the fact, and the editor and the serialiser both refuse to
// render it. Shared by both so they cannot disagree.

const FORBIDDEN = /<\s*(script|foreignObject|iframe|object|embed|image|use|a)\b|\son[a-z]+\s*=|javascript:|xlink:href|\shref\s*=/i;

export function isSafeSvg(svg: string | null | undefined): svg is string {
  if (!svg) return false;
  const trimmed = svg.trim();
  if (!/^<svg\b[\s\S]*<\/svg>$/i.test(trimmed)) return false;
  return !FORBIDDEN.test(trimmed);
}
