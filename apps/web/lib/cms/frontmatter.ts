// YAML front matter for a generated post. Lived inside lib/cms/git.ts; it is
// here on its own because the "copy as Markdown" export in the editor renders
// the same file a git publish would commit, and the editor is a client
// component that must not pull the GitHub adapter into the browser bundle.

/** YAML-escape a scalar. Frontmatter is generated, so quoting must be exact. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildFrontmatter(
  fields: Record<string, string | boolean | string[] | undefined>,
): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(yamlString).join(", ")}]`);
    } else if (typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlString(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}
