// Shared response helpers for the OAuth endpoints. Every error is the RFC 6749
// §5.2 shape `{ error, error_description }`, never an agent envelope: the
// reader here is an OAuth client library, not a model.

import { NextResponse, type NextRequest } from "next/server";
import { appBaseUrl } from "@/lib/agent/http";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function oauthError(error: string, description: string, status = 400, headers: Record<string, string> = {}): NextResponse {
  return oauthJson({ error, error_description: description }, status, headers);
}

/** Token and registration bodies arrive as form-encoded or JSON depending on the client. */
export async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const parsed = (await request.json()) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    }
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text));
  } catch {
    return {};
  }
}

export { appBaseUrl };
