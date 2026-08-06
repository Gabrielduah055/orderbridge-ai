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
 * Uploads an image from a remote URL (e.g. WaSender media URL) to Cloudinary.
 * Returns the permanent Cloudinary CDN URL.
 */
export const uploadImageFromUrl = async (
  remoteUrl: string,
  folder = "menu-items"
): Promise<string> => {
  ensureConfigured();

  const result = await cloudinary.uploader.upload(remoteUrl, {
    folder,
    resource_type: "image",
    // Use the URL hash as a stable public_id so the same image isn't uploaded twice
    use_filename: false,
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
