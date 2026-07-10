import { Schema, model, type Document, type Types } from "mongoose";

export interface IMenuItem {
  restaurantId: Types.ObjectId;
  categoryId: Types.ObjectId;
  name: string;
  description?: string;
  price: number;
  imageUrl?: string;
  isAvailable: boolean;
  preparationTimeMinutes?: number;
  tags: string[];
  allergens: string[];
  portionSize?: string;
  isPopular: boolean;
  isPromoItem: boolean;
}

export interface IMenuItemDocument extends IMenuItem, Document {
  createdAt: Date;
  updatedAt: Date;
}

const menuItemSchema = new Schema<IMenuItemDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: "MenuCategory",
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
    price: {
      type: Number,
      required: true,
      min: 0.01
    },
    imageUrl: {
      type: String,
      trim: true
    },
    isAvailable: {
      type: Boolean,
      default: true
    },
    preparationTimeMinutes: {
      type: Number,
      min: 0
    },
    tags: {
      type: [String],
      default: []
    },
    allergens: {
      type: [String],
      default: []
    },
    portionSize: {
      type: String,
      trim: true
    },
    isPopular: {
      type: Boolean,
      default: false
    },
    isPromoItem: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

menuItemSchema.index({ restaurantId: 1, categoryId: 1 });
menuItemSchema.index({ restaurantId: 1, isAvailable: 1 });

export const MenuItem = model<IMenuItemDocument>("MenuItem", menuItemSchema);
