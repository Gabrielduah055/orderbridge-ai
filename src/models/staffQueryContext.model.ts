import { Schema, model, type Document, type Types } from "mongoose";
import type { OrderStatus } from "./order.model";

export interface IStaffOrderQueryContext {
  restaurantId: Types.ObjectId;
  senderPhone: string;
  senderRole: "owner" | "manager";
  periodType: string;
  periodLabel: string;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
  status?: OrderStatus;
  customerPhone?: string;
  customerName?: string;
  expiresAt: Date;
}

export interface IStaffOrderQueryContextDocument
  extends IStaffOrderQueryContext,
    Document {
  createdAt: Date;
  updatedAt: Date;
}

const staffOrderQueryContextSchema =
  new Schema<IStaffOrderQueryContextDocument>(
    {
      restaurantId: {
        type: Schema.Types.ObjectId,
        ref: "Restaurant",
        required: true
      },
      senderPhone: { type: String, required: true, trim: true },
      senderRole: {
        type: String,
        enum: ["owner", "manager"],
        required: true
      },
      periodType: { type: String, required: true, trim: true },
      periodLabel: { type: String, required: true, trim: true },
      periodStart: { type: Date, required: true },
      periodEnd: { type: Date, required: true },
      timezone: { type: String, required: true, trim: true },
      status: { type: String, trim: true },
      customerPhone: { type: String, trim: true },
      customerName: { type: String, trim: true },
      expiresAt: { type: Date, required: true, index: true }
    },
    { timestamps: true }
  );

staffOrderQueryContextSchema.index(
  { restaurantId: 1, senderPhone: 1 },
  { unique: true, name: "staff_order_query_context_scope_unique" }
);
staffOrderQueryContextSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "staff_order_query_context_expiry" }
);

export const StaffOrderQueryContext =
  model<IStaffOrderQueryContextDocument>(
    "StaffOrderQueryContext",
    staffOrderQueryContextSchema
  );
