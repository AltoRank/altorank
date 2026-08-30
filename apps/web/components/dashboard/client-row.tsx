"use client";

import { useRouter } from "next/navigation";

export function ClientRow({ href, children }: { href: string; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <tr
      className="cursor-pointer hover:[&>td]:bg-panel"
      onClick={() => router.push(href)}
    >
      {children}
    </tr>
  );
}
