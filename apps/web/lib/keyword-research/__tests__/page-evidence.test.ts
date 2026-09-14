import {beforeEach,expect,it,vi} from "vitest";
const {fetch,budget}=vi.hoisted(()=>({fetch:vi.fn(),budget:vi.fn()}));
vi.mock("@/lib/audit/lenient-fetch",()=>({fetchSite:fetch}));
vi.mock("@/lib/seo/request-context",()=>({currentResearchBudget:budget}));
import {readPageExtract,readPageExtractOutcome} from "../page-evidence";
beforeEach(()=>vi.resetAllMocks());
it("reads useful body evidence beyond large scripts and retains observed navigation pricing links",async()=>{
  const body="Collective scheduling checks participants' availability. ".repeat(8);
  fetch.mockResolvedValue(new Response(`<html><head><title>Calendar</title><script>${"x".repeat(800000)}</script></head><body><nav><a href="/pricing">Pricing</a><a href="/login">Login</a></nav><main><h1>Team calendar</h1><p>${body}</p></main><footer>Unrelated footer</footer></body></html>`));
  const result=await readPageExtract("https://calendar.test",9000,{includeLinks:true});
  expect(result?.text).toContain(body.trim());expect(result?.text).not.toContain("Unrelated footer");
  expect(result?.links).toEqual([{url:"https://calendar.test/pricing",label:"Pricing"}]);
});
it("keeps failed or insufficient retrieval unknown",async()=>{
  fetch.mockResolvedValue(new Response("not found",{status:404}));expect(await readPageExtract("https://calendar.test/missing")).toBeNull();
  fetch.mockResolvedValue(new Response("<main>short</main>"));expect(await readPageExtract("https://calendar.test")).toBeNull();
});
it("retains pricing after a large product menu while keeping eighty candidates",async()=>{
  const menu=Array.from({length:100},(_,i)=>`<a href="/feature-${i}">Feature ${i}</a>`).join("");
  fetch.mockResolvedValue(new Response(`<nav>${menu}<a href="/pricing">Pricing</a></nav><main><p>${"Product capabilities. ".repeat(20)}</p></main>`));
  const page=await readPageExtract("https://vendor.test/",9000,{includeLinks:true});
  expect(page?.links).toHaveLength(80);expect(page?.links?.[0]).toEqual({url:"https://vendor.test/pricing",label:"Pricing"});
});
it("retains article vendor references ahead of a large navigation menu",async()=>{
  const menu=Array.from({length:450},(_,i)=>`<a href="/feature-${i}">Feature ${i}</a>`).join("");
  fetch.mockResolvedValue(new Response(`<nav>${menu}<a href="/pricing">Pricing</a></nav><main><p>${"Compare the vendors on the same criteria. ".repeat(20)}</p><a href="https://other-vendor.test/">Other vendor</a></main>`));
  const page=await readPageExtract("https://publisher.test/",9000,{includeLinks:true});
  expect(page?.links).toContainEqual({url:"https://other-vendor.test/",label:"Other vendor"});
  expect(page?.links?.length).toBeLessThanOrEqual(80);
});
it("does not treat a binary document as readable source evidence",async()=>{
  fetch.mockResolvedValue(new Response("%PDF-1.7 " + "binary bytes ".repeat(100),{headers:{"content-type":"application/pdf"}}));
  expect(await readPageExtract("https://vendor.test/manual.pdf")).toBeNull();
  fetch.mockResolvedValue(new Response("%PDF-1.7 " + "binary bytes ".repeat(100)));
  expect(await readPageExtract("https://vendor.test/manual")).toBeNull();
});
it("preserves plan boundaries and retrieves observed footer care links beyond a product menu",async()=>{
 const menu=Array.from({length:500},(_,i)=>`<a href="/shoe-${i}">Shoe ${i}</a>`).join("");
 fetch.mockResolvedValue(new Response(`<nav>${menu}</nav><main><h2>Starter</h2><p>${"Basic features. ".repeat(8)}</p><h2>Standard</h2><p>Marketing automation.</p></main><footer><a href="/care-guide">Product care guide</a><a href="/privacy">Privacy</a></footer>`));
 const page=await readPageExtract("https://vendor.test",9000,{includeLinks:true});
 expect(page?.text).toContain("\nStandard\nMarketing automation.");
 expect(page?.links).toContainEqual({url:"https://vendor.test/care-guide",label:"Product care guide"});
 expect(page?.links).not.toContainEqual({url:"https://vendor.test/privacy",label:"Privacy"});
});

it("parses multiline frontend attributes before excerpting actual pricing evidence",async()=>{
  // Both the main landmark and its cards contain literal > inside quoted
  // attributes. Splitting raw markup into lines exposed this code as evidence.
  const state="subscribers > 1000 ? 'standard' : 'starter';\n".repeat(400);
  fetch.mockResolvedValue(new Response(`<html><head><title>Plans &amp; prices</title></head><body>
    <main x-data="${state}" data-preview="<a href='https://fake.test'>Fake pricing</a>">
      <h1 x-show="subscribers > 0">Compare plans</h1>
      <section x-bind:class="subscribers > 1000 ? 'featured' : ''"><h2>Starter</h2><p>$10 per month, billed monthly.</p><p>Send newsletters and manage subscriber groups.</p></section>
      <section><h2>Standard</h2><p>$20 per month, billed monthly.</p><p>Includes multi-step automation and advanced audience segmentation.</p></section>
      <a
        x-show="subscribers > 0"
        href="/help?topic=plans&amp;lang=en#details">Plan &amp; billing help</a>
    </main></body></html>`,{headers:{"content-type":"text/html"}}));
  const result=await readPageExtractOutcome("https://vendor.test/",450,{includeLinks:true});
  expect(result.status).toBe("success");
  expect(result.diagnostics).toMatchObject({strategy:"main",bodyTruncated:false,excerptTruncated:false});
  expect(result.page?.title).toBe("Plans & prices");
  expect(result.page?.headings).toEqual(["Compare plans","Starter","Standard"]);
  expect(result.page?.text).toContain("Starter\n$10 per month, billed monthly.");
  expect(result.page?.text).toContain("Standard\n$20 per month, billed monthly.");
  expect(result.page?.text).not.toMatch(/subscribers|x-data|featured|Fake pricing/);
  expect(result.page?.links).toEqual([{url:"https://vendor.test/help?topic=plans&lang=en",label:"Plan & billing help"}]);
});

it("recovers visible pricing after a self-closing tag-manager iframe inside head noscript",async()=>{
  const pricing="The Starter plan starts at $10 per month for email campaigns. The Standard plan includes marketing automation and advanced reporting. Prices depend on the number of emails sent each month.";
  fetch.mockResolvedValue(new Response(`<html><head><title>Pricing</title>
    <noscript><iframe src="https://tag-manager.test/ns.html?id=site" height="0" width="0" style="display:none;visibility:hidden" /></noscript>
    <script>window.trackingOnly = "Never source this tracking script";</script>
    </head><body><nav><a href="/pricing">Pricing</a></nav><main><h1>Plans for your business</h1><p>${pricing}</p><a href="/help/plans">Plan help</a>
    <noscript><p>Hidden fallback content must not become product evidence.</p></noscript>
    <div hidden>Secret campaign implementation detail.</div></main></body></html>`,{headers:{"content-type":"text/html"}}));
  const result=await readPageExtractOutcome("https://vendor.test/pricing",9000,{includeLinks:true});
  expect(result).toMatchObject({status:"success",diagnostics:{strategy:"main",bodyTruncated:false}});
  expect(result.page?.text).toContain(pricing);
  expect(result.page?.headings).toEqual(["Plans for your business"]);
  expect(result.page?.links).toContainEqual({url:"https://vendor.test/help/plans",label:"Plan help"});
  expect(result.page?.text).not.toMatch(/tracking|fallback|Secret/);
});

it("does not mistake document layout classes for a navigation-only body",async()=>{
  const article="Choose everyday shoes with a comfortable fit, suitable cushioning and a breathable upper. Compare the manufacturer's sizing and care instructions before deciding which material and size to choose.";
  fetch.mockResolvedValue(new Response(`<html class="with-sidebar"><body class="standardnavigation-site-navigation logo-left-with-search-nav-variation default">
    <nav>Navigation labels do not answer the article.</nav><div id="app-root"><main id="main-content"><article><h1>Choosing everyday shoes</h1><p>${article}</p>
    <div class="newsletter-popup"><p>Subscribe now. This is not article evidence.</p></div>
    <div aria-hidden="true">Hidden article controls.</div></article></main></div>
    <footer>Footer navigation.</footer></body></html>`,{headers:{"content-type":"text/html"}}));
  const result=await readPageExtractOutcome("https://publisher.test/article",9000);
  expect(result).toMatchObject({status:"success",diagnostics:{strategy:"main"}});
  expect(result.page?.text).toContain(article);
  expect(result.page?.text).not.toMatch(/Navigation labels|Subscribe now|Hidden article|Footer navigation/);
});

it("keeps pricing table columns and nested card text associated with their rows",async()=>{
  fetch.mockResolvedValue(new Response(`<main><h1>Plan comparison</h1><p>These are monthly subscription prices for the same billing period and subscriber count.</p>
    <table><tr><th>Plan</th><th>Starter</th><th>Standard</th></tr>
    <tr><th>Monthly price</th><td><div>$10</div><span>per month</span></td><td><div>$20</div><span>per month</span></td></tr>
    <tr><th>Automation</th><td>Single-step</td><td>Multi-step</td></tr></table>
  </main>`));
  const page=await readPageExtract("https://vendor.test/pricing");
  expect(page?.text).toContain("Plan | Starter | Standard\nMonthly price | $10 per month | $20 per month\nAutomation | Single-step | Multi-step");
});

it("measures useful extraction before the excerpt cap and records a bounded body read",async()=>{
  const useful="Starter costs $10 per month on monthly billing. ".repeat(10);
  fetch.mockResolvedValue(new Response(`<main><p>${useful}</p></main><script>${"x".repeat(2_100_000)}</script><p>Outside the read budget</p>`));
  const result=await readPageExtractOutcome("https://vendor.test/pricing",150);
  expect(result.status).toBe("success");
  expect(result.diagnostics).toMatchObject({bytesRead:2_000_000,bodyTruncated:true,excerptTruncated:true,extractedChars:useful.trim().length});
  expect(result.page?.text).toHaveLength(150);
  expect(result.page?.text).not.toMatch(/Outside|xxx/);
});

it("does not turn an attribute cut off by the byte limit into source text",async()=>{
  fetch.mockResolvedValue(new Response(`<main x-data="${"frontendState > 10\n".repeat(130_000)}"><p>${"Pricing content. ".repeat(20)}</p></main>`));
  const result=await readPageExtractOutcome("https://vendor.test/pricing",9000);
  expect(result).toMatchObject({status:"insufficient",reason:"short-extraction",diagnostics:{bodyTruncated:true,bytesRead:2_000_000,extractedChars:0}});
  expect(result.page?.text).toBe("");
});

it("retains short routing links without approving them as substantive evidence",async()=>{
  fetch.mockResolvedValue(new Response('<main><h1>Get support</h1><a href=/help/customers>Customer help</a><a href=/help/business>Business help</a></main>'));
  const result=await readPageExtractOutcome("https://vendor.test/support",9000,{includeLinks:true});
  expect(result).toMatchObject({status:"insufficient",reason:"short-extraction",diagnostics:{strategy:"main",excerptTruncated:false}});
  expect(result.page?.links).toEqual([{url:"https://vendor.test/help/customers",label:"Customer help"},{url:"https://vendor.test/help/business",label:"Business help"}]);
  expect(await readPageExtract("https://vendor.test/support")).toBeNull();
});

it("distinguishes navigation-only pages and excludes hidden or scripted links",async()=>{
  fetch.mockResolvedValue(new Response(`<body><nav><a href=/help>Help</a><a href=/pricing>Pricing</a></nav>
    <div hidden><a href=/private-instructions>Hidden instructions</a></div>
    <script>const content = '<a href="https://fake.test/">Fake source</a>';</script>
  </body>`));
  const result=await readPageExtractOutcome("https://vendor.test/",9000,{includeLinks:true});
  expect(result).toMatchObject({status:"insufficient",reason:"navigation-only"});
  expect(result.page?.text).toBe("");
  expect(result.page?.links).toEqual([{url:"https://vendor.test/help",label:"Help"},{url:"https://vendor.test/pricing",label:"Pricing"}]);
});

it("retains retrieval failure causes instead of treating all missing evidence equally",async()=>{
  fetch.mockResolvedValueOnce(new Response("not found",{status:404}));
  expect(await readPageExtractOutcome("https://vendor.test/missing")).toMatchObject({status:"unavailable",reason:"http-error",diagnostics:{httpStatus:404,bytesRead:0}});
  fetch.mockResolvedValueOnce(new Response("binary",{headers:{"content-type":"application/pdf"}}));
  expect(await readPageExtractOutcome("https://vendor.test/manual.pdf")).toMatchObject({status:"unsupported",reason:"unsupported-content-type",diagnostics:{contentType:"application/pdf",bytesRead:0}});
  fetch.mockRejectedValueOnce(new DOMException("Request timed out","TimeoutError"));
  expect(await readPageExtractOutcome("https://vendor.test/slow")).toMatchObject({status:"unavailable",reason:"timeout"});
  fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  expect(await readPageExtractOutcome("https://vendor.test/offline")).toMatchObject({status:"unavailable",reason:"network-error"});
  fetch.mockResolvedValueOnce(new Response(null,{status:204}));
  expect(await readPageExtractOutcome("https://vendor.test/empty")).toMatchObject({status:"unavailable",reason:"empty-body"});
  const calls=fetch.mock.calls.length;
  budget.mockReturnValueOnce({deadline:Date.now()-1});
  expect(await readPageExtractOutcome("https://vendor.test/late")).toMatchObject({status:"unavailable",reason:"budget-exhausted"});
  expect(fetch).toHaveBeenCalledTimes(calls);
});

it("retains comparisons and line boundaries in actual plain text documents",async()=>{
  const text="The Starter plan is suitable when subscribers < 1000 and sends > 500.\nThe Standard plan includes multi-step automations and advanced segmentation.";
  fetch.mockResolvedValue(new Response(text,{headers:{"content-type":"text/plain"}}));
  const result=await readPageExtractOutcome("https://vendor.test/llms.txt");
  expect(result).toMatchObject({status:"success",page:{text},diagnostics:{strategy:"plain-text"}});
});
