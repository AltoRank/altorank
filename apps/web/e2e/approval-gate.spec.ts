import { test, expect } from "./fixtures/test";
import { admin, signIn } from "./fixtures/account";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { stubArticleHtml } from "@/lib/e2e/stubs";

/**
 * The one promise the product makes to every draft: a machine may write, a
 * person decides whether it ships. A draft in review has no publish control;
 * approving moves it to `approved`; and nothing along the way writes a
 * publish_log row.
 */
test.use({ accountShape: { workspaces: [{ domain: "gate.e2e.altorank.test", onboarded: true }] } });

test("a draft in review cannot be published before it is approved", async ({ page, account }) => {
  const ws = account.workspaces[0];
  const db = admin();
  const keyword = "content calendar template";
  const title = "Content Calendar Template: A Practical Guide";
  const html = stubArticleHtml(keyword, title);

  const { data: article, error } = await db
    .from("articles")
    .insert({
      workspace_id: ws.id,
      title,
      slug: "content-calendar-template",
      keyword,
      status: "review",
      content: htmlToTiptapJson(html, { siteDomain: ws.domain }),
      word_count: html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).length,
      generated_autonomously: true,
      ai_provider: "claude",
    })
    .select("id")
    .single();
  if (error || !article) throw new Error(`seed article: ${error?.message}`);

  await signIn(page, account.email, `/content/${article.id}`);
  await expect(page).toHaveURL(new RegExp(`/content/${article.id}$`));
  // Two headings carry the title: the page head and the article's own h1.
  await expect(page.getByRole("heading", { name: title }).first()).toBeVisible();

  // Before approval: approve is offered, publishing is not.
  const approve = page.getByRole("button", { name: "Approve for publishing" });
  await expect(approve).toBeVisible();
  await expect(page.getByRole("button", { name: /^Publish/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Publish/ })).toHaveCount(0);

  await approve.click();

  // After approval: the transition happened, and still nothing publishes by itself.
  await expect(page.getByText("Approved. Publish it yourself and paste the URL", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve for publishing" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Publish to/ })).toHaveCount(0);

  const { data: after } = await db
    .from("articles")
    .select("status, approved_by, approved_at, published_at")
    .eq("id", article.id)
    .single();
  expect(after?.status).toBe("approved");
  expect(after?.approved_by).toBe(account.userId);
  expect(after?.approved_at).not.toBeNull();
  expect(after?.published_at).toBeNull();

  const { count } = await db
    .from("publish_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", ws.id);
  expect(count).toBe(0);
});
