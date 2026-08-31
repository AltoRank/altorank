"use client";

import { useState } from "react";
import { Button, Icons } from "@/components/ui";

/**
 * Floating feedback button.
 *
 * The screenshot is taken in the browser and posted straight through to email.
 * Nothing is stored: no row, no bucket, no log line. A screenshot of this app
 * contains client domains, keywords and draft copy, and holding a copy of that
 * in order to read a bug report would be collecting data we have no reason to
 * keep.
 *
 * `html-to-image` renders the DOM rather than asking for screen-capture
 * permission, which would put a browser dialog between the person and the
 * thought they wanted to send.
 */
export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [withShot, setWithShot] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function send() {
    setSending(true);
    setResult(null);
    try {
      let screenshot: string | undefined;
      if (withShot) {
        try {
          // Imported here so the library is not in the bundle for everyone who
          // never opens this.
          const { toPng } = await import("html-to-image");
          screenshot = await toPng(document.body, {
            // Enough to read, small enough to email.
            pixelRatio: 1,
            // The panel itself is not the bug.
            filter: (node) =>
              !(node instanceof HTMLElement && node.dataset.feedbackPanel === "true"),
          });
        } catch {
          // A screenshot that fails must not take the message with it.
          screenshot = undefined;
        }
      }

      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          screenshot,
          path: window.location.pathname,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setResult(data.error ?? "Could not send it.");
        return;
      }

      setResult(
        screenshot ? "Sent, with the screenshot." : "Sent. No screenshot attached.",
      );
      setMessage("");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {open && (
        <div
          data-feedback-panel="true"
          className="fixed bottom-[68px] right-5 z-[60] w-[320px] rounded-[10px] border border-line bg-bg p-4 shadow-lg"
        >
          <div className="mb-2 text-[13px] font-semibold">Send feedback</div>
          <p className="mb-3 text-[11.5px] leading-relaxed text-ink-3">
            Goes straight to our inbox with a picture of this page. Nothing is
            stored.
          </p>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder="What is wrong, confusing, or missing?"
            aria-label="Your feedback"
            className="w-full resize-none rounded-[6px] border border-line bg-panel px-2.5 py-2 text-[12.5px]"
          />
          <label className="mt-2 flex items-center gap-2 text-[11.5px] text-ink-2">
            <input
              type="checkbox"
              checked={withShot}
              onChange={(e) => setWithShot(e.target.checked)}
            />
            Include a screenshot of this page
          </label>
          <Button
            size="sm"
            className="mt-3 w-full justify-center"
            disabled={sending || !message.trim()}
            onClick={send}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
          {result && (
            <div className="mt-2 text-[11.5px] text-ink-3">{result}</div>
          )}
        </div>
      )}

      <button
        data-feedback-panel="true"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close feedback" : "Send feedback"}
        aria-expanded={open}
        className="fixed bottom-5 right-5 z-[60] flex h-11 w-11 items-center justify-center rounded-full border border-line bg-ink text-bg shadow-lg hover:opacity-90"
      >
        {open ? <Icons.x size={16} /> : <Icons.message size={16} />}
      </button>
    </>
  );
}
