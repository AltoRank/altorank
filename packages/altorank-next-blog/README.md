# @altorank/next-blog

Pull the articles you have approved and published in AltoRank into a Next.js
site. A small server-side client plus an `app/blog` starter you copy in. No
framework, no provider, no client bundle.

## Setup

1. In the dashboard, Settings -> API key. Copy the key.
2. Note the workspace id of the site (the id in `/workspaces/<id>`).
3. Add to your `.env.local`:

```
ALTORANK_BLOG_API_KEY=fr_live_sk_...
ALTORANK_WORKSPACE_ID=<uuid>
# ALTORANK_API_URL=https://app.altorank.co   # only when self-hosting the dashboard
```

4. Install the package. It is not on npm yet; install from the repository:

```
npm install github:AltoRank/altorank#main --workspace-path packages/altorank-next-blog
```

or copy `src/client.ts` into your project; it has no dependencies.

5. Copy `starter/app/blog` into your `app/` directory. Both pages use ISR with
`revalidate = 86400` (daily). Lower it, or call `revalidatePath("/blog")` from a
route handler your webhook connection hits, to publish faster.

## Remote images

Featured images and inline images are served from AltoRank's storage (or
from wherever you configured). To use `next/image` on them, allow the host in
`next.config.js`:

```js
images: {
  remotePatterns: [{ protocol: "https", hostname: "<your-supabase-project>.supabase.co" }],
},
```

The starter uses a plain `<img>` so it works before you do that.

## API

```ts
import { BlogClient } from "@altorank/next-blog";

const client = new BlogClient();               // reads the env vars above
const { articles, total } = await client.list({ page: 1, perPage: 20 });
const all = await client.listAll();            // for generateStaticParams
const article = await client.get("my-slug");   // null when not live
article?.content_html;                          // the body as HTML
```

Only articles with status `live` are ever returned. A draft, a review copy or
an article approved but not yet published does not exist as far as this
client is concerned.

## Server-side only

The API key can read every live article in the workspace. Use the client from
Server Components, route handlers and `generateStaticParams`; never import it
into a `"use client"` file.

## Endpoints

- `GET /api/blog/v1/articles?workspace_id=&page=&per_page=`
- `GET /api/blog/v1/articles/<slug>?workspace_id=`

Both take `Authorization: Bearer <api key>`. The key is the agency's API key
from Settings; a read-only, per-purpose key is planned (see the TODO in
`apps/web/lib/blog-api/auth.ts`).
