# @altorank/next-blog

Show the articles you have approved in AltoRank on a Next.js site. A small
server-side client plus an `app/blog` starter (index with pages, article page,
sitemap) that you copy in. No framework, no provider, no client bundle.

The site pulls: nothing is pushed to it. It shows articles whose status is
`live`, and an article becomes `live` when you mark it published (see
[Going live](#going-live)).

## Setup

1. In the dashboard, open Settings → Blog for the site, or Settings → API keys,
   and create a **blog key** for the site. It is shown once. An owner or admin
   with access to every site can create one.

   A blog key reads that one site's live articles through the blog API and
   nothing else: no drafts, no other site, and the agent API refuses it. It is
   made to sit in a site's environment, where the site's developers and host
   can read it. Do not use an agent key here: an agent key reaches every site
   on the account and the agent API.

2. Note the site's workspace id. Settings → Blog shows it, and the key's
   creation screen prints both lines below.
3. Add to your `.env.local` (and to your host's environment settings):

```
ALTORANK_BLOG_API_KEY=altorank_live_...
ALTORANK_WORKSPACE_ID=<uuid>
NEXT_PUBLIC_SITE_URL=https://www.example.com   # for absolute sitemap URLs
# ALTORANK_API_URL=https://app.altorank.co    # only when self-hosting the dashboard
```

4. Copy `src/client.ts` into your project (for example `lib/altorank.ts`).
   It has no dependencies. The package is not on npm, and npm cannot install
   one directory of a git repository, so copying is the install. Then point
   the starter's `import { BlogClient } from "@altorank/next-blog"` lines at
   your copy.

5. Copy `starter/app/blog` into your `app/` directory, and `starter/app/sitemap.ts`
   into `app/` (or add its entries to the sitemap you already have).
   - `/blog` lists 20 articles a page, newest first, with `?page=` links to the
     older ones, so every article is linked from the index.
   - `/blog/<slug>` renders one article, with its JSON-LD in a script tag.
   - `/sitemap.xml` lists `/blog` and every article.

   The pages use ISR with `revalidate = 86400` (daily). Lower it, or call
   `revalidatePath("/blog")` from a route handler your webhook connection hits,
   to show changes faster.

## Going live

There is no "publish to Next.js" button: the blog API serves only `live`
articles, and an article becomes `live` when it is published from the
dashboard. For a site reading the blog API:

1. Approve the article in the editor.
2. Use **Mark as published** and enter the address it will have,
   `https://<your-site>/blog/<slug>` (the editor shows it).
3. The article appears on the site at its next refresh (the ISR window above,
   or at once if you revalidate).

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
import { BlogClient } from "@/lib/altorank";     // your copy of src/client.ts

const client = new BlogClient();               // reads the env vars above
const { articles, total } = await client.list({ page: 1, perPage: 20 });
const all = await client.listAll();            // for generateStaticParams and the sitemap
const article = await client.get("my-slug");   // null when no live article has that slug
article?.content_html;                          // the body as HTML
article?.structured_data;                       // JSON-LD objects for a script tag
```

Only articles with status `live` are ever returned. A draft, a review copy or
an article approved but not yet published does not exist as far as this
client is concerned.

`content_html` goes through the same steps the dashboard runs before it
publishes to a CMS: the H1 that repeats the title is removed (render `title`
yourself, as the starter does), internal links are resolved, and the dateline
and, on the free plan, the attribution line are added. `structured_data` holds
the BlogPosting JSON-LD, and the FAQPage when the site's FAQ schema setting is
on.

### Errors

Every failure throws a `BlogClientError` with the status and the API's
message, including a key that cannot read the workspace (403), a revoked key
(401) and a wrong `ALTORANK_API_URL` (404 without the API's answer). Under ISR
a thrown error keeps the pages Next already has, so a misconfiguration fails
the build or the regeneration instead of replacing your blog with an empty
one. Only `get()` of a slug that is not live returns `null`.

A rate-limited request (429) is retried after the `Retry-After` the API sends,
up to three times.

## Server-side only

The key reads the site's published articles. Use the client from Server
Components, route handlers, `generateStaticParams` and `sitemap.ts`; never
import it into a `"use client"` file.

## Endpoints

- `GET /api/blog/v1/articles?workspace_id=&page=&per_page=` (`per_page` up to 100)
- `GET /api/blog/v1/articles/<slug>?workspace_id=`

Both take `Authorization: Bearer <api key>`. With a blog key, `workspace_id`
may be left out; naming another site is a 403. Each key is limited to 600
requests a minute; past that the API answers 429 with `Retry-After`.

Keys made before blog keys existed (an agent key with the `read` scope, or the
account's legacy key) still work here, so a site set up with one keeps
building. Replace it with a blog key and revoke the old key in Settings → API
keys: an agent key in a site's environment can do much more than read that
site's articles.
