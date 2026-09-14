import {test,expect} from "./fixtures/test";
import {admin,signIn} from "./fixtures/account";

test("a withheld first draft returns to saved choices, survives reload and permits another topic",async({page,account})=>{
  const ws=account.workspaces[0],db=admin();
  await signIn(page,account.email);
  await page.getByRole("button",{name:"Plan my first articles"}).click();
  await expect(page.getByRole("heading",{name:"Choose your first article"})).toBeVisible({timeout:30000});
  const {data:run}=await db.from("onboarding_runs").select("id,planned").eq("workspace_id",ws.id).single();
  const first=run!.planned[0];
  for(const kind of ["material","incomplete"]) {
    const message=kind === "material" ? "This draft needs corrections" : "We couldn't finish the checks for this topic";
    const {error}=await db.from("keywords").update({instructions:`e2e:withhold-${kind}`}).eq("workspace_id",ws.id).eq("id",first.keywordId);
    expect(error).toBeNull();
    await page.getByRole("button",{name:"Write this article"}).first().click();
    await expect(page.getByRole("alert").filter({hasText:message})).toBeVisible({timeout:20000});
    await page.reload();
    await expect(page.getByRole("heading",{name:"Choose your first article"})).toBeVisible();
    await expect(page.getByRole("alert").filter({hasText:message})).toBeVisible();
    const {data:saved}=await db.from("onboarding_runs").select("id,status,article_id,planned").eq("workspace_id",ws.id).single();
    expect(saved).toMatchObject({id:run!.id,status:"awaiting_choice",article_id:null,planned:run!.planned});
    expect((await db.from("articles").select("id").eq("workspace_id",ws.id)).data).toHaveLength(0);
    expect((await db.from("accounts").select("free_drafts_used").eq("id",account.accountId).single()).data?.free_drafts_used).toBe(0);
  }
  await page.locator("summary").filter({hasText:run!.planned[1].term}).click();
  await page.getByRole("button",{name:"Write this article"}).nth(1).click();
  await expect(page.getByText(/Done\. \d+ articles? on the calendar and your first draft is in review\./)).toBeVisible({timeout:30000});
  const {data:completed}=await db.from("onboarding_runs").select("id,status,article_id").eq("workspace_id",ws.id).single();
  expect(completed).toMatchObject({id:run!.id,status:"done"});expect(completed?.article_id).toBeTruthy();
});
