import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { AdminAuditLog, type IAdminAuditLog } from "../models/adminAuditLog.model";
import type { IUserDocument } from "../models/User";
import {
  markRuntimeRunFailed,
  markRuntimeRunStarted,
  markRuntimeRunSucceeded,
  markRuntimeStarted
} from "./runtimeHealth.service";

export const adminAuditActions = [
  "restaurant.create",
  "restaurant.update",
  "restaurant.status.update",
  "restaurant.plan.update",
  "restaurant.subscription.mark_paid",
  "restaurant.delete",
  "menu.category.create",
  "menu.category.update",
  "menu.category.deactivate",
  "menu.category.reorder",
  "menu.item.create",
  "menu.item.update",
  "menu.item.deactivate",
  "menu.item.availability.update",
  "menu.item.image.update",
  "menu.import"
] as const;

export type AdminAuditAction = (typeof adminAuditActions)[number];
export type AuditPersistenceResult = "persisted" | "queued" | "dropped";

const auditRetryIntervalMs = 5_000;
const auditRetryBatchSize = 25;
const maxQueuedAuditEntries = 1_000;
const defaultAuditRetentionDays = 365;
const maxAuditRetentionDays = 2_555;
const sensitiveFieldPattern = /token|secret|password|credential|authorization|private.?key|api.?key/i;
const allowedMetadataKeys = new Set([
  "status",
  "plan",
  "isAvailable",
  "importMode",
  "fileType"
]);

const retryQueue: IAdminAuditLog[] = [];
let retryWorkerStarted = false;
let inFlightAuditEntries = 0;
let activeRetryPass: Promise<{ persisted: number; remaining: number }> | null = null;

const boundedAuditRetentionDays = (): number => {
  const configured = Number(process.env.ADMIN_AUDIT_RETENTION_DAYS);
  if (!Number.isFinite(configured) || configured < 30) return defaultAuditRetentionDays;
  return Math.min(Math.floor(configured), maxAuditRetentionDays);
};

export const adminAuditRetentionDays = boundedAuditRetentionDays();

export interface RecordAdminAuditInput {
  actor: IUserDocument;
  action: AdminAuditAction;
  targetType: "restaurant" | "menu_category" | "menu_item" | "menu_import";
  targetId: string;
  restaurantId?: string;
  changedFields?: string[];
  metadata?: Record<string, unknown>;
}

interface AuditPersistenceDependencies {
  create?: (entry: IAdminAuditLog) => Promise<unknown>;
}

export const sanitizeAuditChangedFields = (fields: string[] = []): string[] =>
  Array.from(
    new Set(
      fields
        .map((field) => field.trim())
        .filter((field) => field && field.length <= 80 && !sensitiveFieldPattern.test(field))
    )
  ).slice(0, 50);

export const sanitizeAuditMetadata = (
  metadata: Record<string, unknown> | undefined
): Record<string, string | number | boolean | null> | undefined => {
  if (!metadata) return undefined;

  const safeMetadata: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!allowedMetadataKeys.has(key) || sensitiveFieldPattern.test(key)) continue;

    if (value === null || typeof value === "boolean" || typeof value === "number") {
      safeMetadata[key] = value;
    } else if (typeof value === "string") {
      safeMetadata[key] = value.trim().slice(0, 120);
    }
  }

  return Object.keys(safeMetadata).length > 0 ? safeMetadata : undefined;
};

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 11000);

const persistEntry = async (
  entry: IAdminAuditLog,
  dependencies: AuditPersistenceDependencies = {}
): Promise<boolean> => {
  if (!dependencies.create && AdminAuditLog.db.readyState !== 1) {
    return false;
  }

  try {
    const create = dependencies.create ?? ((value) => AdminAuditLog.create(value));
    await create(entry);
    return true;
  } catch (error) {
    return isDuplicateKeyError(error);
  }
};

const enqueueRetry = (entry: IAdminAuditLog): AuditPersistenceResult => {
  if (retryQueue.length + inFlightAuditEntries >= maxQueuedAuditEntries) {
    console.error("[adminAudit] Retry queue is full; audit entry was dropped", {
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId
    });
    return "dropped";
  }

  retryQueue.push(entry);
  markRuntimeRunFailed("audit_persistence", "AUDIT_RETRY_PENDING");
  console.warn("[adminAudit] Audit entry queued for retry", {
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    queuedEntries: retryQueue.length
  });
  return "queued";
};

export const recordAdminAudit = async (
  input: RecordAdminAuditInput,
  dependencies: AuditPersistenceDependencies = {}
): Promise<AuditPersistenceResult> => {
  if (input.actor.role !== "super_admin") {
    console.error("[adminAudit] Rejected audit entry without a trusted super-admin actor", {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId
    });
    return "dropped";
  }

  const occurredAt = new Date();
  const entry: IAdminAuditLog = {
    eventId: randomUUID(),
    occurredAt,
    actorId: new Types.ObjectId(String(input.actor._id)),
    actorEmail: input.actor.email,
    actorRole: "super_admin",
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId.slice(0, 120),
    ...(input.restaurantId && Types.ObjectId.isValid(input.restaurantId)
      ? { restaurantId: new Types.ObjectId(input.restaurantId) }
      : {}),
    changedFields: sanitizeAuditChangedFields(input.changedFields),
    ...(sanitizeAuditMetadata(input.metadata)
      ? { metadata: sanitizeAuditMetadata(input.metadata) }
      : {}),
    expiresAt: new Date(
      occurredAt.getTime() + adminAuditRetentionDays * 24 * 60 * 60 * 1000
    )
  };

  if (await persistEntry(entry, dependencies)) {
    return "persisted";
  }

  return enqueueRetry(entry);
};

export const recordAdminAuditAfterMutation = async (
  input: RecordAdminAuditInput
): Promise<AuditPersistenceResult> => {
  try {
    return await recordAdminAudit(input);
  } catch {
    console.error("[adminAudit] Unexpected audit recording failure", {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId
    });
    return "dropped";
  }
};

const runAdminAuditRetryPass = async (
  dependencies: AuditPersistenceDependencies = {}
): Promise<{ persisted: number; remaining: number }> => {
  let persisted = 0;
  const batch = retryQueue.splice(0, auditRetryBatchSize);
  inFlightAuditEntries += batch.length;

  for (const entry of batch) {
    const didPersist = await persistEntry(entry, dependencies);
    inFlightAuditEntries -= 1;

    if (didPersist) {
      persisted += 1;
    } else {
      retryQueue.push(entry);
    }
  }

  return { persisted, remaining: retryQueue.length };
};

export const flushAdminAuditRetryQueue = (
  dependencies: AuditPersistenceDependencies = {}
): Promise<{ persisted: number; remaining: number }> => {
  if (activeRetryPass) {
    return activeRetryPass;
  }

  const pass = runAdminAuditRetryPass(dependencies);
  activeRetryPass = pass;
  void pass
    .finally(() => {
      if (activeRetryPass === pass) {
        activeRetryPass = null;
      }
    })
    .catch(() => undefined);
  return pass;
};

export const startAdminAuditRetryWorker = (): void => {
  if (retryWorkerStarted) return;
  retryWorkerStarted = true;
  markRuntimeStarted("audit_persistence", auditRetryIntervalMs);

  const runPass = (): void => {
    if (activeRetryPass) return;
    markRuntimeRunStarted("audit_persistence");
    void flushAdminAuditRetryQueue()
      .then((result) => {
        if (result.remaining > 0 || inFlightAuditEntries > 0) {
          markRuntimeRunFailed("audit_persistence", "AUDIT_RETRY_PENDING");
        } else {
          markRuntimeRunSucceeded("audit_persistence");
        }
      })
      .catch(() => {
        markRuntimeRunFailed("audit_persistence", "AUDIT_RETRY_FAILED");
      });
  };

  runPass();
  const timer = setInterval(runPass, auditRetryIntervalMs);
  timer.unref?.();
};

export const getQueuedAdminAuditCount = (): number => retryQueue.length;

export const getAdminAuditPersistenceState = () => ({
  queuedEntries: retryQueue.length,
  inFlightEntries: inFlightAuditEntries,
  unresolvedEntries: retryQueue.length + inFlightAuditEntries,
  retryPassRunning: activeRetryPass !== null
});

export const resetAdminAuditStateForTests = (): void => {
  retryQueue.splice(0, retryQueue.length);
  retryWorkerStarted = false;
  inFlightAuditEntries = 0;
  activeRetryPass = null;
};
