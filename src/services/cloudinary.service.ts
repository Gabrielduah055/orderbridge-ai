import { v2 as cloudinary } from "cloudinary";

let configured = false;

const ensureConfigured = (): void => {
  if (configured) {
    return;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary is not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET."
    );
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true
  });

  configured = true;
};

export const isCloudinaryConfigured = (): boolean => {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME?.trim() &&
      process.env.CLOUDINARY_API_KEY?.trim() &&
      process.env.CLOUDINARY_API_SECRET?.trim()
  );
};

/**
 * Uploads an image from a remote URL (e.g. a WaSender media URL) to Cloudinary.
 *
 * WaSender media URLs are auth-protected — Cloudinary cannot fetch them directly.
 * We download the image ourselves first (with an optional Bearer token), then
 * upload the raw buffer to Cloudinary as a base64 data URI so no external fetch
 * by Cloudinary is needed.
 *
 * @param remoteUrl  The protected media URL to download from
 * @param apiKey     Optional Bearer token to include when fetching the media
 * @param folder     Cloudinary folder to upload into (default: "menu-items")
 */
export const uploadImageFromUrl = async (
  remoteUrl: string,
  apiKey?: string,
  folder = "menu-items"
): Promise<string> => {
  ensureConfigured();

  // Step 1 — download the image ourselves.
  // Try with auth first (WaSender API key), then fall back to no-auth
  // in case the URL is a pre-signed CDN link that doesn't need a Bearer token.
  let imageBuffer: Buffer | null = null;
  let contentType = "image/jpeg";

  const attemptFetch = async (withAuth: boolean): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (withAuth && apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return fetch(remoteUrl, { headers });
  };

  for (const withAuth of [true, false]) {
    const fetchResponse = await attemptFetch(withAuth);

    console.info("[cloudinary] media fetch attempt", {
      withAuth,
      status: fetchResponse.status,
      contentType: fetchResponse.headers.get("content-type"),
      url: remoteUrl.slice(0, 80)
    });

    if (fetchResponse.ok) {
      contentType = fetchResponse.headers.get("content-type") ?? "image/jpeg";
      const arrayBuffer = await fetchResponse.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
      break;
    }

    // If auth attempt failed with 401/403, the retry without auth may succeed
    if (fetchResponse.status !== 401 && fetchResponse.status !== 403) {
      throw new Error(
        `Failed to download media from WaSender: ${fetchResponse.status} ${fetchResponse.statusText}`
      );
    }
  }

  if (!imageBuffer) {
    throw new Error(`Could not download media from WaSender — both auth and no-auth attempts failed. URL: ${remoteUrl.slice(0, 120)}`);
  }

  const base64 = imageBuffer.toString("base64");
  const dataUri = `data:${contentType};base64,${base64}`;

  // Step 2 — upload the buffer to Cloudinary
  const result = await cloudinary.uploader.upload(dataUri, {
    folder,
    resource_type: "image",
    unique_filename: true
  });

  return result.secure_url;
};


/**
 * Deletes an image from Cloudinary using its CDN URL.
 * Silently ignores errors so a failed delete never blocks other operations.
 */
export const deleteImageByUrl = async (imageUrl: string): Promise<void> => {
  if (!imageUrl || !isCloudinaryConfigured()) {
    return;
  }

  try {
    ensureConfigured();

    // Extract public_id from the Cloudinary URL
    // e.g. https://res.cloudinary.com/<cloud>/image/upload/v123/menu-items/abc123.jpg
    // → public_id = "menu-items/abc123"
    const uploadIndex = imageUrl.indexOf("/upload/");

    if (uploadIndex === -1) {
      return; // Not a Cloudinary URL, skip
    }

    const afterUpload = imageUrl.slice(uploadIndex + "/upload/".length);
    // Strip version segment (v12345678/)
    const withoutVersion = afterUpload.replace(/^v\d+\//, "");
    // Strip file extension
    const publicId = withoutVersion.replace(/\.[^/.]+$/, "");

    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (error) {
    console.warn("Cloudinary delete failed (non-fatal)", {
      imageUrl,
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};
