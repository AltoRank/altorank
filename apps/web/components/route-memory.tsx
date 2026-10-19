"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { readRouteMemory, rememberPath, writeRouteMemory } from "@/lib/navigation/route-memory";

/** Writes each path this tab shows (lib/navigation/route-memory.ts). Renders nothing. */
export function RouteMemory() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) writeRouteMemory(rememberPath(readRouteMemory(), pathname));
  }, [pathname]);
  return null;
}
