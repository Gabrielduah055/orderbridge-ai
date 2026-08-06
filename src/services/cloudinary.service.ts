import { v2 as cloudinary } from "cloudinary";
import { getSafeErrorMessage } from "../utils/error.util";

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

export const isEncryptedWhatsappMediaUrl = (value: string): boolean => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "mmg.whatsapp.net" || hostname.endsWith(".whatsapp.net");
  } catch {
    return false;
  }
};

/**
 * Uploads WaSender's temporary decrypted public URL to Cloudinary. Encrypted
 * WhatsApp CDN URLs are rejected defensively so they can never reach Cloudinary.
 */
export const uploadDecryptedImageFromUrl = async (
  publicUrl: string,
  folder = "menu-items"
): Promise<string> => {
  if (isEncryptedWhatsappMediaUrl(publicUrl)) {
    throw new Error("Refusing to upload an encrypted WhatsApp media URL to Cloudinary.");
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(publicUrl);
  } catch {
    throw new Error("The decrypted media publicUrl is invalid.");
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("The decrypted media publicUrl must use HTTP or HTTPS.");
  }

  ensureConfigured();

  const result = await cloudinary.uploader.upload(publicUrl, {
    folder,
    resource_type: "image",
    unique_filename: true
  });

  if (!result.secure_url) {
    throw new Error("Cloudinary accepted the image but returned no secure URL.");
  }

  return result.secure_url;
};

// Keep the previous export name for any callers outside this repository. The
// encrypted WhatsApp URL guard applies to it as well.
export const uploadImageFromUrl = uploadDecryptedImageFromUrl;

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

    const uploadIndex = imageUrl.indexOf("/upload/");

    if (uploadIndex === -1) {
      return;
    }

    const afterUpload = imageUrl.slice(uploadIndex + "/upload/".length);
    const withoutVersion = afterUpload.replace(/^v\d+\//, "");
    const publicId = withoutVersion.replace(/\.[^/.]+$/, "");

    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (error) {
    console.warn("Cloudinary delete failed (non-fatal)", {
      error: getSafeErrorMessage(error, "Cloudinary could not delete the previous image")
    });
  }
};
