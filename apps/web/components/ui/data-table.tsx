import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  header: string;
  numeric?: boolean;
  render: (row: T) => React.ReactNode;
  className?: string;
};

type DataTableProps<T> = {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T) => void;
  className?: string;
};

export function DataTable<T>({ columns, data, onRowClick, className }: DataTableProps<T>) {
  return (
    <table className={cn("w-full border-collapse text-[13px]", className)}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={col.key}
              className={cn(
                "text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel sticky top-0 z-[1]",
                col.numeric && "text-right",
                col.className
              )}
            >
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr
            key={i}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn(
              "group",
              onRowClick && "cursor-pointer",
              "hover:[&>td]:bg-panel"
            )}
          >
            {columns.map((col) => (
              <td
                key={col.key}
                className={cn(
                  "px-3.5 py-3 border-b border-line-soft align-middle transition-colors",
                  col.numeric && "text-right font-mono text-xs text-ink-2",
                  col.className
                )}
              >
                {col.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
