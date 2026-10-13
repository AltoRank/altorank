import { redirect } from "next/navigation";

/**
 * There is no pre-trial preview of a draft any more.
 *
 * This route rendered the whole first draft, read-only, to an account that
 * had not started its trial. A real signup (2026-09-22) copied the text from
 * it and published it on their own site 48 minutes later, without a trial.
 * The setup screen now shows the article's shape - title, outline, length,
 * sources - and the text opens with the trial.
 *
 * Kept as a redirect rather than deleted, because links to it were rendered
 * on the setup screen and may still be open in a tab or a browser history.
 */
export default function RetiredDraftPreview() {
  redirect("/onboarding");
}
