import dotenv from "dotenv";
import mongoose from "mongoose";
import { MenuItem } from "../models/MenuItem";
import { getSafeErrorMessage } from "../utils/error.util";

dotenv.config();

export type SuspiciousImageReason =
  | "malformed_url"
  | "non_https_url"
  | "example_domain";

export const classifySuspiciousMenuItemImageUrl = (
  imageUrl: string
): SuspiciousImageReason | null => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return "malformed_url";
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  if (hostname === "example.com" || hostname.endsWith(".example.com")) {
    return "example_domain";
  }

  if (parsedUrl.protocol !== "https:") {
    return "non_https_url";
  }

  return null;
};

export const auditMenuItemImages = async (
  applyChanges: boolean
): Promise<{ suspiciousCount: number; removedCount: number }> => {
  const items = await MenuItem.find({
    imageUrl: { $exists: true, $nin: [null, ""] }
  }).select("restaurantId name imageUrl");
  let removedCount = 0;

  for (const item of items) {
    const imageUrl = item.imageUrl;

    if (!imageUrl) {
      continue;
    }

    const reason = classifySuspiciousMenuItemImageUrl(imageUrl);

    if (!reason) {
      continue;
    }

    console.log(
      JSON.stringify({
        restaurantId: String(item.restaurantId),
        menuItemId: String(item._id),
        menuItemName: item.name,
        suspiciousUrl: imageUrl,
        reason
      })
    );

    if (applyChanges) {
      const result = await MenuItem.updateOne(
        { _id: item._id, imageUrl },
        { $unset: { imageUrl: 1 } }
      );
      removedCount += result.modifiedCount;
    }
  }

  const suspiciousCount = items.filter(
    (item) => item.imageUrl && classifySuspiciousMenuItemImageUrl(item.imageUrl)
  ).length;

  console.log(
    JSON.stringify({
      mode: applyChanges ? "apply" : "dry-run",
      suspiciousCount,
      removedCount
    })
  );

  return { suspiciousCount, removedCount };
};

const main = async (): Promise<void> => {
  const applyChanges = process.argv.includes("--apply");
  const mongodbUri = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URL;

  if (!mongodbUri) {
    throw new Error("Set MONGODB_URI before running the menu-item image audit.");
  }

  await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 10000 });

  try {
    await auditMenuItemImages(applyChanges);
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error("Menu-item image audit failed", {
      error: getSafeErrorMessage(error, "Unknown menu-item image audit error")
    });
    process.exitCode = 1;
  });
}
