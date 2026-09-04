import type { SupabaseClient } from "@supabase/supabase-js";

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
