import { Schema, model, type Types } from "mongoose";
import type { SenderRole } from "../types/agent.types";

export const operationalTelemetryKinds = [
  "agent_turn",
  "provider_request",
  "tool_execution"
] as const;

export type OperationalTelemetryKind = (typeof operationalTelemetryKinds)[number];

export interface IOperationalTelemetry {
  kind: OperationalTelemetryKind;
  restaurantId?: Types.ObjectId;
  senderRole?: SenderRole;
  provider?: string;
  model?: string;
  toolName?: string;
  success: boolean;
  timeout?: boolean;
  errorCode?: string;
  startedAt: Date;
  completedAt: Date;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  expiresAt: Date;
}

const operationalTelemetrySchema = new Schema<IOperationalTelemetry>(
  {
    kind: {
      type: String,
      enum: operationalTelemetryKinds,
      required: true,
      index: true
    },
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      index: true
    },
    senderRole: {
      type: String,
      enum: ["owner", "manager", "customer"]
    },
    provider: {
      type: String,
      trim: true,
      maxlength: 80
    },
    model: {
      type: String,
      trim: true,
      maxlength: 160
    },
    toolName: {
      type: String,
      trim: true,
      maxlength: 120,
      index: true
    },
    success: {
      type: Boolean,
      required: true,
      index: true
    },
    timeout: {
      type: Boolean,
      default: false
    },
    errorCode: {
      type: String,
      trim: true,
      maxlength: 120
    },
    startedAt: {
      type: Date,
      required: true,
      index: true
    },
    completedAt: {
      type: Date,
      required: true
    },
    latencyMs: {
      type: Number,
      required: true,
      min: 0
    },
    inputTokens: {
      type: Number,
      min: 0
    },
    outputTokens: {
      type: Number,
      min: 0
    },
    totalTokens: {
      type: Number,
      min: 0
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

operationalTelemetrySchema.index({ kind: 1, startedAt: -1 });
operationalTelemetrySchema.index({ kind: 1, success: 1, startedAt: -1 });
operationalTelemetrySchema.index({ restaurantId: 1, kind: 1, startedAt: -1 });
operationalTelemetrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OperationalTelemetry = model<IOperationalTelemetry>(
  "OperationalTelemetry",
  operationalTelemetrySchema
);
