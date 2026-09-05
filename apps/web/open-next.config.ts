import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache, tag cache or queue: every page in apps/web reads the
// session cookie and is rendered per request, so there is nothing to cache.
export default defineCloudflareConfig();
