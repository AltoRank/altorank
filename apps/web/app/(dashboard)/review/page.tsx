import { redirect } from "next/navigation";

/**
 * Review is a state of an article, not a place of its own: it now lives as
 * the first filter on Articles, which is where someone looks when they come
 * to see what needs them (2026-09-02). The route stays so old links work.
 */
export default function ReviewQueueRedirect() {
  redirect("/articles?status=review");
}
