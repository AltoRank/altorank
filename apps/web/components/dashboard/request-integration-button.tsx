"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";

/**
 * The second state of an integration tile: we have no adapter for this
 * platform, so instead of a disabled "Connect" the tile asks whether you want
 * one.
 *
 * One click, no form. A note field would collect better information and would
 * be pressed by far fewer people; what we need first is the count and the
 * platform, and the reply-to on the email opens the conversation for the rest.
 *
 * "Requested" persists for the page's life only. It is deliberately not stored:
 * the server writes nothing (see app/api/integration-request/route.ts), so
 * claiming a durable "you asked for this on the 3rd" would be a lie the next
 * reload exposes.
 */
export function RequestIntegrationButton({
  integrationId,
  integrationName,
}: {
  integrationId: string;
  integrationName: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  async function request() {
    setState("sending");
    try {
      const res = await fetch("/api/integration-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationId, integrationName }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not send that.");
      }
      setState("sent");
      toast.success(`Noted — we will email you when ${integrationName} is ready.`);
    } catch (err) {
      setState("idle");
      toast.error(err instanceof Error ? err.message : "Could not send that.");
    }
  }

  if (state === "sent") {
    return (
      <Button size="sm" variant="ghost" disabled className="w-full justify-center">
        Requested
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className="w-full justify-center"
      disabled={state === "sending"}
      onClick={request}
    >
      {state === "sending" ? "Sending…" : "Request integration"}
    </Button>
  );
}
