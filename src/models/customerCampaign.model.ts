import { Schema, model, type Document, type Types } from "mongoose";
import type { SenderRole } from "../types/agent.types";

export const customerCampaignStatuses = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "sending",
  "sent",
  "partially_failed",
  "failed",
  "cancelled"
] as const;

export const customerCampaignTypes = [
  "promotion",
  "inactivity_reengagement",
  "holiday",
  "announcement"
] as const;

export const customerCampaignTargetingTypes = [
  "all_eligible_customers",
  "inactive_customers",
  "returning_customers",
  "ordered_menu_item",
  "last_order_date_range"
] as const;

export type CustomerCampaignStatus =
  (typeof customerCampaignStatuses)[number];
export type CustomerCampaignType =
  (typeof customerCampaignTypes)[number];
export type CustomerCampaignTargetingType =
  (typeof customerCampaignTargetingTypes)[number];

export interface CustomerCampaignTargetingRule {
  type: CustomerCampaignTargetingType;
  inactiveDays?: number;
  menuItemId?: Types.ObjectId;
  startDate?: Date;
  endDate?: Date;
}

export interface ICustomerCampaign {
  restaurantId: Types.ObjectId;
  name: string;
  message: string;
  campaignType: CustomerCampaignType;
  targeting: CustomerCampaignTargetingRule;
  timezone: string;
  status: CustomerCampaignStatus;
  campaignVersion: number;
  referencedMenuItemId?: Types.ObjectId;
  createdByPhone: string;
  createdByRole: Extract<SenderRole, "owner" | "manager">;
  approvedByPhone?: string;
  approvedByRole?: Extract<SenderRole, "owner" | "manager">;
  approvedAt?: Date;
  scheduledAt?: Date;
  sendingStartedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  failureReason?: string;
  estimatedRecipientCount: number;
  totalRecipientCount: number;
  queuedRecipientCount: number;
  sentRecipientCount: number;
  failedRecipientCount: number;
  cancelledRecipientCount: number;
  excludedNoConsentCount: number;
  excludedOptOutCount: number;
  excludedInvalidPhoneCount: number;
}

export interface ICustomerCampaignDocument
  extends ICustomerCampaign,
    Document {
  createdAt: Date;
  updatedAt: Date;
}

const targetingSchema = new Schema<CustomerCampaignTargetingRule>(
  {
    type: {
      type: String,
      enum: customerCampaignTargetingTypes,
      required: true
    },
    inactiveDays: {
      type: Number,
      min: 1,
      max: 3650
    },
    menuItemId: {
      type: Schema.Types.ObjectId,
      ref: "MenuItem"
    },
    startDate: {
      type: Date
    },
    endDate: {
      type: Date
    }
  },
  {
    _id: false
  }
);

const customerCampaignSchema = new Schema<ICustomerCampaignDocument>(
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
      trim: true,
      maxlength: 120
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000
    },
    campaignType: {
      type: String,
      enum: customerCampaignTypes,
      required: true
    },
    targeting: {
      type: targetingSchema,
      required: true
    },
    timezone: {
      type: String,
      required: true,
      trim: true,
      default: "Africa/Accra",
      validate: {
        validator: (value: string) => {
          try {
            new Intl.DateTimeFormat("en-US", {
              timeZone: value
            }).format();
            return true;
          } catch {
            return false;
          }
        },
        message: "timezone must be a valid IANA timezone"
      }
    },
    status: {
      type: String,
      enum: customerCampaignStatuses,
      required: true,
      default: "draft",
      index: true
    },
    campaignVersion: {
      type: Number,
      required: true,
      default: 1,
      min: 1
    },
    referencedMenuItemId: {
      type: Schema.Types.ObjectId,
      ref: "MenuItem"
    },
    createdByPhone: {
      type: String,
      required: true,
      trim: true
    },
    createdByRole: {
      type: String,
      enum: ["owner", "manager"],
      required: true
    },
    approvedByPhone: {
      type: String,
      trim: true
    },
    approvedByRole: {
      type: String,
      enum: ["owner", "manager"]
    },
    approvedAt: Date,
    scheduledAt: {
      type: Date,
      index: true
    },
    sendingStartedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    failureReason: {
      type: String,
      trim: true
    },
    estimatedRecipientCount: {
      type: Number,
      min: 0,
      default: 0
    },
    totalRecipientCount: {
      type: Number,
      min: 0,
      default: 0
    },
    queuedRecipientCount: {
      type: Number,
      min: 0,
      default: 0
    },
    sentRecipientCount: {
      type: Number,
      min: 0,
      default: 0
    },
    failedRecipientCount: {
      type: Number,
      min: 0,
      default: 0
    },
    cancelledRecipientCount: {
      type: Number,
      min: 0,
      default: 0
    },
    excludedNoConsentCount: {
      type: Number,
      min: 0,
      default: 0
    },
    excludedOptOutCount: {
      type: Number,
      min: 0,
      default: 0
    },
    excludedInvalidPhoneCount: {
      type: Number,
      min: 0,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

customerCampaignSchema.index({
  restaurantId: 1,
  status: 1,
  scheduledAt: 1
});

const versionedCampaignFields = [
  "name",
  "message",
  "campaignType",
  "targeting",
  "timezone",
  "scheduledAt",
  "referencedMenuItemId"
];

customerCampaignSchema.pre("save", function incrementCampaignVersion(next) {
  if (
    !this.isNew &&
    versionedCampaignFields.some((field) => this.isModified(field))
  ) {
    this.campaignVersion = (this.campaignVersion ?? 1) + 1;
  }

  next();
});

export const CustomerCampaign = model<ICustomerCampaignDocument>(
  "CustomerCampaign",
  customerCampaignSchema
);
