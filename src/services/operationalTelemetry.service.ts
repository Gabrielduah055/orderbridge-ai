import { Types } from "mongoose";
import {
  OperationalTelemetry,
  type IOperationalTelemetry,
  type OperationalTelemetryKind
} from "../models/operationalTelemetry.model";
import type { AiUsage } from "./ai/ai.types";
import type { SenderRole } from "../types/agent.types";

const defaultRetentionDays = 30;
const maxRetentionDays = 90;

const boundedRetentionDays = (): number => {
  const configured = Number(process.env.OPERATIONAL_TELEMETRY_RETENTION_DAYS);

  if (!Number.isFinite(configured) || configured < 1) {
    return defaultRetentionDays;
  }

  return Math.min(Math.floor(configured), maxRetentionDays);
};

export const operationalTelemetryRetentionDays = boundedRetentionDays();

export interface OperationalTelemetryInput {
  kind: OperationalTelemetryKind;
  restaurantId?: string;
  senderRole?: SenderRole;
  provider?: string;
  model?: string;
  toolName?: string;
  success: boolean;
  timeout?: boolean;
  errorCode?: string;
  startedAt: Date;
  completedAt?: Date;
  latencyMs?: number;
  usage?: AiUsage;
}

interface OperationalTelemetryDependencies {
  create?: (record: IOperationalTelemetry) => Promise<unknown>;
}

const safeLabel = (value: string | undefined, maxLength: number): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
};

const getExpiry = (completedAt: Date): Date =>
  new Date(completedAt.getTime() + operationalTelemetryRetentionDays * 24 * 60 * 60 * 1000);

export const recordOperationalTelemetry = async (
  input: OperationalTelemetryInput,
  dependencies: OperationalTelemetryDependencies = {}
): Promise<boolean> => {
  const completedAt = input.completedAt ?? new Date();
  const latencyMs = Math.max(
    0,
    Math.round(input.latencyMs ?? completedAt.getTime() - input.startedAt.getTime())
  );
  const record: IOperationalTelemetry = {
    kind: input.kind,
    ...(input.restaurantId && Types.ObjectId.isValid(input.restaurantId)
      ? { restaurantId: new Types.ObjectId(input.restaurantId) }
      : {}),
    ...(input.senderRole ? { senderRole: input.senderRole } : {}),
    ...(safeLabel(input.provider, 80) ? { provider: safeLabel(input.provider, 80) } : {}),
    ...(safeLabel(input.model, 160) ? { model: safeLabel(input.model, 160) } : {}),
    ...(safeLabel(input.toolName, 120) ? { toolName: safeLabel(input.toolName, 120) } : {}),
    success: input.success,
    timeout: Boolean(input.timeout),
    ...(safeLabel(input.errorCode, 120)
      ? { errorCode: safeLabel(input.errorCode, 120) }
      : {}),
    startedAt: input.startedAt,
    completedAt,
    latencyMs,
    ...(Number.isFinite(input.usage?.inputTokens)
      ? { inputTokens: Math.max(0, input.usage?.inputTokens ?? 0) }
      : {}),
    ...(Number.isFinite(input.usage?.outputTokens)
      ? { outputTokens: Math.max(0, input.usage?.outputTokens ?? 0) }
      : {}),
    ...(Number.isFinite(input.usage?.totalTokens)
      ? { totalTokens: Math.max(0, input.usage?.totalTokens ?? 0) }
      : {}),
    expiresAt: getExpiry(completedAt)
  };

  // Do not let Mongoose buffer best-effort telemetry while the application is
  // disconnected. Customer-facing execution must continue immediately.
  if (!dependencies.create && OperationalTelemetry.db.readyState !== 1) {
    return false;
  }

  try {
    const create = dependencies.create ?? ((value) => OperationalTelemetry.create(value));
    await create(record);
    return true;
  } catch {
    console.warn("[operationalTelemetry] Observation was not persisted", {
      kind: record.kind,
      success: record.success,
      errorCode: record.errorCode
    });
    return false;
  }
};

export const observeOperationalTelemetry = (input: OperationalTelemetryInput): void => {
  void recordOperationalTelemetry(input);
};
