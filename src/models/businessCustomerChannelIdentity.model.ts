import { Schema, model, type Document, type Types } from "mongoose";

export interface IBusinessCustomerChannelIdentity {
  businessId: Types.ObjectId;
  sessionId: string;
  provider: "wasender";
  channel: "whatsapp";
  phone?: string;
  lid?: string;
  username?: string;
}

export interface IBusinessCustomerChannelIdentityDocument
  extends IBusinessCustomerChannelIdentity,
    Document {
  createdAt: Date;
  updatedAt: Date;
}

const businessCustomerChannelIdentitySchema =
  new Schema<IBusinessCustomerChannelIdentityDocument>(
    {
      businessId: {
        type: Schema.Types.ObjectId,
        ref: "Business",
        required: true
      },
      sessionId: { type: String, required: true, trim: true },
      provider: {
        type: String,
        enum: ["wasender"],
        required: true,
        default: "wasender"
      },
      channel: {
        type: String,
        enum: ["whatsapp"],
        required: true,
        default: "whatsapp"
      },
      phone: { type: String, trim: true },
      lid: { type: String, trim: true },
      username: { type: String, trim: true, lowercase: true }
    },
    { timestamps: true }
  );

const scope = { businessId: 1, sessionId: 1, provider: 1, channel: 1 } as const;

businessCustomerChannelIdentitySchema.index(
  { ...scope, lid: 1 },
  {
    unique: true,
    partialFilterExpression: { lid: { $type: "string" } },
    name: "business_customer_identity_lid_unique"
  }
);
businessCustomerChannelIdentitySchema.index(
  { ...scope, phone: 1 },
  {
    unique: true,
    partialFilterExpression: { phone: { $type: "string" } },
    name: "business_customer_identity_phone_unique"
  }
);
businessCustomerChannelIdentitySchema.index(
  { ...scope, username: 1 },
  {
    unique: true,
    partialFilterExpression: { username: { $type: "string" } },
    name: "business_customer_identity_username_unique"
  }
);

export const BusinessCustomerChannelIdentity =
  model<IBusinessCustomerChannelIdentityDocument>(
    "BusinessCustomerChannelIdentity",
    businessCustomerChannelIdentitySchema
  );

export const ensureBusinessCustomerChannelIdentityIndexes = async (): Promise<void> => {
  await BusinessCustomerChannelIdentity.createIndexes();
};
