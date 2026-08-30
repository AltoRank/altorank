"use client";

import { createContext, useContext, useState, useCallback } from "react";
import type { Workspace } from "@/lib/types";

type WorkspaceContextValue = {
  workspaces: Workspace[];
  active: Workspace | null;
  setActiveId: (id: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  active: null,
  setActiveId: () => {},
});

export function useWorkspace() {
  return useContext(WorkspaceContext);
}

export function WorkspaceProvider({
  workspaces,
  initialId,
  children,
}: {
  workspaces: Workspace[];
  initialId?: string;
  children: React.ReactNode;
}) {
  const [activeId, setActiveIdState] = useState(
    () => initialId ?? workspaces[0]?.id ?? ""
  );

  const setActiveId = useCallback(
    (id: string) => {
      setActiveIdState(id);
      // Persist to cookie so server components can read it
      document.cookie = `active_workspace=${id};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
    },
    []
  );

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? null;

  return (
    <WorkspaceContext value={{ workspaces, active, setActiveId }}>
      {children}
    </WorkspaceContext>
  );
}
