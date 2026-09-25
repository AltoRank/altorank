/**
 * A language the locale contract does not describe is said out loud.
 *
 * Before the contract every module fell back to English without saying so:
 * English labels in the article, English patterns in the fact checker,
 * English bands in the scores. The rule now is that each module returns an
 * explicit "not checked" or leaves the element out. These use Portuguese
 * (a language the product sells in and the contract does not yet describe)
 * and Japanese (no spaces between words, so every word count is meaningless).
 */
import { describe, it, expect } from "vitest";
import { enrichArticle } from "@/lib/content/enrich";
import { addTableOfContents } from "@/lib/content/enrich/toc";
import { addCallToAction } from "@/lib/content/enrich/cta";
import { addSectionImages } from "@/lib/content/enrich/images";
import { renderVideoFigure } from "@/lib/content/enrich/video";
import { addInfographics, renderBarChart } from "@/lib/content/enrich/infographic";
import { applyFormat } from "@/lib/content/enrich/format";
import { factCheckArticle, approvalBlocker, autoApprovalBlocker } from "@/lib/ai/fact-check";
import { verifyCitedFigures } from "@/lib/seo/citation-check";
import { checkAltText } from "@/lib/ai/alt-text";
import { analyzeVoiceLocally } from "@/lib/voice/train";
import { scoreArticle } from "@/lib/seo/scoring";
import { scoreCitationReadiness } from "@/lib/seo/aeo-scoring";
import { auditArticle } from "@/lib/seo/article-audit";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { insertBacklinkIntoContent } from "@/lib/seo/exchange";
import { decideAutoApproval, type AutoApproveCandidate, type AutoApproveRule } from "@/lib/publishing/auto-approve";

const PT_LONG =
  "As pequenas empresas precisam de um site que carregue depressa e que diga logo o que oferecem. " +
  "Um visitante que não encontra o que procura em poucos segundos fecha a página e procura outra opção. " +
  "Por isso o menu, os títulos e o formulário de contacto devem responder à mesma pergunta: o que existe aqui e qual é o próximo passo? " +
  "Uma estrutura clara também ajuda a equipa de conteúdo, porque cada nova página segue o mesmo esqueleto. " +
  "A nossa equipa revê as páginas existentes antes de propor qualquer mudança visual ao cliente.";

const PT_ARTICLE = `<h1>Como melhorar a conversão de um site</h1>
<p>O design de um site é o planeamento da sua aparência e da sua usabilidade. Um bom design transforma visitantes em clientes.</p>
<h2>Porque é que a escolha do software importa?</h2><p>${PT_LONG} ${PT_LONG}</p>
<h2>Preços dos pacotes</h2><p>${PT_LONG}</p><ul><li>Básico: 1.500 €</li><li>Empresa: 4.500 €</li><li>Loja: 9.000 €</li></ul>
<h2>Como configurar o conteúdo</h2><p>${PT_LONG}</p><ol><li>Defina o objetivo.</li><li>Liste as páginas.</li><li>Crie o calendário.</li></ol>
<h2>Perguntas frequentes</h2><h3>Quanto tempo demora?</h3><p>Duas a três semanas para um site simples, menos se o conteúdo já estiver pronto.</p>
`;

/** Every English string the product has ever written into an article. */
const ENGLISH = [
  "Contents",
  "Learn more about",
  "published by",
  "Visit ",
  "Sketch",
  "illustrating",
  "Illustration of",
  "Watercolour",
  "Bar chart",
  "Figures from the text",
  "Video:",
  "on YouTube",
];

describe("unsupported language: nothing English is written into the article", () => {
  it("omits the table of contents, charts and call to action, and says so once", async () => {
    const { html, report } = await enrichArticle(PT_ARTICLE, {
      workspaceId: "ws",
      keyword: "design de site",
      title: "Conversão",
      domain: "acme-agency.example",
      businessName: "Acme",
      language: "pt",
      imageProducer: async (_b, i) => `https://cdn.example/${i}.webp`,
      maxImages: 1,
      videoSearch: async () => [{ videoId: "v1", title: "Configurar", channelTitle: "Acme TV" } as never],
      fetchTitle: async () => null,
    });
    for (const s of ENGLISH) expect(html, s).not.toContain(s);
    expect(report).toMatchObject({ toc: false, cta: false, infographics: 0, video: true, images: 1 });
    expect(report.language).toEqual({ code: "pt", name: "Portuguese", supported: false });
    expect(report.warnings).toEqual([
      "Portuguese: table of contents, charts, call to action not added, and section images carry no style label. " +
        "Their wording exists for English, Italian, Spanish, French, German and Turkish only.",
    ]);
    // The image alt is the article's own words: its heading and first sentence.
    expect(html).toMatch(/alt="Porque é que a escolha do software importa\?: As pequenas empresas/);
    expect(html).toContain("<figcaption>Configurar (Acme TV, YouTube)</figcaption>");
    expect(report.format?.directAnswerMissing).toBeNull();
    expect(report.format?.claimsBolded).toBe(0);
  });

  it("the backlink exchange puts the citation in parentheses, with no words round it", () => {
    const para = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const text = (lang: string) =>
      (insertBacklinkIntoContent(para("Primeiro parágrafo."), "https://acme-agency.example/guia", "guia de aplicações", 0, lang).content[0].content ?? [])
        .map((n) => n.text)
        .join("");
    expect(text("pt")).toBe("Primeiro parágrafo. (guia de aplicações)");
    for (const s of ENGLISH) expect(text("pt"), s).not.toContain(s);
    // English is what it always was.
    expect(text("en")).toBe("Primeiro parágrafo. Learn more about guia de aplicações.");
  });

  it("each step, called directly, refuses rather than defaulting to English", async () => {
    expect(addTableOfContents(PT_ARTICLE, { language: "pt" })).toEqual({ html: PT_ARTICLE, added: false });
    expect(addCallToAction("<p>x</p>", { domain: "acme-agency.example", language: "ja" }).added).toBe(false);
    expect(addInfographics(PT_ARTICLE, { language: "pt" }).added).toBe(0);
    expect(renderVideoFigure({ videoId: "v", title: "T", channelTitle: "C" } as never, "ja")).toContain("<figcaption>T (C, YouTube)</figcaption>");
    const chart = renderBarChart({ unit: "%", source: "s", data: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }, "ja");
    expect(chart).not.toMatch(/Bar chart|Figures from/);
    const images = await addSectionImages(PT_ARTICLE, { produce: async () => "https://cdn.example/x.webp", language: "pt", max: 1 });
    expect(images.html).not.toMatch(/Sketch|illustrating/);
    expect((await applyFormat(PT_ARTICLE, { language: "pt", fetchTitle: async () => null })).findings.directAnswerMissing).toBeNull();
  });
});

describe("unsupported language: checks say they did not run", () => {
  it("the fact checker returns `unchecked`, which a person may approve and auto-approve may not", async () => {
    const report = factCheckArticle("<p>Cerca de 20% das empresas não têm site, segundo o INE.</p>", undefined, "pt");
    expect(report).toMatchObject({
      verdict: "unchecked",
      claims: [],
      counts: { high: 0, medium: 0, low: 0, total: 0 },
      language: { code: "pt", name: "Portuguese", supported: false },
    });
    expect(report.summary).toContain("Not checked for Portuguese");
    expect(approvalBlocker(report)).toBeNull();
    expect(autoApprovalBlocker(report)).toBe(
      "not fact-checked: the checker does not read Portuguese, so a person has to approve it",
    );
    // Opening cited pages cannot turn it into a verdict it did not earn.
    expect(await verifyCitedFigures(report, { fetcher: async () => ({ status: 200, body: "x" }) })).toBe(report);
  });

  it("auto-approve holds it", () => {
    const rule: AutoApproveRule = {
      auto_approve: true,
      auto_approve_hold_hours: 0,
      auto_approve_min_seo: 0,
      auto_approve_min_aeo: null,
      auto_approve_set_by: "u1",
    };
    const candidate: AutoApproveCandidate = {
      id: "a1",
      status: "review",
      held_by: null,
      auto_approve_after: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      seo_score: 90,
      aeo_score: null,
      factCheckBlocker: autoApprovalBlocker(factCheckArticle("<p>20%</p>", undefined, "ja")),
      auditFailures: [],
      needsPlan: false,
      hasDestination: true,
      ruleOwnerIsMember: true,
    };
    expect(decideAutoApproval(rule, candidate, new Date("2026-09-25T00:00:00Z"))).toEqual({
      approve: false,
      reason: "not fact-checked: the checker does not read Japanese, so a person has to approve it",
    });
  });

  it("the SEO score leaves its three language checks unverified and scores the rest", () => {
    const result = scoreArticle(PT_ARTICLE, "design", { language: "pt" });
    const unverified = result.checks.filter((c) => c.unverified).map((c) => c.name);
    expect(unverified).toEqual(["keywordDensity", "wordCount", "readability"]);
    for (const c of result.checks.filter((c) => c.unverified)) {
      expect(c.note).toBe("Not checked for Portuguese: this check reads English, Italian, Spanish, French, German and Turkish only.");
    }
    expect(result.score).toEqual(expect.any(Number));
  });

  it("the AEO score is null, and its structural checks still report", () => {
    const result = scoreCitationReadiness(PT_ARTICLE, "design", { language: "ja" });
    expect(result.score).toBeNull();
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    for (const name of ["answerFirst", "definitionBlock", "quotableStatistics", "sourcedClaims", "scannableStructure", "summaryBox"]) {
      expect(byName[name]).toMatchObject({ unverified: true, note: expect.stringContaining("Not checked for Japanese") });
    }
    expect(byName.questionHeadings.unverified).toBeUndefined();
    expect(byName.comparisonTable.unverified).toBeUndefined();
  });

  it("the audit reports prose items as info, never as a pass", () => {
    const html = `${PT_ARTICLE}<p>Estudos mostram que 20% dos clientes desistem. <a href="https://data.example/r">fonte</a></p>`;
    const items = Object.fromEntries(auditArticle({ html, keyword: "design", language: "pt" }).items.map((i) => [i.id, i]));
    for (const id of ["unsourced-figures", "named-sources", "hollow-evidence", "first-hand"]) {
      expect(items[id], id).toMatchObject({ status: "info", detail: expect.stringContaining("Not checked for Portuguese") });
    }
    expect(items["anchor-text"]).toMatchObject({ status: "info" });
    expect(items["inline-citations"]).toMatchObject({ status: "info" });
    // A FAQ heading we cannot read, with fewer than three questions: not a "no FAQ" verdict.
    expect(items["faq-section"].detail).toContain("Not checked for Portuguese");
  });

  it("alt text: only the findings that need no language", () => {
    expect(checkAltText("", "design", "ja")).toBe("missing");
    expect(checkAltText("design", "design", "ja")).toBe("keyword");
    expect(checkAltText("デザイン", "design", "ja")).toBeNull();
  });

  it("the voice fallback reports what needs no language and says what it did not read", () => {
    const rules = analyzeVoiceLocally("A nossa equipa trabalha consigo — sempre.", "pt");
    expect(rules.tags).toEqual(["uses em-dashes"]);
    expect(rules.unchecked).toContain("Not checked for Portuguese");
  });
});

describe("unsupported language: the prompt gives the writer no English label to copy", () => {
  it("asks for the FAQ heading and summary label in the article's language", () => {
    const prompt = buildSystemPrompt({ keyword: "design", language: "Portuguese", output: { faq: true } });
    expect(prompt).toContain('an <h2> section headed with the usual Portuguese phrase for "frequently asked questions"');
    expect(prompt).not.toContain("<h2>Frequently asked questions</h2>");
    expect(prompt).not.toContain('(such as "Key takeaways")');
    expect(prompt).toContain("add a short summary block with an <h2> label written in Portuguese,");
  });
});
