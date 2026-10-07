import { Schema, model, type Document, type Types } from "mongoose";

export interface IAdminAuditLog {
  eventId: string;
  occurredAt: Date;
  actorId: Types.ObjectId;
  actorEmail: string;
  actorRole: "super_admin";
  action: string;
  targetType: string;
  targetId: string;
  restaurantId?: Types.ObjectId;
  changedFields: string[];
  metadata?: Record<string, string | number | boolean | null>;
  expiresAt: Date;
}

export interface IAdminAuditLogDocument extends IAdminAuditLog, Document {
  createdAt: Date;
  updatedAt: Date;
}

const adminAuditLogSchema = new Schema<IAdminAuditLogDocument>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    occurredAt: {
      type: Date,
      required: true,
      index: true
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    actorEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    actorRole: {
      type: String,
      enum: ["super_admin"],
      required: true
    },
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      index: true
    },
    targetType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      index: true
    },
    targetId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      index: true
    },
    changedFields: {
      type: [String],
      default: []
    },
    metadata: {
      type: Schema.Types.Mixed
    },
    expiresAt: {
      type: Date,
      required: true
    }
  },
  {
    timestamps: true,
    strict: true
  }
);

adminAuditLogSchema.index({ occurredAt: -1, _id: -1 });
adminAuditLogSchema.index({ action: 1, occurredAt: -1 });
adminAuditLogSchema.index({ actorId: 1, occurredAt: -1 });
adminAuditLogSchema.index({ targetType: 1, targetId: 1, occurredAt: -1 });
adminAuditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminAuditLog = model<IAdminAuditLogDocument>(
  "AdminAuditLog",
  adminAuditLogSchema
);
