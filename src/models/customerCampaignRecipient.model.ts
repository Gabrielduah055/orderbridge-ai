import { Schema, model, type Document, type Types } from "mongoose";

export const customerCampaignRecipientStatuses = [
  "pending",
  "sent",
  "failed",
  "cancelled",
  "skipped"
] as const;

export type CustomerCampaignRecipientStatus =
  (typeof customerCampaignRecipientStatuses)[number];

export interface ICustomerCampaignRecipient {
  restaurantId: Types.ObjectId;
  campaignId: Types.ObjectId;
  customerProfileId: Types.ObjectId;
  customerPhone: string;
  campaignVersion: number;
  qualificationReason: string;
  consentSnapshotUpdatedAt: Date;
  status: CustomerCampaignRecipientStatus;
  outboundMessageId?: Types.ObjectId;
  providerMessageId?: string;
  attemptedAt?: Date;
  sentAt?: Date;
  failureReason?: string;
}

export interface ICustomerCampaignRecipientDocument
  extends ICustomerCampaignRecipient,
    Document {
  createdAt: Date;
  updatedAt: Date;
}

const customerCampaignRecipientSchema =
  new Schema<ICustomerCampaignRecipientDocument>(
    {
      restaurantId: {
        type: Schema.Types.ObjectId,
        ref: "Restaurant",
        required: true,
        index: true
      },
      campaignId: {
        type: Schema.Types.ObjectId,
        ref: "CustomerCampaign",
        required: true,
        index: true
      },
      customerProfileId: {
        type: Schema.Types.ObjectId,
        ref: "CustomerProfile",
        required: true
      },
      customerPhone: {
        type: String,
        required: true,
        trim: true
      },
      campaignVersion: {
        type: Number,
        required: true,
        min: 1
      },
      qualificationReason: {
        type: String,
        required: true,
        trim: true,
        maxlength: 300
      },
      consentSnapshotUpdatedAt: {
        type: Date,
        required: true
      },
      status: {
        type: String,
        enum: customerCampaignRecipientStatuses,
        default: "pending",
        required: true,
        index: true
      },
      outboundMessageId: {
        type: Schema.Types.ObjectId,
        ref: "OutboundMessage"
      },
      providerMessageId: {
        type: String,
        trim: true
      },
      attemptedAt: Date,
      sentAt: Date,
      failureReason: {
        type: String,
        trim: true
      }
    },
    {
      timestamps: true
    }
  );

customerCampaignRecipientSchema.index({
  campaignId: 1,
  status: 1
});
customerCampaignRecipientSchema.index({
  restaurantId: 1,
  campaignId: 1,
  campaignVersion: 1,
  status: 1
});
customerCampaignRecipientSchema.index(
  {
    campaignId: 1,
    campaignVersion: 1,
    customerPhone: 1
  },
  {
    unique: true,
    name: "campaign_recipient_version_phone_unique"
  }
);
customerCampaignRecipientSchema.index({
  restaurantId: 1,
  customerPhone: 1
});

export const CustomerCampaignRecipient =
  model<ICustomerCampaignRecipientDocument>(
    "CustomerCampaignRecipient",
    customerCampaignRecipientSchema
  );

export const ensureCustomerCampaignRecipientIndexes =
  async (): Promise<void> => {
    await CustomerCampaignRecipient.collection.createIndex(
      {
        campaignId: 1,
        campaignVersion: 1,
        customerPhone: 1
      },
      {
        unique: true,
        name: "campaign_recipient_version_phone_unique"
      }
    );

    const indexes =
      await CustomerCampaignRecipient.collection.indexes();
    const legacyIndex = indexes.find(
      (index) =>
        index.unique === true &&
        index.name !== "campaign_recipient_version_phone_unique" &&
        index.key.campaignId === 1 &&
        index.key.customerPhone === 1 &&
        !("campaignVersion" in index.key)
    );

    if (legacyIndex?.name) {
      await CustomerCampaignRecipient.collection.dropIndex(
        legacyIndex.name
      );
    }
  };
