import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Bound actual database transport, including response bodies and caller aborts. */
export function deadlineFetch(deadline: number, fetcher: typeof fetch = globalThis.fetch, timeoutMs = 15_000): typeof fetch {
  return async (input, init) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DOMException("Onboarding persistence deadline reached", "TimeoutError");
    const callers = [init?.signal, input instanceof Request ? input.signal : undefined].filter((signal): signal is AbortSignal => Boolean(signal));
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining)));
    const signal = callers.length ? AbortSignal.any([...callers, timeout]) : timeout;
    signal.throwIfAborted();
    return fetcher(input, { ...init, signal });
  };
}

/** This invocation's client only; other requests keep their existing behavior. */
export function createWorkerClient(deadline: number): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    global: { fetch: deadlineFetch(deadline) },
  });
}
