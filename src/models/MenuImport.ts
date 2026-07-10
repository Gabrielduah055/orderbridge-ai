import { Schema, model, type Document, type Types } from "mongoose";
import {
  menuFileTypes,
  menuImportStatuses,
  type MenuFileType,
  type MenuImportStatus
} from "../types/menu.types";

export interface IMenuImport {
  restaurantId: Types.ObjectId;
  fileUrl: string;
  fileType: MenuFileType;
  originalFileName: string;
  status: MenuImportStatus;
  extractedItems: unknown[];
  errorMessage?: string;
}

export interface IMenuImportDocument extends IMenuImport, Document {
  createdAt: Date;
  updatedAt: Date;
}

const menuImportSchema = new Schema<IMenuImportDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    fileUrl: {
      type: String,
      required: true,
      trim: true
    },
    fileType: {
      type: String,
      enum: menuFileTypes,
      required: true
    },
    originalFileName: {
      type: String,
      required: true,
      trim: true
    },
    status: {
      type: String,
      enum: menuImportStatuses,
      default: "uploaded",
      index: true
    },
    extractedItems: {
      type: [Schema.Types.Mixed],
      default: []
    },
    errorMessage: {
      type: String,
      trim: true
    }
  },
  {
    timestamps: true
  }
);

export const MenuImport = model<IMenuImportDocument>("MenuImport", menuImportSchema);
