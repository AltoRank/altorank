// ---------------------------------------------------------------------------
// Record and replay model answers, keyed by the prompt
// ---------------------------------------------------------------------------
//
// The decisions under test call the model through an `AskModel`. The harness
// hands them this recorder instead of `askStructured`:
//
// - replay (the default, free): the answer stored for this exact prompt, or
//   null when there is none. Null is what production gets from a failed call,
//   so the decision reports "no decision" and the report counts a miss. A
//   prompt that changed is a miss, never a stale answer.
// - live (opt-in): a stored answer when there is one, otherwise one real call,
//   refused before it is made when it could take the run past its budget.
// - plan: records which prompts a live run would buy and answers null, so the
//   run can be priced before anything is spent.
//
// Answers are stored next to the cases (`<fixtures>/recordings`), so a private
// case set keeps its prompts and answers private.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AskModel } from "@/lib/keyword-research/buyer-model";

export type RecorderMode = "replay" | "live" | "plan";

/** The one call a live run makes. Injected, so tests never touch the network. */
export type ModelClient = (request: { model: string; prompt: string; maxTokens: number }) => Promise<{
  text: string | null;
  inputTokens: number;
  outputTokens: number;
}>;

export interface Recording {
  key: string;
  operation: string;
  model: string;
  maxTokens: number;
  prompt: string;
  response: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordedAt: string;
}

export interface RecorderOptions {
  dir: string;
  mode: RecorderMode;
  model: string;
  /** Price per million tokens for `model`. */
  rate: { input: number; output: number };
  /** Hard cap on what this run may spend, in USD, across every paid call it makes. */
  maxUsd: number;
  client?: ModelClient;
}

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly nextUsd: number, readonly maxUsd: number) {
    super(`Spend cap reached: $${spentUsd.toFixed(4)} spent, the next call could cost up to $${nextUsd.toFixed(4)}, cap $${maxUsd.toFixed(2)}.`);
    this.name = "BudgetExceededError";
  }
}

/** The key an answer is stored under: everything that decides the answer except the sampling. */
export function promptKey(model: string, operation: string, prompt: string, maxTokens: number): string {
  return createHash("sha256").update(JSON.stringify([model, operation, maxTokens, prompt])).digest("hex");
}

/** Roughly how many tokens a prompt is: 3 characters a token errs high for English and Turkish alike. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** A shared purse: the recorder and any other paid step (results pages) draw on the same cap. */
export class Budget {
  spentUsd = 0;
  constructor(readonly maxUsd: number) {}
  /** Refuses before spending when `upperBoundUsd` more could pass the cap. */
  reserve(upperBoundUsd: number): void {
    if (this.spentUsd + upperBoundUsd > this.maxUsd + 1e-9) throw new BudgetExceededError(this.spentUsd, upperBoundUsd, this.maxUsd);
  }
  charge(usd: number): void {
    this.spentUsd += usd;
  }
}

export class Recorder {
  readonly budget: Budget;
  hits = 0;
  misses = 0;
  calls = 0;
  /** Plan mode: the prompts a live run would pay for, with an upper-bound and a typical cost. */
  readonly planned = new Map<string, { upperUsd: number; typicalUsd: number }>();
  private readonly options: RecorderOptions;

  constructor(options: RecorderOptions, budget?: Budget) {
    this.options = options;
    this.budget = budget ?? new Budget(options.maxUsd);
  }

  get dir(): string {
    return path.join(this.options.dir, "recordings");
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  read(key: string): Recording | null {
    const file = this.file(key);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as Recording;
  }

  cost(inputTokens: number, outputTokens: number): number {
    return (inputTokens * this.options.rate.input + outputTokens * this.options.rate.output) / 1_000_000;
  }

  /** The `AskModel` the decisions are handed. */
  readonly ask: AskModel = async (operation, prompt, { maxTokens }) => {
    const { model, mode } = this.options;
    const key = promptKey(model, operation, prompt, maxTokens);
    const stored = this.read(key);
    if (stored) {
      this.hits++;
      return stored.response;
    }
    const inputTokens = estimateTokens(prompt);
    if (mode === "plan") {
      // Typical: a structured answer is a few hundred tokens, not the ceiling.
      this.planned.set(key, { upperUsd: this.cost(inputTokens, maxTokens), typicalUsd: this.cost(inputTokens, Math.min(maxTokens, 450)) });
      return null;
    }
    if (mode === "replay") {
      this.misses++;
      return null;
    }
    if (!this.options.client) throw new Error("Live mode needs a model client.");
    this.budget.reserve(this.cost(inputTokens, maxTokens));
    const answer = await this.options.client({ model, prompt, maxTokens });
    const costUsd = this.cost(answer.inputTokens, answer.outputTokens);
    this.budget.charge(costUsd);
    this.calls++;
    const recording: Recording = {
      key, operation, model, maxTokens, prompt, response: answer.text,
      inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, costUsd,
      recordedAt: new Date().toISOString(),
    };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(key), `${JSON.stringify(recording, null, 2)}\n`);
    return answer.text;
  };
}
