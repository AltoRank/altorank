// HTML the way the writer produces it: an H1, an intro, H2 sections with a
// paragraph or two, sometimes a list or a link. Each fixture is small and
// exercises one shape the steps have to recognise.

export const SECTION = (heading: string, ...paragraphs: string[]) =>
  `<h2>${heading}</h2>\n${paragraphs.map((p) => (p.startsWith("<") ? p : `<p>${p}</p>`)).join("\n")}\n`;

const LONG =
  "Small teams spend most of their week on repetitive follow-up, and a shared inbox does not solve it. " +
  "A CRM gives every contact a single record, so a colleague can pick up a conversation without asking. " +
  "The catch is that most systems are built for sales floors of fifty, not offices of five, so the setup " +
  "cost lands on whoever volunteered to look into it. This section explains what to look for instead.";

export const ARTICLE = `<h1>How to choose a CRM for a small team</h1>
<p>A small team needs a CRM that a person can set up in an afternoon and never think about again. The rest of this guide is how to tell one from the other.</p>
${SECTION("What a small team actually needs", LONG, "Most teams need three things: contacts, notes, reminders.")}
${SECTION("How to set up a CRM in an afternoon", "Start with the contacts you already have. " + LONG, "<ol><li>Export your contacts.</li><li>Import them.</li><li>Set one reminder.</li></ol>")}
${SECTION("What the tools cost", LONG, "<ul><li>Starter: €9 per month</li><li>Team: €29 per month</li><li>Business: €79 per month</li></ul>")}
${SECTION("Frequently asked questions", "Short answers to the questions people ask before choosing.", "<h3>Do I need a CRM with five people?</h3><p>Yes, if more than one person talks to the same customer. The record replaces the hallway conversation.</p><h3>Can I switch later?</h3><p>Every tool here exports contacts as CSV, so the switching cost is an afternoon of cleanup.</p><h3>Is a spreadsheet enough?</h3><p>Until the first missed follow-up. A spreadsheet has no reminders and no history per contact.</p>")}
`;
