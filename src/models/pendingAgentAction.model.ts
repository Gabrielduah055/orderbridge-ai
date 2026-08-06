import { Schema, model, type Document, type Types } from "mongoose";

export const pendingAgentActionStatuses = [
  "pending",
  "completed",
  "cancelled",
  "expired",
  "failed"
] as const;

export const ownerAgentActions = [
  "ADD_MENU_ITEM",
  "UPDATE_MENU_PRICE",
  "MARK_ITEM_UNAVAILABLE",
  "MARK_ITEM_AVAILABLE",
  "OWNER_ORDER_SELECTION",
  "MENU_ITEM_IMAGE_CONTEXT",
  "TOOL_CALL"
] as const;

export type PendingAgentActionStatus = (typeof pendingAgentActionStatuses)[number];
export type OwnerAgentAction = (typeof ownerAgentActions)[number];

export interface IPendingAgentAction {
  restaurantId: Types.ObjectId;
  senderPhone: string;
  senderRole?: string;
  action: OwnerAgentAction;
  toolName?: string;
  arguments?: Record<string, unknown>;
  summary?: string;
  data: Record<string, unknown>;
  status: PendingAgentActionStatus;
  confirmationMessage: string;
  resultMessage?: string;
  errorMessage?: string;
  actionVersion: number;
  expiresAt: Date;
}

export interface IPendingAgentActionDocument extends IPendingAgentAction, Document {
  createdAt: Date;
  updatedAt: Date;
}

const tenMinutesFromNow = (): Date => {
  return new Date(Date.now() + 10 * 60 * 1000);
};

const pendingAgentActionSchema = new Schema<IPendingAgentActionDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    senderPhone: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    senderRole: {
      type: String,
      enum: ["owner", "manager", "customer"],
      trim: true
    },
    action: {
      type: String,
      enum: ownerAgentActions,
      required: true
    },
    toolName: {
      type: String,
      trim: true
    },
    arguments: {
      type: Schema.Types.Mixed
    },
    summary: {
      type: String,
      trim: true
    },
    data: {
      type: Schema.Types.Mixed,
      required: true,
      default: {}
    },
    status: {
      type: String,
      enum: pendingAgentActionStatuses,
      default: "pending",
      index: true
    },
    confirmationMessage: {
      type: String,
      required: true,
      trim: true
    },
    resultMessage: {
      type: String,
      trim: true
    },
    errorMessage: {
      type: String,
      trim: true
    },
    actionVersion: {
      type: Number,
      default: 1,
      min: 1
    },
    expiresAt: {
      type: Date,
      required: true,
      default: tenMinutesFromNow,
      index: true
    }
  },
  {
    timestamps: true
  }
);

pendingAgentActionSchema.index({
  restaurantId: 1,
  senderPhone: 1,
  status: 1,
  createdAt: -1
});
pendingAgentActionSchema.index({
  restaurantId: 1,
  status: 1,
  expiresAt: 1,
  updatedAt: 1
});

const versionedActionFields = [
  "senderPhone",
  "senderRole",
  "action",
  "toolName",
  "arguments",
  "summary",
  "data",
  "confirmationMessage",
  "expiresAt"
];

pendingAgentActionSchema.pre("save", function incrementActionVersion(next) {
  if (
    !this.isNew &&
    versionedActionFields.some((field) => this.isModified(field))
  ) {
    this.actionVersion = (this.actionVersion ?? 1) + 1;
  }

  next();
});

export const PendingAgentAction = model<IPendingAgentActionDocument>(
  "PendingAgentAction",
  pendingAgentActionSchema
);
