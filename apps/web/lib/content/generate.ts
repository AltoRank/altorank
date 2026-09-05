// ---------------------------------------------------------------------------
// Article generation, one implementation
// ---------------------------------------------------------------------------
//
// Used by two callers that differ only in whether a human is watching:
//
//   POST /api/generate      streams to an editor, passes `onChunk`
//   GET  /api/cron/generate unattended, no callback
//
// The alternative was a second copy of this in the cron. Today's session found
// four separate bugs that existed only because two code paths were meant to do
// the same thing and drifted, so the streaming hook is the whole difference and
// everything else is shared by construction.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProvider } from "@/lib/ai/provider";
import { stripAiTypography } from "@/lib/ai/utils";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { factCheckArticle, type FactCheckReport } from "@/lib/ai/fact-check";
import { scoreArticle } from "@/lib/seo/scoring";
import { scoreCitationReadiness } from "@/lib/seo/aeo-scoring";
import { recordSpend, anthropicCost } from "@/lib/billing/spend";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { recordOverageArticle } from "@/lib/billing/overage";
import { setSpendReporter } from "@/lib/seo/client";
import { anthropicModel } from "@/lib/ai/models";
import { embedYouTubeVideos } from "@/lib/ai/video-embedder";
import { generateImage } from "@/lib/ai/image-generator";
import { uploadImageBuffer } from "@/lib/storage/images";
import { fetchLinkTargets, resolveInternalLinks } from "@/lib/seo/link-resolver";
import { verifyOutboundLinks, type LinkCheck } from "@/lib/seo/link-check";
import { gatherArticleResearch, type ArticleResearch } from "@/lib/seo/research";
import { fetchKeywordFacts } from "@/lib/seo/keywords";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { getLocale } from "@/lib/seo/locales";
import type { ArticleBrief, VoiceRules } from "@/lib/ai/types";
import { classifyKeyword, targetWordCountFor } from "@/lib/keywords/taxonomy";
import { parseStoredQuestions } from "@/lib/keywords/questions";
import { e2eStubsEnabled, stubGenerateArticle } from "@/lib/e2e/stubs";

export interface GenerateArticleOptions {
  supabase: SupabaseClient;
  workspaceId: string;
  keyword: string;
  /**
   * The keyword row this draft is for, when the caller knows it (a planned
   * calendar entry does). Without it the row is looked up by term, which is
   * right in every case but a workspace tracking the same term twice.
   */
  keywordId?: string;
  title?: string;
  /** Marks the draft as machine-chosen, so a reviewer can tell. */
  autonomous?: boolean;
  /**
   * The recommendation this draft came from, when it came from the autonomous
   * queue. Persisted so the reviewer can see why the machine chose this term
   * without re-deriving it, which would answer a different question: keyword
   * data moves, so a recomputed reason is the reason it would be picked NOW,
   * not the reason it was picked then. Omitted for manual generation.
   */
  selection?: {
    reasons: string[];
    score: number;
    difficulty: number | null;
    volume: number | null;
  };
  /**
   * Generate *into* an article that already exists, rather than creating one.
   *
   * The editor's "Ask AI" is writing the draft the user has open, so it passes
   * the id it is showing. Without this the run would insert a second article
   * and leave the open one empty - and for a content-refresh draft that is
   * worse than untidy: its `replaces_article_id` link to the archived original
   * is the only record of what the rewrite replaces, and a fresh row does not
   * carry it.
   */
  articleId?: string;
  /**
   * Charge this account's monthly quota instead of the workspace's own.
   *
   * Only the exchange uses it: a writer supplies an article for somebody
   * else's blog, so the row belongs to the publisher's workspace while the
   * cost belongs to the writer who commissioned it. Without this the publisher
   * would pay quota for an article they did not ask to have written.
   *
   * Needs a client that can see the billed account, which in practice means
   * the service role; a caller's cookie client cannot read another tenant's
   * workspaces and would compute an empty quota.
   */
  billToAgencyId?: string;
  /**
   * Who is asking, for the quota check. `null` means "nobody - there is no
   * session here", which is what a cron is.
   *
   * Same three-state contract as `getQuota`'s own `userEmail`: omitted means
   * "go and resolve the signed-in user", `null` means "do not bother, there
   * isn't one". Threading it rather than inferring it from `autonomous`,
   * because `autonomous` does not mean sessionless - onboarding and the
   * exchange both set it from inside a user's request, and handing them the
   * cron's answer would grant an operator bypass to whoever happened to be
   * onboarding.
   *
   * Getting this wrong is silent: the two calls simply disagree, and the
   * disagreement only surfaces as an "error" in a cron summary.
   */
  callerEmail?: string | null;
  /** Streaming hook. Omitted by the unattended path. */
  onChunk?: (html: string) => void;
  /** Called once research completes, before the model starts. */
  onResearch?: (research: ArticleResearch) => void;
}

export interface GenerateArticleResult {
  articleId: string;
  jobId: string;
  title: string;
  wordCount: number;
  tokensUsed: number;
  research: ArticleResearch;
  factCheck: FactCheckReport;
}

export async function generateArticle(
  options: GenerateArticleOptions,
): Promise<GenerateArticleResult> {
  // E2E_STUBS: a fixture draft through the same rows and the same review gate (lib/e2e/stubs.ts).
  if (e2eStubsEnabled()) return stubGenerateArticle(options);
  const { supabase, workspaceId, keyword, keywordId, title, autonomous, onChunk, onResearch,
    selection, articleId, billToAgencyId, callerEmail,
  } = options;

  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id, domain, ai_provider, ai_model, agency_id, language, brand_style, location_code")
    .eq("id", workspaceId)
    .single();

  if (wsError || !workspace) throw new Error("Workspace not found");

  /**
   * The quota gate, in the one place both callers pass through.
   *
   * The pricing page sells "100 articles / month included, €0.60 per
   * additional" and until this check nothing counted or charged either half.
   * Manual generation past the included volume proceeds and bills the
   * published overage. Autonomous generation stops at the included volume:
   * a cron must never be the thing that spends a customer's money.
   */
  const billedAgencyId = billToAgencyId ?? workspace.agency_id;
  // `callerEmail` is forwarded, not defaulted. Omitting it here asked getQuota
  // to resolve a session, and on the cron's service client that resolves to
  // nobody *while still counting as a session* - so the operator's own agency
  // came back "no-plan, free draft used" from this call and "operator,
  // unlimited" from the identical call in cron/generate, and every run logged
  // an error the cron route had gone out of its way to call a skip.
  const quota = await getQuota(supabase, billedAgencyId, callerEmail);
  if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
    if (quota.reason === "no-plan" || autonomous) {
      throw new Error(quotaExceededMessage(quota));
    }
    await recordOverageArticle(supabase, billedAgencyId, quota);
  }

  const { data: voiceProfile } = await supabase
    .from("voice_profiles")
    .select("rules")
    .eq("workspace_id", workspaceId)
    .single();

  const voiceRules = (voiceProfile?.rules as VoiceRules) ?? undefined;

  // Output preferences from onboarding. Absent rows (older workspaces, or an
  // install that has not run 049) fall through to the prompt's defaults.
  const { data: outputRow } = await supabase
    .from("workspace_output_settings")
    .select("tone, internal_links, table_of_contents, call_to_action, first_person, mention_similar_products, global_article_prompt")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const output = outputRow
    ? {
        tone: outputRow.tone as string,
        internalLinks: outputRow.internal_links as number,
        tableOfContents: outputRow.table_of_contents as boolean,
        callToAction: outputRow.call_to_action as boolean,
        firstPerson: outputRow.first_person as boolean,
        mentionSimilarProducts: outputRow.mention_similar_products as boolean,
        customInstructions: outputRow.global_article_prompt as string | null,
      }
    : undefined;

  // The keyword as an object: what the owner said about this article in
  // particular. By id when the plan supplies one, else by term within the
  // workspace. Absent for a term typed straight into the modal, which is fine:
  // the draft then carries no brief rather than a guessed one.
  type KeywordRow = {
    id: string;
    term: string;
    instructions: string | null;
    quality_questions: unknown;
    article_type: string | null;
    article_subtype: string | null;
    expected_length: string | null;
  };
  let keywordRow: KeywordRow | null = null;
  {
    let q = supabase
      .from("keywords")
      .select("id, term, instructions, quality_questions, article_type, article_subtype, expected_length")
      .eq("workspace_id", workspaceId);
    q = keywordId ? q.eq("id", keywordId) : q.ilike("term", keyword.replace(/[\\%_]/g, (c) => `\\${c}`));
    const { data } = await q.limit(1).maybeSingle();
    keywordRow = (data as KeywordRow | null) ?? null;
  }

  const slug = (title || keyword)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  // Two shapes of run. The "new article" callers - the modal and the cron -
  // have no row yet and get one. The editor is generating into a draft the user
  // already has open and must write to that row.
  let article: { id: string };
  // The status the article carried before this run, so a failure can put it
  // back. Only set on the in-place path; `articleId` itself, not this, is what
  // the failure paths below key off, so a schema change to `status` can never
  // turn "restore it" into "delete it".
  let previousStatus: string | null = null;

  if (articleId) {
    const { data: existing, error: existingError } = await supabase
      .from("articles")
      .select("id, status")
      .eq("id", articleId)
      // Scoped to the workspace the caller was authorised for, so an id
      // belonging to another agency cannot be written through.
      .eq("workspace_id", workspaceId)
      .single();

    if (existingError || !existing) {
      throw new Error("Article not found in this workspace");
    }

    article = { id: existing.id };
    previousStatus = existing.status as string;

    // Same signal the insert path sets, so the list shows this article as
    // being written while the run is open.
    await supabase
      .from("articles")
      .update({ status: "drafting", updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    const { data: created, error: articleError } = await supabase
      .from("articles")
      .insert({
        workspace_id: workspaceId,
        title: title || keyword,
        slug,
        keyword,
        keyword_id: keywordRow?.id ?? null,
        status: "drafting",
        ai_provider: workspace.ai_provider || "claude",
        generated_autonomously: autonomous ?? false,
      })
      .select("id")
      .single();

    if (articleError || !created) {
      throw new Error(`Failed to create article: ${articleError?.message}`);
    }

    article = created;
  }

  const { data: job, error: jobError } = await supabase
    .from("generation_jobs")
    .insert({
      workspace_id: workspaceId,
      article_id: article.id,
      status: "running",
      ai_provider: workspace.ai_provider || "claude",
      prompt_config: { keyword, title, voiceRules, autonomous: autonomous ?? false },
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    // Only a row this run created may be deleted here. Generating into an
    // article the user already had, this line would destroy their draft
    // because a job row failed to insert.
    if (articleId) {
      await supabase
        .from("articles")
        .update({
          status: previousStatus ?? "draft",
          updated_at: new Date().toISOString(),
        })
        .eq("id", article.id);
    } else {
      await supabase.from("articles").delete().eq("id", article.id);
    }
    throw new Error(`Failed to create generation job: ${jobError?.message}`);
  }

  try {
    const locale = getLocale(workspace.language ?? "en");

    // Attribute every DataForSEO call this run makes to this article, then
    // detach: the reporter is module-level, so leaving it set would bill a
    // later run's calls to this article.
    setSpendReporter(({ operation, costUsd }) => {
      void recordSpend(supabase, {
        provider: "dataforseo",
        operation,
        costUsd,
        workspaceId,
        articleId: article.id,
        runId: job.id,
      });
    });

    const research = await gatherArticleResearch({
      keyword,
      locale: workspace.language ?? "en",
      supabase,
      workspaceId,
    });
    onResearch?.(research);

    /**
     * Volume and difficulty for the keyword itself.
     *
     * The cron passes these in `selection` because the picker already paid for
     * them. A keyword typed into the "New article" modal never went through
     * discovery, so the article stored null for both and the editor's dials
     * read as dashes on a piece the machine had just spent real money
     * researching. One overview call fills both, and the keyword row is
     * upserted so the Keywords page agrees with the article.
     *
     * Best-effort on purpose: enrichment must never take the draft down with
     * it, and null remains the honest value when the lookup fails.
     */
    let facts: { volume: number | null; difficulty: number | null } = {
      volume: selection?.volume ?? null,
      difficulty: selection?.difficulty ?? null,
    };
    if (facts.volume === null && facts.difficulty === null && hasDataForSEOCredentials()) {
      try {
        const map = await fetchKeywordFacts([keyword], {
          languageCode: workspace.language ?? "en",
          locationCode: workspace.location_code ?? 2840,
        });
        facts = map.get(keyword.toLowerCase()) ?? facts;
        await supabase.from("keywords").upsert(
          {
            workspace_id: workspaceId,
            term: keyword,
            volume: facts.volume,
            difficulty: facts.difficulty,
            intent: research.intent.intent,
            status: "planned",
            // Provenance only for a row this call creates. An existing row
            // already knows where it came from and must keep saying so.
            ...(keywordRow ? {} : { source_type: "manual" }),
          },
          { onConflict: "workspace_id,term" },
        );
      } catch (err) {
        console.warn("[generate] keyword facts lookup failed:", err);
      }
    }

    const provider = resolveProvider(workspace.ai_provider, workspace.ai_model);
    // What the draft may link to: this site's live articles, fetched once and
    // handed both to the prompt and to the resolver below. They used to read
    // different sets (the prompt any sibling with content, the resolver only
    // live rows), so the writer linked to drafts and every placeholder came
    // back unresolved. One list, two readers, no disagreement.
    const linkTargets = await fetchLinkTargets(supabase, workspaceId, article.id, { keyword });

    // The brief: shape, length, instructions and answered questions. Shape
    // falls back to the rule-based classification so every draft carries one,
    // and only answered questions are passed; an unanswered question is not a
    // fact about the business.
    const shape =
      keywordRow?.article_type && keywordRow.article_subtype
        ? { article_type: keywordRow.article_type, article_subtype: keywordRow.article_subtype }
        : classifyKeyword(keyword, research.intent.intent);
    const answers = parseStoredQuestions(keywordRow?.quality_questions)
      .filter((q): q is typeof q & { answer: string } => Boolean(q.answer))
      .map((q) => ({ question: q.question, answer: q.answer }));
    const expectedLength = keywordRow?.expected_length ?? "auto";
    const brief: ArticleBrief = {
      instructions: keywordRow?.instructions ?? null,
      answers,
      articleType: shape.article_type,
      articleSubtype: shape.article_subtype,
      expectedLength,
    };
    const targetWordCount = targetWordCountFor(expectedLength, research.recommendedWordCount);

    const generator = provider.streamArticle({
      keyword,
      title,
      voiceRules,
      language: locale.label,
      research,
      internalLinkTargets: linkTargets
        .slice(0, 20)
        .map((t) => ({ title: t.title, keyword: t.keyword })),
      output,
      brief,
    });

    let articleResult;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        articleResult = next.value;
        break;
      }
      onChunk?.(next.value);
    }
    if (!articleResult) throw new Error("Generator ended without returning a result");

    // Deterministic first: the prompt bans em dashes and the model uses them
    // anyway, so the ban is enforced here where it cannot be ignored.
    let processedHtml = stripAiTypography(articleResult.html);

    /**
     * Apply an optional enhancement, and keep the original unless the result is
     * plausibly better.
     *
     * Both steps below assigned straight back into `processedHtml`, and their
     * try/catch only guarded a throw. A step that *returned* empty therefore
     * wiped the article, and everything downstream faithfully processed
     * nothing: fact check "clean" because there were no claims, SEO 0, an empty
     * Tiptap doc, and a stored article titled "Untitled" after 12,529 tokens
     * had been paid for. Observed on 2026-08-30.
     *
     * These steps embed a video and resolve link placeholders. Neither can
     * legitimately shrink an article to nothing, so a much shorter result is
     * a bug in the step, not an edit.
     */
    async function enhance(
      label: string,
      step: (html: string) => Promise<string>,
    ): Promise<void> {
      try {
        const next = await step(processedHtml);
        if (!next || next.trim().length < processedHtml.trim().length / 2) {
          console.warn(
            `[generate] ${label} returned ${next ? "a suspiciously short result" : "nothing"}; keeping the original HTML`,
          );
          return;
        }
        processedHtml = next;
      } catch (err) {
        console.warn(`[generate] ${label} failed:`, err);
      }
    }

    await enhance("video embed", (html) => embedYouTubeVideos(html, keyword));
    await enhance("internal links", async (html) => resolveInternalLinks(html, linkTargets));

    // Open every outbound link once. The brief asks for real URLs and a model
    // produces plausible ones; a 404 is unwrapped to its text and everything
    // else is recorded so the audit tab can say what answered. No API cost,
    // bounded fetch time. Runs through `enhance` for the same reason the two
    // steps above do: a step that returns nothing must not wipe the article.
    let linkChecks: LinkCheck[] | null = null;
    await enhance("outbound link check", async (html) => {
      const verified = await verifyOutboundLinks(html, workspace.domain);
      linkChecks = verified.checks;
      return verified.html;
    });

    setSpendReporter(null);

    const model = anthropicModel("content");
    await recordSpend(supabase, {
      provider: "anthropic",
      operation: model,
      costUsd: anthropicCost(
        model,
        articleResult.inputTokens ?? 0,
        articleResult.outputTokens ?? articleResult.tokensUsed,
      ),
      inputTokens: articleResult.inputTokens ?? null,
      outputTokens: articleResult.outputTokens ?? articleResult.tokensUsed,
      workspaceId,
      articleId: article.id,
      runId: job.id,
    });

    const factCheck = factCheckArticle(processedHtml, research);

    // `scoreArticle` and its seven on-page checks have existed all along, but
    // nothing ran them at generation: only the manual `scoreArticleSeo` action
    // did. So every fresh draft opened with a hard 0 in the ring and "Not
    // scored / Generate content to score" beside it, on an article that had
    // just been generated. Scoring is pure and local, so there is no reason to
    // make a human press a button for it.
    // Both scorers take the domain so a link to the site's own pages counts
    // as internal and nothing else does. Without it a HubSpot citation passed
    // the internal-link check and a link to a sibling article counted as an
    // outbound source.
    const seo = scoreArticle(processedHtml, keyword, {
      metaDescription: articleResult.metaDescription,
      siteDomain: workspace.domain,
      // The length the prompt wrote to: the owner's band when they chose one,
      // else what the SERP asked for. A flat 1,500 punished every
      // transactional piece the research had correctly kept short.
      targetWordCount,
      title: articleResult.title,
    });
    // The half that matches what this product actually claims: not "will it
    // rank" but "will an answer engine quote it".
    const aeo = scoreCitationReadiness(processedHtml, keyword, { siteDomain: workspace.domain });
    // The domain tells the converter which links are the site's own, so those
    // are stored followed and same-tab rather than nofollow like a citation.
    const tiptapContent = htmlToTiptapJson(processedHtml, { siteDomain: workspace.domain });

    // A featured image, when a provider is configured for one.
    //
    // This used to fail into `catch {}`, so "no key configured" and "the image
    // API returned an error" both looked exactly like "no image", and every
    // article in the database had none without anything ever saying so
    // (measured 2026-09-03: 15 of 15). The generation still must not fail over
    // an image, so the outcome is logged rather than thrown.
    let featuredImageUrl: string | null = null;
    if (!process.env.OPENAI_API_KEY) {
      console.warn(
        "[generate] no featured image: OPENAI_API_KEY is not set, so image generation is skipped for every article",
      );
    }
    try {
      if (process.env.OPENAI_API_KEY) {
        const imageResult = await generateImage(
          articleResult.title,
          keyword,
          workspace.brand_style as Record<string, unknown> | undefined,
        );
        featuredImageUrl = await uploadImageBuffer(
          supabase,
          imageResult.data,
          `${workspaceId}/${article.id}.${imageResult.extension}`,
          imageResult.contentType,
        );
      }
    } catch (err) {
      console.warn(
        "[generate] featured image failed:",
        err instanceof Error ? err.message : err,
      );
    }

    const { error: saveError } = await supabase
      .from("articles")
      .update({
        content: tiptapContent,
        title: articleResult.title,
        meta_description: articleResult.metaDescription,
        word_count: articleResult.wordCount,
        featured_image_url: featuredImageUrl,
        research,
        fact_checks: factCheck,
        link_checks: linkChecks,
        search_intent: research.intent.intent,
        seo_score: seo.score,
        seo_checks: seo.checks,
        aeo_score: aeo.score,
        aeo_checks: aeo.checks,
        fact_check_verdict: factCheck.verdict,
        // Null for manual generation; the reviewer then sees "you picked this"
        // rather than a fabricated rationale.
        selection_reasons: selection?.reasons ?? null,
        selection_score: selection?.score ?? null,
        // What the writer was told, frozen. Editing the keyword later must
        // not rewrite what this draft was written from.
        keyword_id: keywordRow?.id ?? null,
        article_type: shape.article_type,
        article_subtype: shape.article_subtype,
        expected_length: expectedLength,
        instructions_snapshot: {
          instructions: brief.instructions,
          answers: brief.answers,
          targetWordCount: targetWordCount ?? null,
          capturedAt: new Date().toISOString(),
        },
        // Deliberately not `?? 0`. Unmeasured difficulty is not zero difficulty.
        keyword_difficulty: facts.difficulty,
        // Same reasoning, and the same column the picker already knew: this
        // defaulted to 0, so every article listed "0 searches/mo" for a term
        // chosen precisely because it had volume.
        volume: facts.volume,
        // Always `review`, never `approved` or `scheduled`. The approval gate is
        // the point: a machine may write, a human decides whether it ships.
        status: "review",
        updated_at: new Date().toISOString(),
      })
      .eq("id", article.id);

    // The most expensive write in the product: research, a full model call and
    // a fact check have already been paid for by the time we get here. This
    // update used to discard its error, so a single missing column - migration
    // 022 not yet applied, say - lost the whole article while the cron reported
    // "generated, 2,340 words, fact check clean" and the job row said completed.
    // Observed exactly that on 2026-08-30.
    if (saveError) {
      await supabase
        .from("generation_jobs")
        .update({
          status: "error",
          error: `article save failed: ${saveError.message}`,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      throw new Error(`Could not save the generated article: ${saveError.message}`);
    }

    await supabase
      .from("generation_jobs")
      .update({
        status: "completed",
        tokens_used: articleResult.tokensUsed,
        result: { wordCount: articleResult.wordCount, title: articleResult.title },
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      articleId: article.id,
      jobId: job.id,
      title: articleResult.title,
      wordCount: articleResult.wordCount,
      tokensUsed: articleResult.tokensUsed,
      research,
      factCheck,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown generation error";

    // A run that created the row marks it errored - the row exists only
    // because of this run. A run that was writing into an article the user
    // already had puts the status back where it found it: a failed generation
    // should not strand a good draft in a state the UI reads as broken. The
    // content is untouched either way, since it is only written on success.
    await supabase
      .from("articles")
      .update({
        status: articleId ? (previousStatus ?? "draft") : "error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", article.id);

    await supabase
      .from("generation_jobs")
      .update({ status: "failed", error: message, completed_at: new Date().toISOString() })
      .eq("id", job.id);

    throw err;
  }
}
