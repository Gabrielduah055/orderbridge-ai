import path from "path";
import { MenuImport, type IMenuImportDocument } from "../models/MenuImport";
import type { MenuFileType, MenuImportMode } from "../types/menu.types";
import { BadRequestError } from "../utils/httpErrors";
import { ensureRestaurantExists } from "./menuCategory.service";

const imageMimeTypes = ["image/jpeg", "image/png", "image/webp"];

export const detectMenuFileType = (file: Express.Multer.File): MenuFileType => {
  const extension = path.extname(file.originalname).toLowerCase();

  if (file.mimetype === "application/pdf" || extension === ".pdf") {
    return "pdf";
  }

  if (
    imageMimeTypes.includes(file.mimetype) ||
    [".jpg", ".jpeg", ".png", ".webp"].includes(extension)
  ) {
    return "image";
  }

  throw new BadRequestError("Uploaded file must be a PDF or image");
};

export const buildUploadFileUrl = (folder: string, filename: string): string => {
  return `/uploads/${folder}/${filename}`;
};

const createPlaceholderExtraction = async (): Promise<{
  status: "pending_extraction";
  extractedItems: unknown[];
}> => {
  return {
    status: "pending_extraction",
    extractedItems: []
  };
};

export const importMenuFile = async (
  restaurantId: string,
  file: Express.Multer.File | undefined,
  importMode: MenuImportMode = "preview"
): Promise<IMenuImportDocument> => {
  await ensureRestaurantExists(restaurantId);

  if (!file) {
    throw new BadRequestError("Menu file is required");
  }

  if (!["preview", "save"].includes(importMode)) {
    throw new BadRequestError("importMode must be preview or save");
  }

  const fileType = detectMenuFileType(file);
  const extraction = await createPlaceholderExtraction();

  return MenuImport.create({
    restaurantId,
    fileUrl: buildUploadFileUrl("menu-imports", file.filename),
    fileType,
    originalFileName: file.originalname,
    status: extraction.status,
    extractedItems: extraction.extractedItems
  });
};
