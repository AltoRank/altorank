import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Download an image from a URL and upload it to Supabase Storage.
 * Returns the public URL of the stored image.
 */
/**
 * Upload bytes we already hold.
 *
 * The gpt-image models return base64 rather than a hosted URL, so there is
 * nothing to download: `uploadImageFromUrl` would have to write the bytes to
 * somewhere public first and then fetch them back. This is the same upload
 * without the round trip.
 */
/**
 * The client an image is written with.
 *
 * Migration 045 gave `article-images` one policy - anyone may read - on the
 * stated assumption that "the service role writes these during generation".
 * The editor does (app/actions/editor-ai.ts); generation did not. It uploaded
 * with whatever client the caller passed in, which for Write now, the New
 * article modal and the agent API is the person's own session, and RLS
 * refused every insert: "new row violates row-level security policy". So a
 * cron draft got its images and a draft a person asked for got none, with
 * the OpenAI call already made. Measured 2026-09-07 on a fresh local stack
 * with every migration applied.
 *
 * The service role when the environment has it, else the caller's client -
 * a self-host without the key keeps working exactly as before.
 */
export function imageWriter(fallback: SupabaseClient): SupabaseClient {
  return process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createServiceClient()
    : fallback;
}

export async function uploadImageBuffer(
  supabase: SupabaseClient,
  data: Buffer,
  storagePath: string,
  contentType = "image/webp",
  bucket = "article-images",
): Promise<string> {
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, data, { contentType, upsert: true });

  if (uploadError) {
    throw new Error(`Failed to upload image: ${uploadError.message}`);
  }

  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return urlData.publicUrl;
}

export async function uploadImageFromUrl(
  supabase: SupabaseClient,
  sourceUrl: string,
  storagePath: string,
  bucket = "article-images",
): Promise<string> {
  // Download the image
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType,
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload image: ${uploadError.message}`);
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from(bucket)
    .getPublicUrl(storagePath);

  return urlData.publicUrl;
}
