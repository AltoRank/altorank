"use client";

import { createContext, useContext } from "react";

// ---------------------------------------------------------------------------
// What every AI-capable piece of the editor needs to know
// ---------------------------------------------------------------------------
//
// The image node view is rendered by Tiptap inside the document, several
// layers below the component that owns the article, so it cannot take props.
// This context carries the little it needs: which article, which mode, and
// how to report that a proposal was accepted so the header count moves.

export type EditorMode = "review" | "editor";

export interface EditorAiContextValue {
  articleId: string;
  mode: EditorMode;
  /** The document's H2s, for the rewrite prompts' context. */
  outline: string[];
  /** The document as HTML right now, for an image's surrounding paragraph. */
  docHtml: string;
  /** An accepted proposal changed the body: count it. */
  onBodyChange: () => void;
}

export const EditorAiContext = createContext<EditorAiContextValue>({
  articleId: "",
  mode: "review",
  outline: [],
  docHtml: "",
  onBodyChange: () => {},
});

export function useEditorAi(): EditorAiContextValue {
  return useContext(EditorAiContext);
}
