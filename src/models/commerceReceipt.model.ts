import { Schema, model, type Document, type Types } from "mongoose";

export const commerceReceiptStatuses = [
  "pending",
  "generating",
  "generated",
  "enqueued",
  "failed"
] as const;

export type CommerceReceiptStatus = (typeof commerceReceiptStatuses)[number];

export interface ICommerceReceipt {
  businessId: Types.ObjectId;
  commerceEventId: string;
  receiptNumber: string;
  merchantName: string;
  status: CommerceReceiptStatus;
  pdfAssetPublicId?: string;
  pdfAssetUrl?: string;
  generatedAt?: Date;
  generationAttempts: number;
  maxGenerationAttempts: number;
  nextGenerationAttemptAt: Date;
  generationClaimId?: string;
  generationLeaseExpiresAt?: Date;
  lastGenerationAttemptAt?: Date;
  lastGenerationError?: string;
  enqueueCompletedAt?: Date;
}

export interface ICommerceReceiptDocument extends ICommerceReceipt, Document {
  createdAt: Date;
  updatedAt: Date;
}

const commerceReceiptSchema = new Schema<ICommerceReceiptDocument>(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true
    },
    commerceEventId: { type: String, required: true, trim: true },
    receiptNumber: { type: String, required: true, trim: true },
    merchantName: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: commerceReceiptStatuses,
      required: true,
      default: "pending"
    },
    pdfAssetPublicId: { type: String, trim: true },
    pdfAssetUrl: { type: String, trim: true },
    generatedAt: { type: Date },
    generationAttempts: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    maxGenerationAttempts: {
      type: Number,
      required: true,
      default: 8,
      min: 1
    },
    nextGenerationAttemptAt: {
      type: Date,
      required: true,
      default: Date.now
    },
    generationClaimId: { type: String, trim: true },
    generationLeaseExpiresAt: { type: Date },
    lastGenerationAttemptAt: { type: Date },
    lastGenerationError: { type: String, trim: true },
    enqueueCompletedAt: { type: Date }
  },
  {
    timestamps: true,
    strict: true,
    versionKey: false
  }
);

commerceReceiptSchema.index(
  { businessId: 1, commerceEventId: 1 },
  { unique: true, name: "commerce_receipt_business_event_unique" }
);
commerceReceiptSchema.index(
  { status: 1, nextGenerationAttemptAt: 1, generationLeaseExpiresAt: 1, createdAt: 1 },
  { name: "commerce_receipt_generation_claim" }
);
commerceReceiptSchema.index(
  { businessId: 1, receiptNumber: 1 },
  { unique: true, name: "commerce_receipt_business_number_unique" }
);

export const CommerceReceipt = model<ICommerceReceiptDocument>(
  "CommerceReceipt",
  commerceReceiptSchema
);

export const ensureCommerceReceiptIndexes = async (): Promise<void> => {
  await CommerceReceipt.collection.createIndex(
    { businessId: 1, commerceEventId: 1 },
    { unique: true, name: "commerce_receipt_business_event_unique" }
  );
  await CommerceReceipt.collection.createIndex(
    { status: 1, nextGenerationAttemptAt: 1, generationLeaseExpiresAt: 1, createdAt: 1 },
    { name: "commerce_receipt_generation_claim" }
  );
  // Drop the old non-unique index if it exists, then create the unique replacement
  try {
    await CommerceReceipt.collection.dropIndex("commerce_receipt_business_number");
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      (error as { code?: number }).code !== 27
    ) {
      throw error;
    }
  }
  await CommerceReceipt.collection.createIndex(
    { businessId: 1, receiptNumber: 1 },
    { unique: true, name: "commerce_receipt_business_number_unique" }
  );
};
