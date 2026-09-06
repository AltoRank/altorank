import { getPluginZip, PLUGIN_ZIP_FILENAME } from "@/lib/cms/wordpress-plugin-zip";

/**
 * GET /api/public/wordpress-plugin  ->  altorank.zip
 *
 * The WordPress plugin, as the file Plugins -> Add New -> Upload Plugin takes.
 * Public and unauthenticated: it is GPL code that ships in this repository,
 * and the person downloading it is in the middle of the connect dialog on a
 * site we cannot see yet.
 *
 * Static on purpose. The archive is built from packages/wordpress-plugin at
 * `next build`, so what is served is exactly the plugin source this version
 * of the app was built with, and a checkout missing the package fails the
 * build rather than 404ing on a customer.
 */
export const dynamic = "force-static";

export async function GET() {
  const zip = await getPluginZip();
  return new Response(new Uint8Array(zip.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.bytes.length),
      "Content-Disposition": `attachment; filename="${PLUGIN_ZIP_FILENAME}"`,
      ...(zip.version ? { "X-Plugin-Version": zip.version } : {}),
      "Cache-Control": "public, max-age=3600",
    },
  });
}
