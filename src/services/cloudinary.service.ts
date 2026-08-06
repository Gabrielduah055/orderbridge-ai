import { v2 as cloudinary } from "cloudinary";
import { getSafeErrorMessage } from "../utils/error.util";

let configured = false;

export interface TrustedCloudinaryImage {
  secureUrl: string;
  publicId: string;
  uploadedAt: Date;
}

const getCloudinaryCloudName = (): string => {
  return process.env.CLOUDINARY_CLOUD_NAME?.trim() ?? "";
};

const getCloudinaryDeliveryHostname = (): string => {
  const configuredHostname =
    process.env.CLOUDINARY_DELIVERY_HOST?.trim() ??
    process.env.CLOUDINARY_DELIVERY_DOMAIN?.trim();

  if (!configuredHostname) {
    return "res.cloudinary.com";
  }

  try {
    return new URL(
      configuredHostname.includes("://") ? configuredHostname : `https://${configuredHostname}`
    ).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const decodeUrlPath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const extractCloudinaryPublicId = (secureUrl: string): string | null => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(secureUrl);
  } catch {
    return null;
  }

  const uploadMarker = "/upload/";
  const uploadIndex = parsedUrl.pathname.indexOf(uploadMarker);

  if (uploadIndex === -1) {
    return null;
  }

  const pathAfterUpload = parsedUrl.pathname.slice(uploadIndex + uploadMarker.length);
  const withoutVersion = pathAfterUpload.replace(/^v\d+\//, "");
  const withoutExtension = withoutVersion.replace(/\.[^/.]+$/, "");

  return decodeUrlPath(withoutExtension);
};

export const validateTrustedCloudinaryImage = (
  image: Pick<TrustedCloudinaryImage, "secureUrl" | "publicId">
): boolean => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(image.secureUrl);
  } catch {
    return false;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const deliveryHostname = getCloudinaryDeliveryHostname();
  const cloudName = getCloudinaryCloudName();

  if (
    parsedUrl.protocol !== "https:" ||
    !deliveryHostname ||
    hostname === "example.com" ||
    hostname.endsWith(".example.com") ||
    hostname !== deliveryHostname ||
    !image.publicId.trim()
  ) {
    return false;
  }

  if (
    deliveryHostname === "res.cloudinary.com" &&
    (!cloudName || !parsedUrl.pathname.startsWith(`/${encodeURIComponent(cloudName)}/`))
  ) {
    return false;
  }

  return extractCloudinaryPublicId(image.secureUrl) === image.publicId;
};

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
  const result = await uploadTrustedDecryptedImageFromUrl(publicUrl, folder);
  return result.secureUrl;
};

export const uploadTrustedDecryptedImageFromUrl = async (
  publicUrl: string,
  folder = "menu-items"
): Promise<TrustedCloudinaryImage> => {
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

  if (!result.secure_url || !result.public_id) {
    throw new Error("Cloudinary accepted the image but returned incomplete asset metadata.");
  }

  const trustedImage: TrustedCloudinaryImage = {
    secureUrl: result.secure_url,
    publicId: result.public_id,
    uploadedAt: new Date()
  };

  if (!validateTrustedCloudinaryImage(trustedImage)) {
    throw new Error("Cloudinary returned asset metadata that failed trusted URL validation.");
  }

  return trustedImage;
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
    const publicId = extractCloudinaryPublicId(imageUrl);

    if (!publicId || !validateTrustedCloudinaryImage({ secureUrl: imageUrl, publicId })) {
      console.warn("Cloudinary delete skipped for an untrusted image URL");
      return;
    }

    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (error) {
    console.warn("Cloudinary delete failed (non-fatal)", {
      error: getSafeErrorMessage(error, "Cloudinary could not delete the previous image")
    });
  }
};
