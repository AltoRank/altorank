"use client";

import { Button, Icons } from "@/components/ui";

interface ExportCsvProps {
  columns: string[];
  rows: string[][];
  filename?: string;
}

export function ExportCsv({ columns, rows, filename = "export" }: ExportCsvProps) {
  function handleExport() {
    const escape = (val: string) => {
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    const header = columns.map(escape).join(",");
    const body = rows.map((row) => row.map(escape).join(",")).join("\n");
    const csv = `${header}\n${body}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Button onClick={handleExport}>
      <Icons.download size={14} />
      Export
    </Button>
  );
}
