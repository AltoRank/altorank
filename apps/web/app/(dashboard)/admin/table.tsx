import type { ReactNode } from "react";

/**
 * The dense read-only table both Operations panes use. Lived inside the costs
 * page until the users pane needed the same thing; first column is prose,
 * every other column is a figure.
 */
export function Table({
  head,
  rows,
  empty = "Nothing recorded yet.",
}: {
  head: string[];
  rows: ReactNode[][];
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={`${h}-${i}`}
                scope="col"
                className="px-3.5 py-2.5 text-left font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3 border-b border-line"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="px-3.5 py-8 text-center text-ink-3">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td
                  key={j}
                  className={`px-3.5 py-2.5 border-b border-line-soft text-ink-2 align-middle ${
                    j === 0 ? "" : "font-mono text-xs"
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
