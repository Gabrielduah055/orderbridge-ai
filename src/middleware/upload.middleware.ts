import fs from "fs";
import path from "path";
import multer from "multer";
import { BadRequestError } from "../utils/httpErrors";

const uploadRoot = path.join(process.cwd(), "uploads");

const ensureUploadDirectory = (folder: string): string => {
  const destination = path.join(uploadRoot, folder);
  fs.mkdirSync(destination, { recursive: true });
  return destination;
};

const sanitizeFileName = (fileName: string): string => {
  return fileName
    .replace(path.extname(fileName), "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
};

const createStorage = (folder: string): multer.StorageEngine => {
  return multer.diskStorage({
    destination: (_req, _file, callback) => {
      callback(null, ensureUploadDirectory(folder));
    },
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const baseName = sanitizeFileName(file.originalname) || "upload";
      callback(null, `${Date.now()}-${baseName}${extension}`);
    }
  });
};

const menuImportMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp"
];

const menuItemImageMimeTypes = ["image/jpeg", "image/png", "image/webp"];

const createFileFilter =
  (allowedMimeTypes: string[], message: string): multer.Options["fileFilter"] =>
  (_req, file, callback) => {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      callback(new BadRequestError(message));
      return;
    }

    callback(null, true);
  };

export const uploadMenuImportFile = multer({
  storage: createStorage("menu-imports"),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: createFileFilter(
    menuImportMimeTypes,
    "Uploaded menu file must be a PDF, JPG, JPEG, PNG, or WEBP"
  )
}).single("file");

export const uploadMenuItemImage = multer({
  storage: createStorage("menu-items"),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: createFileFilter(
    menuItemImageMimeTypes,
    "Menu item image must be a JPG, JPEG, PNG, or WEBP"
  )
}).single("file");
