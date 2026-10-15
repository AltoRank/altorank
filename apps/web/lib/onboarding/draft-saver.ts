// ---------------------------------------------------------------------------
// Save the wizard as the owner edits it, a moment after they stop
// ---------------------------------------------------------------------------
//
// The scheduling half of the wizard's draft save, with no React in it so the
// timing is tested with fake timers rather than watched in a browser:
//
// - `push` a value on every edit; it is saved once edits pause for `delay`;
// - `flush` saves what is pending now (the tab going to the background);
// - `stop` drops anything pending and waits for a save already in flight,
//   so the final click's confirmed save is the last write - a draft landing
//   after it would undo the confirmation (the server refuses that too);
// - `resume` after a final click that failed, so editing saves again.
//
// One save at a time: a push while a save is in flight waits for it, then
// saves the newest value, so drafts never land out of order.

export interface DraftSaver<T> {
  push(value: T): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
  resume(): void;
}

export const DRAFT_DELAY_MS = 800;

export function createDraftSaver<T>(save: (value: T) => Promise<unknown>, delay = DRAFT_DELAY_MS): DraftSaver<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  let inflight: Promise<void> | null = null;
  let stopped = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  async function flush(): Promise<void> {
    clear();
    // Wait out a save in flight first: the newest value goes after it.
    while (inflight) await inflight;
    if (!pending || stopped) return;
    const { value } = pending;
    pending = null;
    inflight = save(value)
      .then(() => undefined, () => undefined)
      .finally(() => {
        inflight = null;
      });
    await inflight;
  }

  return {
    push(value) {
      if (stopped) return;
      pending = { value };
      clear();
      timer = setTimeout(() => void flush(), delay);
    },
    flush,
    async stop() {
      stopped = true;
      clear();
      pending = null;
      while (inflight) await inflight;
    },
    resume() {
      stopped = false;
    },
  };
}
