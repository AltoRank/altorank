import Link from "next/link";
import { Card, Button } from "@/components/ui";

/**
 * Settings → Blog: how a Next.js site reads this site's articles itself
 * (packages/altorank-next-blog), what it needs, and the one step that puts an
 * approved article on such a site. Nothing here is a connection: the site
 * pulls, it is not pushed to.
 */
export function BlogApiCard({ workspaceId, domain }: { workspaceId: string; domain: string }) {
  return (
    <Card title="Next.js site (blog API)">
      <div className="space-y-3 text-[13px] text-ink-2 max-w-[720px]">
        <p>
          A Next.js site can show this site&apos;s published articles itself with{" "}
          <code className="font-mono text-[12px]">@altorank/next-blog</code>. It reads them through the blog API with
          a blog key: a key that reads this one site&apos;s published articles and nothing else.
        </p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12.5px]">
          <dt className="text-ink-3">ALTORANK_WORKSPACE_ID</dt>
          <dd className="font-mono break-all select-all">{workspaceId}</dd>
          <dt className="text-ink-3">ALTORANK_BLOG_API_KEY</dt>
          <dd>a blog key for {domain}, from Settings → API keys</dd>
        </dl>
        <p className="text-[12.5px] text-ink-3">
          The site shows live articles only. After you approve one, use Mark as published in the editor with the
          address it will have (<code className="font-mono">https://{domain}/blog/&lt;slug&gt;</code>); it appears at
          the site&apos;s next refresh.
        </p>
        <Link href={`/settings/api-keys?blog=${workspaceId}`}>
          <Button size="sm">Create a blog key</Button>
        </Link>
      </div>
    </Card>
  );
}
