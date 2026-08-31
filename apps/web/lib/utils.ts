import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * `{n} articles` reads as "1 articles" the moment someone has one of them,
 * which is the first thing every new account sees.
 *
 * English plurals are irregular enough that a rule is worse than an argument,
 * so the odd ones pass their own: `plural(n, "audit")` but
 * `plural(n, "entry", "entries")`.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
