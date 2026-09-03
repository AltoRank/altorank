"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
// Without these the editor treats a stored table as an unknown node and drops
// it on the next save, which would turn a rendering bug into data loss.
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import Placeholder from "@tiptap/extension-placeholder";
import { toast } from "sonner";
import { Icons } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { ConnectPrompt } from "@/components/ui/connect-prompt";
import { ConnectCmsDialog } from "@/components/dashboard/connect-cms-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PLATFORM_HINT, PLATFORM_LABEL, PLATFORM_CONNECT_TYPE, platformState } from "@/lib/cms/detect";
import { updateArticle } from "@/app/actions/articles";
import { publishArticle, approveArticle, requestChanges, markPublishedManually } from "@/app/actions/publish";
import { renderArticleMarkdown } from "@/lib/publishing/export";
import type { Destination } from "@/lib/publishing/destinations";
import { SchedulePicker } from "@/components/dashboard/editor/schedule-picker";
import { ResearchPanel, FactCheckPanel } from "@/components/dashboard/editor/research-panel";
import { WhyPanel } from "@/components/dashboard/editor/why-panel";
import type { Article, Workspace, PublishingCadence, Integration } from "@/lib/types";
import type { ScoringCheck } from "@/lib/seo/scoring";

type Props = {
  article: Article;
  workspace: Workspace;
  cadence?: PublishingCadence | null;
  /** Cloud account with no active plan: the draft is theirs to read and
      edit, approving or publishing it is where the plan is asked for. */
  needsPlan?: boolean;
  /**
   * The workspace's connected CMSs. These decide whether a Publish button
   * exists. `article.cms` used to, and only the manual New-article form ever
   * set it, so every generated draft was shown the copy-and-paste path even
   * with WordPress connected.
   */
  destinations?: Destination[];
  /**
   * The CMS integration rows, needed only so the connection dialog can open
   * over this page. Connecting from here never leaves the editor: a draft with
   * unsaved edits is a bad thing to navigate away from to fill in a form.
   */
  integrations?: Integration[];
};

export function ArticleEditor({
  article,
  workspace,
  cadence,
  needsPlan = false,
  destinations = [],
  integrations = [],
}: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  // What the first analysis observed, so the empty state can name the platform
  // and its credential, or say plainly that the site runs nothing we can post
  // to. A detection is only ever a suggestion: the user still connects it.
  const platform = platformState(workspace);
  // Which connection this publish goes through. One connection needs no
  // choice; several get a picker, defaulting to the first, which is also what
  // the scheduler would pick.
  const [destinationId, setDestinationId] = useState<string | null>(destinations[0]?.id ?? null);
  const destination = destinations.find((d) => d.id === destinationId) ?? destinations[0] ?? null;
  // The connection dialog, opened in place from the Publish panel. `connectType`
  // is the tab it opens on, taken from what detection saw.
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectType, setConnectType] = useState<string | null>(null);
  function openConnect(type: string | null) {
    setConnectType(type);
    setConnectOpen(true);
  }
  const [generating, setGenerating] = useState(false);
  const [streamHtml, setStreamHtml] = useState("");
  // Generation now has phases before any text appears. Without this the button
  // reads "Generating…" through a SERP round trip with nothing on screen.
  const [phase, setPhase] = useState<"idle" | "researching" | "writing" | "checking">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use stored Tiptap JSON content if available, otherwise show placeholder
  const initialContent = article.content
    ? article.content
    : `<h1>${article.title}</h1><p>Start writing your article about <strong>${article.keyword}</strong>…</p>`;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: "Start writing…" }),
    ],
    content: initialContent,
    // Required under the App Router. Without it Tiptap builds an editor during
    // the server render, throws "SSR has been detected", and React recovers by
    // discarding the server tree and re-rendering the whole route on the
    // client. The page still appears, which is why this went unnoticed, but
    // every load was erroring into the boundary and losing the server render.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[400px]",
      },
    },
    onUpdate: ({ editor }) => {
      // Debounced auto-save
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaving(true);
        try {
          const json = editor.getJSON();
          const text = editor.getText();
          const wordCount = text.split(/\s+/).filter(Boolean).length;
          await updateArticle(article.id, {
            content: json,
            seo_score: article.seo_score,
          });
          // Could update word count too but that requires schema change
        } catch {
          // Silent fail on auto-save
        } finally {
          setSaving(false);
        }
      }, 2000);
    },
  });

  const handleAskAI = useCallback(async () => {
    setGenerating(true);
    setStreamHtml("");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          keyword: article.keyword,
          title: article.title,
          // Generate into this article rather than a new one. Without it the
          // run created a second article and left this one empty.
          articleId: article.id,
        }),
      });

      if (!res.ok) throw new Error("Generation failed");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "researching") {
              setPhase("researching");
            } else if (data.type === "research") {
              const unavailable = (data.layers ?? []).filter(
                (l: { status: string }) => l.status !== "ok",
              );
              toast.success(
                `Researched: ${data.competitors} ranking pages, ${data.questions} questions, ${data.intent} intent`,
                unavailable.length
                  ? {
                      description: `Not available: ${unavailable
                        .map((l: { id: string }) => l.id)
                        .join(", ")}`,
                    }
                  : undefined,
              );
            } else if (data.type === "chunk") {
              setPhase("writing");
              accumulated += data.html;
              setStreamHtml(accumulated);
              // Feed into editor.
              //
              // `emitUpdate: false` matters: setContent fires Tiptap's
              // onUpdate by default, and onUpdate debounce-saves the document
              // back to this same article. Left on, the client's 2s save races
              // the server's final write of the same run and can land after
              // it, overwriting the saved title, scores and fact checks with a
              // half-streamed body.
              if (editor) {
                editor.commands.setContent(accumulated, { emitUpdate: false });
              }
            } else if (data.type === "factcheck") {
              setPhase("checking");
              if (data.verdict === "high_risk") {
                toast.warning(data.summary, {
                  description: "Review the flagged claims before approving.",
                });
              }
            } else if (data.type === "complete") {
              // Generation wrote to this article, so there is nowhere to
              // navigate: pick up the server's status, scores and word count
              // and leave the editor - and the text just streamed into it -
              // standing.
              router.refresh();
            } else if (data.type === "error") {
              throw new Error(data.error);
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      console.error("AI generation error:", err);
      toast.error(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
      setPhase("idle");
    }
  }, [workspace.id, article.id, article.keyword, article.title, editor, router]);

  /**
   * Select a flagged claim inside the document.
   *
   * Searches the claim fragment ("73%") rather than the whole sentence: a
   * sentence with bold or a link inside it spans several text nodes and would
   * never match as one string, whereas the fragment is short enough to sit in
   * a single node.
   */
  const locateInEditor = useCallback(
    (needle: string) => {
      if (!editor) return;

      let found: { from: number; to: number } | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (found) return false;
        if (!node.isText || !node.text) return;
        const idx = node.text.indexOf(needle);
        if (idx >= 0) found = { from: pos + idx, to: pos + idx + needle.length };
      });

      if (found) {
        editor.chain().focus().setTextSelection(found).scrollIntoView().run();
      } else {
        toast.info(`"${needle}" is no longer in the article`);
      }
    },
    [editor],
  );

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    try {
      const result = await publishArticle(article.id, destination?.id);
      toast.success(
        destination ? `Published to ${destination.label}` : "Article published",
        result?.url ? { description: result.url } : undefined,
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to publish article");
    } finally {
      setPublishing(false);
    }
  }, [article.id, destination, router]);

  // Both render from what is on screen right now, synchronously inside the
  // click, so the clipboard write stays within the user gesture Safari
  // requires. Markdown is the file a git publish would commit, front matter
  // included; HTML is for pasting into a CMS we have no adapter for.
  const copyToClipboard = useCallback(async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setManualError(done);
    } catch {
      // Clipboard access needs a focused, permitted document; when it is
      // refused, say so rather than claiming a copy that did not happen.
      setManualError("Could not reach the clipboard. Click into the page and try again.");
    }
  }, []);
  const copyHtml = useCallback(
    () => copyToClipboard(editor?.getHTML() ?? "", "Copied the article as HTML."),
    [editor, copyToClipboard],
  );
  const copyMarkdown = useCallback(() => {
    const markdown = renderArticleMarkdown(
      {
        title: article.title,
        slug: article.slug,
        html: editor?.getHTML() ?? "",
        metaDescription: article.meta_description,
        keyword: article.keyword,
        featuredImageUrl: article.featured_image_url,
        publishedAt: article.published_at,
      },
      `https://${workspace.domain}`,
    );
    return copyToClipboard(markdown, "Copied the article as Markdown, front matter included.");
  }, [editor, article, workspace.domain, copyToClipboard]);

  /**
   * The two ways out for a site we cannot post to. Rendered both before and
   * after approval: it used to appear only once the article was approved,
   * which left a user with no CMS looking at a panel whose single button said
   * "Connect a CMS" and no sign that approving was safe.
   */
  const copyPair = (
    <div className="grid grid-cols-2 gap-2">
      <Button size="sm" variant="ghost" className="justify-center" onClick={copyMarkdown}>
        <Icons.download size={13} />
        Copy as Markdown
      </Button>
      <Button size="sm" variant="ghost" className="justify-center" onClick={copyHtml}>
        <Icons.download size={13} />
        Copy as HTML
      </Button>
    </div>
  );

  const handleApprove = useCallback(async () => {
    setPublishing(true);
    try {
      await approveArticle(article.id);
      toast.success("Article approved — ready to publish");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve article");
    } finally {
      setPublishing(false);
    }
  }, [article.id, router]);

  const handleRequestChanges = useCallback(async () => {
    setPublishing(true);
    try {
      await requestChanges(article.id);
      toast.success("Sent back for changes");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send back");
    } finally {
      setPublishing(false);
    }
  }, [article.id, router]);

  return (
    <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "1fr 340px" }}>
      {/* Editor pane */}
      <div className="border-r border-line flex flex-col min-h-0">
        {/* Toolbar */}
        <div className="sticky top-0 z-[2] flex gap-0.5 items-center px-8 py-2.5 bg-bg border-b border-line">
          <ToolbarBtn icon={<Icons.h1 size={14} />} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} active={editor?.isActive("heading")} />
          <ToolbarBtn icon={<Icons.bold size={14} />} onClick={() => editor?.chain().focus().toggleBold().run()} active={editor?.isActive("bold")} />
          <ToolbarBtn icon={<Icons.italic size={14} />} onClick={() => editor?.chain().focus().toggleItalic().run()} active={editor?.isActive("italic")} />
          <ToolbarBtn icon={<Icons.list size={14} />} onClick={() => editor?.chain().focus().toggleBulletList().run()} active={editor?.isActive("bulletList")} />
          <ToolbarBtn
            icon={<Icons.link size={14} />}
            active={editor?.isActive("link")}
            onClick={() => {
              if (!editor) return;
              if (editor.isActive("link")) {
                editor.chain().focus().unsetLink().run();
                return;
              }
              const url = window.prompt("Link URL (https://…)");
              if (!url) return;
              const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
              editor.chain().focus().setLink({ href }).run();
            }}
          />
          <div className="flex-1" />
          {saving && <span className="text-[11px] text-ink-3 font-mono mr-2">Saving…</span>}
          {/* Parked, not removed: the streaming generation behind this works and
              is exercised by /api/generate. Turning it off in the editor is a
              product decision, so the handler stays wired and the button simply
              cannot be pressed. `title` is the coming-soon idiom already used by
              the calendar's disabled view tabs; there is no shadcn in this repo
              and adding it for one tooltip would be a lot of dependency for a
              small affordance. */}
          <Button
            size="sm"
            onClick={handleAskAI}
            disabled
            title="Coming soon"
          >
            <Icons.sparkle size={13} />
            {phase === "researching"
              ? "Researching…"
              : phase === "writing"
                ? "Writing…"
                : phase === "checking"
                  ? "Checking claims…"
                  : generating
                    ? "Generating…"
                    : "Ask AI"}
          </Button>
        </div>

        {/* Document */}
        <div className="flex-1 overflow-y-auto scroll">
          <div className="max-w-[720px] mx-auto px-8 py-10 pb-20 [&_.ProseMirror_h1]:text-[32px] [&_.ProseMirror_h1]:font-semibold [&_.ProseMirror_h1]:tracking-[-0.02em] [&_.ProseMirror_h1]:leading-[1.15] [&_.ProseMirror_h1]:mb-3.5 [&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h2]:mt-7 [&_.ProseMirror_h2]:mb-2.5 [&_.ProseMirror_p]:text-[14.5px] [&_.ProseMirror_p]:leading-[1.65] [&_.ProseMirror_p]:mb-3.5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5 [&_.ProseMirror_ol]:mb-3.5 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror_ul]:mb-3.5 [&_.ProseMirror_li]:mb-1.5 [&_.ProseMirror_strong]:font-semibold [&_.ProseMirror_em]:italic [&_.ProseMirror_a]:text-accent-ink [&_.ProseMirror_a]:border-b [&_.ProseMirror_a]:border-accent-soft [&_.ProseMirror_.is-editor-empty:first-child::before]:text-ink-4 [&_.ProseMirror_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_.is-editor-empty:first-child::before]:pointer-events-none">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>

      {/* Right sidebar — SEO panel */}
      <aside className="bg-panel overflow-y-auto p-6 scroll">
        {/* SEO score */}
        {/* First, because the reviewer's first question is "why am I looking
            at this?" rather than "what did it score?". */}
        <SidebarSection title="Why this draft">
          <WhyPanel
            reasons={article.selection_reasons}
            score={article.selection_score}
            volume={article.volume}
            difficulty={article.keyword_difficulty}
            intent={article.search_intent}
            checks={article.seo_checks}
            seoScore={article.seo_score}
            aeoChecks={article.aeo_checks as never}
            aeoScore={article.aeo_score}
          />
        </SidebarSection>

        <SidebarSection title="Scores">
          {/* Two rings, because they answer two different questions and a
              reviewer needs both. SEO is "will Google rank it"; citation
              readiness is "will an AI answer quote it", which is the thing this
              product actually claims. One ring was hiding the second. */}
          <TooltipProvider>
            <div className="flex items-center gap-5">
              <ScoreRing
                value={article.seo_score > 0 ? article.seo_score : null}
                label="SEO"
                caption="Google ranking"
                checks={article.seo_checks as ScoringCheck[] | null}
                basis="Weighted from keyword placement, density, heading tree, meta length, length and readability."
              />
              <ScoreRing
                value={article.aeo_score}
                label="GEO"
                caption="AI citation"
                checks={article.aeo_checks as ScoringCheck[] | null}
                basis="Weighted from answer-first opening, a liftable definition, quotable figures with sources, question headings and structure."
              />
            </div>
          </TooltipProvider>
          <p className="mt-2.5 text-[11.5px] text-ink-3">
            {article.seo_score > 0 || article.aeo_score !== null
              ? "Both are computed from the draft, no model call. The checks below are what they are made of."
              : "Generate content to score."}
          </p>
        </SidebarSection>

        {/* Fact check — placed high because it is the thing that blocks approval */}
        {article.fact_checks && (
          <SidebarSection
            title={
              article.fact_checks.counts.total
                ? `Fact check (${article.fact_checks.counts.total})`
                : "Fact check"
            }
          >
            <FactCheckPanel report={article.fact_checks} onLocate={locateInEditor} />
          </SidebarSection>
        )}

        {/* Target keywords */}
        <SidebarSection title="Target keywords">
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between px-2.5 py-1.5 rounded-[6px] text-[12.5px] border bg-accent-soft text-accent-ink border-transparent font-medium">
              <span>{article.keyword}</span>
              <span className="font-mono text-[11px] text-accent-ink">{typeof article.volume === "number" ? article.volume.toLocaleString() : "—"}</span>
            </div>
          </div>
        </SidebarSection>

        {/* Research */}
        <SidebarSection title="Research">
          {article.research ? (
            <ResearchPanel research={article.research} />
          ) : (
            <div className="text-[12.5px] text-ink-3 italic">
              This draft was written before research was wired in. Regenerate to
              pull the live search results, questions and intent for this keyword.
            </div>
          )}
        </SidebarSection>

        {/* Voice check */}
        <SidebarSection title="Voice check">
          <div className="text-[12.5px] text-ink-3 italic">
            Voice analysis available after content generation
          </div>
        </SidebarSection>

        {/* Publish to */}
        <SidebarSection title="Publish to" last>
          {destinations.length > 0 ? (
            <>
              {destinations.length === 1 ? (
                <div className="flex items-center gap-2.5 p-2.5 bg-bg border border-line rounded-[7px]">
                  <div className="w-7 h-7 rounded-[6px] bg-ink text-bg grid place-items-center font-mono text-[10px] font-semibold">
                    {destinations[0].label.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate">
                      {destinations[0].label} — {workspace.domain}
                    </div>
                  </div>
                  <StatusPill status="on" label={article.status === "live" ? "Live" : "Connected"} />
                </div>
              ) : (
                <label className="block">
                  <span className="mb-1 block font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">
                    Destination
                  </span>
                  <select
                    value={destination?.id ?? ""}
                    onChange={(e) => setDestinationId(e.target.value)}
                    disabled={article.status === "live"}
                    aria-label="Publishing destination"
                    className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent"
                  >
                    {destinations.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {article.status === "approved" && needsPlan && (
                <Link
                  href="/settings/billing"
                  className="mt-3 block w-full rounded-[7px] bg-accent px-3 py-2 text-center text-[13px] font-medium text-white hover:bg-accent-2"
                >
                  Choose a plan to publish
                </Link>
              )}
              {article.status === "approved" && !needsPlan && (
                <>
                  <Button
                    size="sm"
                    className="w-full justify-center mt-3"
                    onClick={handlePublish}
                    disabled={publishing}
                  >
                    {publishing ? "Publishing…" : `Publish to ${destination?.label ?? "CMS"}`}
                  </Button>
                  <button
                    type="button"
                    className="w-full text-center mt-2 text-[12px] text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
                    onClick={handleRequestChanges}
                    disabled={publishing}
                  >
                    Request changes
                  </button>
                </>
              )}
              <SchedulePicker article={article} cadence={cadence ?? null} />
            </>
          ) : platform.state === "matched" ? (
            // The analysis recognised the platform: name it and open the
            // connection dialog on its tab, credential named in the hint.
            <ConnectPrompt
              icon="integrations"
              service={`Looks like ${PLATFORM_LABEL[platform.platform]}`}
              title="No publishing destination yet"
              body={`${PLATFORM_HINT[platform.platform]} Approve the draft whenever you are ready; nothing publishes on its own either way.`}
              onClick={() => openConnect(PLATFORM_CONNECT_TYPE[platform.platform] ?? null)}
              cta={
                PLATFORM_CONNECT_TYPE[platform.platform]
                  ? `Connect ${PLATFORM_LABEL[platform.platform]}`
                  : "See the options"
              }
            />
          ) : platform.state === "checked" ? (
            // We fetched the site and nothing matched, which is the honest
            // answer for a hand-built or headless site. Saying so beats a
            // sixteen-tile grid: the options are three, and the first of them
            // appears in this panel the moment the draft is approved.
            <ConnectPrompt
              icon="integrations"
              title={`No CMS found on ${workspace.domain}`}
              body={`We fetched ${workspace.domain} on ${new Date(platform.checkedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} and saw nothing we can post to directly. Sites like this publish by hand, by webhook, or from a git repository: approve the draft and copy it as Markdown or HTML below, or connect a webhook or repository.`}
              onClick={() => openConnect("webhook")}
              cta="Connect a webhook or repository"
            />
          ) : (
            <ConnectPrompt
              icon="integrations"
              title="No publishing destination yet"
              body="Two ways out of here: connect a CMS and the draft can go out from this panel, or approve it and take the file — Markdown or HTML — to publish wherever you already do. Nothing publishes on its own either way."
              onClick={() => openConnect(null)}
              cta="Connect a CMS"
            />
          )}

          {article.status === "review" && needsPlan && (
            <div className="mt-3">
              <Link
                href="/settings/billing"
                className="block w-full rounded-[7px] bg-accent px-3 py-2 text-center text-[13px] font-medium text-white hover:bg-accent-2"
              >
                Choose a plan to approve
              </Link>
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
                This draft is yours to read and edit. Nothing has been charged; approving and
                publishing need a plan, and you cancel it yourself from the billing page.
              </p>
            </div>
          )}
          {article.status === "review" && !needsPlan && (
            <>
              <Button
                size="sm"
                className="w-full justify-center mt-3"
                onClick={handleApprove}
                disabled={publishing}
              >
                {publishing ? "Approving…" : "Approve for publishing"}
              </Button>
              {/* Approve stays available with nothing connected on purpose. The
                  manual path — copy the file, publish it yourself, paste the
                  URL back — only unlocks after approval, so gating approval on
                  a connection would strand every site that will never have one:
                  a headless build, a repo-published site, a hand-written app. */}
              {destinations.length === 0 && (
                <div className="mt-2 flex flex-col gap-2">
                  <div className="text-[12px] text-ink-3 leading-relaxed">
                    Or take the file and publish it yourself — you can paste the URL
                    back here once it is live.
                  </div>
                  {copyPair}
                </div>
              )}
            </>
          )}
          {/* No connection, and the site may have nothing to connect: a hand-
              built app, or a Next.js, Astro or Hugo build that publishes from
              a repository. Rather than leave an approved article stranded,
              hand over the file in the shape the site wants and record where
              it went. A URL is required because without one there is no
              evidence it is anywhere. */}
          {article.status === "approved" && destinations.length === 0 && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="text-[12px] text-ink-3 leading-relaxed">
                Approved. Publish it yourself and paste the URL, or connect a destination
                above to have it go out from here.
              </div>
              {copyPair}
              <input
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="https://yoursite.com/blog/the-post"
                aria-label="Published URL"
                className="w-full px-2.5 py-1.5 bg-bg border border-line rounded-[6px] text-[12.5px]"
              />
              <Button
                size="sm"
                className="justify-center"
                disabled={publishing || !manualUrl.trim()}
                onClick={async () => {
                  setPublishing(true);
                  setManualError(null);
                  try {
                    await markPublishedManually(article.id, manualUrl);
                    router.refresh();
                  } catch (err) {
                    setManualError(err instanceof Error ? err.message : "Could not record it");
                  } finally {
                    setPublishing(false);
                  }
                }}
              >
                {publishing ? "Recording…" : "Mark as published"}
              </Button>
              {manualError && (
                <div className="text-[11.5px] text-ink-3">{manualError}</div>
              )}
            </div>
          )}
          {article.published_url && (
            <a
              href={article.published_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex items-center gap-1.5 text-[12px] text-accent-ink hover:underline"
            >
              <Icons.externalLink size={12} />
              View published article
            </a>
          )}
        </SidebarSection>
      </aside>

      {/*
        Connecting happens over the editor, not on /connect. On success the
        dialog closes and the route refreshes, so this panel re-renders with a
        destination and a Publish button — which the user then presses. Saving
        a credential is not consent to publish, and the empty state above
        promises exactly that.
      */}
      <ConnectCmsDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        // Only this article's workspace: the picker exists for the settings
        // page, where several are in play. Here, choosing another one would
        // connect a CMS this draft cannot reach.
        workspaces={[workspace]}
        integrations={integrations}
        initialCmsType={connectType}
        onConnected={() => {
          toast.success("Connected. Publish it whenever you are ready.");
          router.refresh();
        }}
      />
    </div>
  );
}

/**
 * A score ring. `null` is unmeasured and renders hollow with a dash: a full
 * grey ring at 0 would read as a measured zero, which is the mistake this repo
 * has made in four other places.
 */
function ScoreRing({
  value,
  label,
  caption,
  checks,
  basis,
}: {
  value: number | null;
  label: string;
  caption: string;
  /** The per-check breakdown, so hovering explains the number. */
  checks?: ScoringCheck[] | null;
  basis: string;
}) {
  const known = typeof value === "number";
  const tone = !known
    ? "var(--panel-2)"
    : value >= 80
      ? "var(--ok)"
      : value >= 60
        ? "var(--warn)"
        : "var(--err)";
  const failed = (checks ?? []).filter((c) => !c.passed);

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
    <div className="flex items-center gap-2.5 cursor-default" tabIndex={0}>
      <div
        className="w-12 h-12 rounded-full grid place-items-center"
        style={{
          background: known
            ? `conic-gradient(${tone} 0 ${value}%, var(--panel-2) ${value}% 100%)`
            : "var(--panel-2)",
        }}
      >
        <span className="w-9 h-9 rounded-full bg-bg grid place-items-center font-mono font-semibold text-[13px] tabular-nums">
          {known ? value : "—"}
        </span>
      </div>
      <div>
        <div className="font-semibold text-[12.5px]">{label}</div>
        <div className="text-[11px] text-ink-3">{caption}</div>
      </div>
    </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[280px] whitespace-normal text-left">
        {!known
          ? "Not scored yet. That is different from scoring zero."
          : failed.length === 0
            ? `${value}/100. Every check passed. ${basis}`
            : `${value}/100. ${basis} Losing points on: ${failed
                .map((c) => c.name)
                .join(", ")}.`}
      </TooltipContent>
    </Tooltip>
  );
}

function ToolbarBtn({ icon, onClick, active, disabled }: { icon: React.ReactNode; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-[30px] h-[30px] rounded-[6px] grid place-items-center cursor-pointer transition-colors disabled:opacity-40 disabled:pointer-events-none ${
        active ? "bg-panel-2 text-ink" : "text-ink-2 hover:bg-panel-2 hover:text-ink"
      }`}
    >
      {icon}
    </button>
  );
}

function SidebarSection({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`pb-5 mb-5 ${last ? "" : "border-b border-line"}`}>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3 mb-3">{title}</div>
      {children}
    </div>
  );
}
