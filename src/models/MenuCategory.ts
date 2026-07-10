import { Schema, model, type Document, type Types } from "mongoose";

export interface IMenuCategory {
  restaurantId: Types.ObjectId;
  name: string;
  description?: string;
  sortOrder: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface IMenuCategoryDocument extends IMenuCategory, Document {
  createdAt: Date;
  updatedAt: Date;
}

const menuCategorySchema = new Schema<IMenuCategoryDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      trim: true
    },
    sortOrder: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    isDefault: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

menuCategorySchema.index({ restaurantId: 1, sortOrder: 1 });

export const MenuCategory = model<IMenuCategoryDocument>(
  "MenuCategory",
  menuCategorySchema
);
