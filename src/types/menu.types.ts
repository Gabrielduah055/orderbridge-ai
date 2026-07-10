export const menuImportStatuses = [
  "uploaded",
  "pending_extraction",
  "extracted",
  "failed",
  "saved"
] as const;

export const menuFileTypes = ["pdf", "image", "csv", "excel"] as const;

export type MenuImportStatus = (typeof menuImportStatuses)[number];
export type MenuFileType = (typeof menuFileTypes)[number];

export interface MenuCategoryInput {
  name: string;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export type MenuCategoryUpdateInput = Partial<MenuCategoryInput>;

export interface CategorySortOrderInput {
  categoryId: string;
  sortOrder: number;
}

export interface MenuItemInput {
  categoryId: string;
  name: string;
  description?: string;
  price: number;
  imageUrl?: string;
  isAvailable?: boolean;
  preparationTimeMinutes?: number;
  tags?: string[];
  allergens?: string[];
  portionSize?: string;
  isPopular?: boolean;
  isPromoItem?: boolean;
}

export type MenuItemUpdateInput = Partial<MenuItemInput>;

export type MenuImportMode = "preview" | "save";
