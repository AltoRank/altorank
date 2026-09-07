/**
 * /.well-known/openai-apps-challenge — domain verification for the ChatGPT
 * plugin directory. OpenAI hands the publisher a token at submission time and
 * fetches it here; the value lives in OPENAI_APPS_CHALLENGE_TOKEN so a new
 * token is an env change, not a deploy of code. Unset means 404, which is
 * what an unverified domain should answer.
 */
export function GET() {
  const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim();
  if (!token) return new Response("Not found", { status: 404 });
  return new Response(token, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
