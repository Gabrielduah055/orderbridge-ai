import { Schema, model, type Document, type Types } from "mongoose";

export interface CommerceDraftItem {
  productId: string;
  name: string;
  quantity: number;
  verifiedAt: Date;
}

export interface CommerceDraftCustomer {
  fullName?: string;
  email?: string;
  deliveryAddress?: string;
  whatsappConsent?: boolean;
}

export interface CommerceQuotedSnapshot {
  quoteId: string;
  draftVersion: number;
  items: Array<{
    productId: string;
    name: string;
    unitPricePesewas: number;
    quantity: number;
    lineTotalPesewas: number;
  }>;
  subtotalPesewas: number;
  totalPesewas: number;
  currency: "GHS";
  deliveryFee: "arranged_separately";
  expiresAt: Date;
  presentation?: {
    assistantTurnId: string;
    customerRequestId: string;
    presentedAt: Date;
  };
  confirmation?: {
    assistantTurnId: string;
    customerRequestId: string;
    confirmedAt: Date;
  };
}

export interface CommercePendingConsentQuestion {
  assistantTurnId: string;
  customerRequestId: string;
  askedAt: Date;
}

export interface CommerceCheckoutState {
  quoteId: string;
  idempotencyKey: string;
  lifecycle: "initializing" | "uncertain" | "pending" | "paid" | "failed" | "refunded" | "expired" | "needs_attention";
  sessionId?: string;
  orderNumber?: string;
  amountPesewas?: number;
  currency?: "GHS";
  paymentStatus?: string;
  fulfillmentStatus?: string;
  deliveryFeeStatus?: string;
  paymentUrl?: string;
  receipt?: { number?: string; url?: string };
  lastCheckedAt?: Date;
  lastErrorCode?: string;
}

export interface ICommerceShoppingDraftDocument extends Document {
  businessId: Types.ObjectId;
  customerKey: string;
  notificationPhone?: string;
  items: CommerceDraftItem[];
  customer: CommerceDraftCustomer;
  orderNotes: string;
  version: number;
  appliedActionKeys: string[];
  pendingConsentQuestion?: CommercePendingConsentQuestion;
  quote?: CommerceQuotedSnapshot;
  checkout?: CommerceCheckoutState;
  createdAt: Date;
  updatedAt: Date;
}

const commerceShoppingDraftSchema = new Schema<ICommerceShoppingDraftDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    customerKey: { type: String, required: true, trim: true, maxlength: 200 },
    notificationPhone: { type: String, trim: true, maxlength: 25 },
    items: {
      type: [
        new Schema(
          {
            productId: { type: String, required: true, trim: true, maxlength: 200 },
            name: { type: String, required: true, trim: true, maxlength: 300 },
            quantity: { type: Number, required: true, min: 1, max: 20 },
            verifiedAt: { type: Date, required: true }
          },
          { _id: false }
        )
      ],
      default: []
    },
    customer: {
      type: new Schema(
        {
          fullName: { type: String, trim: true, maxlength: 120 },
          email: { type: String, trim: true, lowercase: true, maxlength: 254 },
          deliveryAddress: { type: String, trim: true, maxlength: 500 },
          whatsappConsent: { type: Boolean }
        },
        { _id: false }
      ),
      default: {}
    },
    orderNotes: { type: String, trim: true, maxlength: 500, default: "" },
    version: { type: Number, min: 0, default: 0 },
    appliedActionKeys: { type: [String], default: [], select: false },
    quote: {
      type: new Schema(
        {
          quoteId: { type: String, required: true, trim: true },
          draftVersion: { type: Number, required: true },
          items: {
            type: [
              new Schema(
                {
                  productId: { type: String, required: true },
                  name: { type: String, required: true },
                  unitPricePesewas: { type: Number, required: true, min: 0 },
                  quantity: { type: Number, required: true, min: 1, max: 20 },
                  lineTotalPesewas: { type: Number, required: true, min: 0 }
                },
                { _id: false }
              )
            ],
            required: true
          },
          subtotalPesewas: { type: Number, required: true, min: 0 },
          totalPesewas: { type: Number, required: true, min: 0 },
          currency: { type: String, enum: ["GHS"], required: true },
          deliveryFee: { type: String, enum: ["arranged_separately"], required: true },
          expiresAt: { type: Date, required: true },
          presentation: {
            type: new Schema(
              {
                assistantTurnId: { type: String, required: true, trim: true },
                customerRequestId: { type: String, required: true, trim: true },
                presentedAt: { type: Date, required: true }
              },
              { _id: false }
            )
          },
          confirmation: {
            type: new Schema(
              {
                assistantTurnId: { type: String, required: true, trim: true },
                customerRequestId: { type: String, required: true, trim: true },
                confirmedAt: { type: Date, required: true }
              },
              { _id: false }
            )
          }
        },
        { _id: false }
      )
    },
    pendingConsentQuestion: {
      type: new Schema(
        {
          assistantTurnId: { type: String, required: true, trim: true },
          customerRequestId: { type: String, required: true, trim: true },
          askedAt: { type: Date, required: true }
        },
        { _id: false }
      )
    },
    checkout: {
      type: new Schema(
        {
          quoteId: { type: String, required: true },
          idempotencyKey: { type: String, required: true, select: false },
          lifecycle: {
            type: String,
            enum: ["initializing", "uncertain", "pending", "paid", "failed", "refunded", "expired", "needs_attention"],
            required: true
          },
          sessionId: { type: String, trim: true },
          orderNumber: { type: String, trim: true },
          amountPesewas: { type: Number, min: 0 },
          currency: { type: String, enum: ["GHS"] },
          paymentStatus: { type: String, trim: true },
          fulfillmentStatus: { type: String, trim: true },
          deliveryFeeStatus: { type: String, trim: true },
          paymentUrl: { type: String, trim: true },
          receipt: {
            type: new Schema(
              {
                number: { type: String, trim: true },
                url: { type: String, trim: true }
              },
              { _id: false }
            )
          },
          lastCheckedAt: { type: Date },
          lastErrorCode: { type: String, trim: true }
        },
        { _id: false }
      )
    }
  },
  {
    timestamps: true,
    strict: true,
    toJSON: {
      transform: (_document, returned) => {
        if (returned.checkout) {
          delete (returned.checkout as Record<string, unknown>).idempotencyKey;
        }
        delete (returned as Record<string, unknown>).appliedActionKeys;
        return returned;
      }
    }
  }
);

commerceShoppingDraftSchema.index(
  { businessId: 1, customerKey: 1 },
  { unique: true }
);

export const CommerceShoppingDraft = model<ICommerceShoppingDraftDocument>(
  "CommerceShoppingDraft",
  commerceShoppingDraftSchema
);
