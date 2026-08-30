import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Download an image from a URL and upload it to Supabase Storage.
 * Returns the public URL of the stored image.
 */
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
