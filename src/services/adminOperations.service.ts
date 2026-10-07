import mongoose, { Types } from "mongoose";
import { AdminAuditLog } from "../models/adminAuditLog.model";
import { OperationalTelemetry } from "../models/operationalTelemetry.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { Restaurant } from "../models/Restaurant";
import { WebhookEvent } from "../models/webhookEvent.model";
import {
  adminAuditRetentionDays,
  getAdminAuditPersistenceState,
  sanitizeAuditChangedFields,
  sanitizeAuditMetadata
} from "./adminAudit.service";
import { operationalTelemetryRetentionDays } from "./operationalTelemetry.service";
import { getAllRuntimeHealthSnapshots } from "./runtimeHealth.service";

const maxOperationalRecords = 5_000;
const whatsappObservationStaleAfterSeconds = 24 * 60 * 60;
const agentObservationStaleAfterSeconds = 60 * 60;
const defaultMongoPingDeadlineMs = 1_500;
const defaultMongoBacklogDeadlineMs = 2_000;
const processStartedAt = new Date(Date.now() - process.uptime() * 1000);

type LeanRecord = Record<string, unknown>;

class DiagnosticDeadlineError extends Error {}

const withDeadline = async <T>(operation: Promise<T>, deadlineMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DiagnosticDeadlineError("Diagnostic deadline exceeded")),
      Math.max(1, deadlineMs)
    );

    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const safeDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

const safeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const getFreshness = (
  observedAt: Date | null,
  staleAfterSeconds: number,
  now: Date
): "fresh" | "stale" | "unknown" => {
  if (!observedAt) return "unknown";
  return now.getTime() - observedAt.getTime() > staleAfterSeconds * 1000
    ? "stale"
    : "fresh";
};

const maskSessionReference = (sessionId: string): string => {
  if (sessionId.length <= 4) return "••••";
  return `••••${sessionId.slice(-4)}`;
};

const percentile = (values: number[], percentileValue: number): number | null => {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1)
  );
  return ordered[index];
};

const average = (values: number[]): number | null =>
  values.length > 0
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;

const buildMetricSummary = (records: LeanRecord[]) => {
  const latencies = records
    .map((record) => Number(record.latencyMs))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const lastObservedAt = records.reduce<Date | null>((latest, record) => {
    const date = safeDate(record.completedAt);
    return date && (!latest || date > latest) ? date : latest;
  }, null);

  return {
    count: records.length,
    successes: records.filter((record) => record.success === true).length,
    failures: records.filter((record) => record.success === false).length,
    timeouts: records.filter((record) => record.timeout === true).length,
    averageLatencyMs: average(latencies),
    p95LatencyMs: percentile(latencies, 95),
    lastObservedAt
  };
};

export const summarizeAgentTelemetryRecords = (
  records: LeanRecord[],
  generatedAt = new Date()
) => {
  const turns = records.filter((record) => record.kind === "agent_turn");
  const providerRequests = records.filter((record) => record.kind === "provider_request");
  const toolExecutions = records.filter((record) => record.kind === "tool_execution");
  const lastObservedAt = records.reduce<Date | null>((latest, record) => {
    const date = safeDate(record.completedAt);
    return date && (!latest || date > latest) ? date : latest;
  }, null);
  const usage = turns.reduce<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>(
    (totals, record) => ({
      inputTokens: totals.inputTokens + (Number(record.inputTokens) || 0),
      outputTokens: totals.outputTokens + (Number(record.outputTokens) || 0),
      totalTokens: totals.totalTokens + (Number(record.totalTokens) || 0)
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );

  return {
    lastObservedAt,
    freshness: getFreshness(lastObservedAt, agentObservationStaleAfterSeconds, generatedAt),
    agentTurns: { ...buildMetricSummary(turns), usage },
    providerRequests: {
      ...buildMetricSummary(providerRequests),
      byProvider: groupMetrics(providerRequests, "provider")
    },
    toolExecutions: {
      ...buildMetricSummary(toolExecutions),
      byTool: groupMetrics(toolExecutions, "toolName")
    }
  };
};

const groupMetrics = (records: LeanRecord[], key: "provider" | "toolName") => {
  const groups = new Map<string, LeanRecord[]>();

  for (const record of records) {
    const label = safeString(record[key]) ?? "unknown";
    groups.set(label, [...(groups.get(label) ?? []), record]);
  }

  return Array.from(groups.entries())
    .map(([name, entries]) => ({ name, ...buildMetricSummary(entries) }))
    .sort((left, right) => right.count - left.count);
};

export interface OperationsWindow {
  from: Date;
  to: Date;
}

interface WhatsAppOperationsDependencies {
  loadRestaurants?: (filter: Record<string, unknown>, limit: number) => Promise<LeanRecord[]>;
  loadInboundActivity?: (
    sessionIds: string[],
    window: OperationsWindow,
    limit: number
  ) => Promise<LeanRecord[]>;
  loadOutboundActivity?: (
    restaurantIds: unknown[],
    window: OperationsWindow,
    limit: number
  ) => Promise<LeanRecord[]>;
}

const latestDateInWindow = (
  record: LeanRecord,
  fields: string[],
  window: OperationsWindow
): Date | null =>
  fields.reduce<Date | null>((latest, field) => {
    const date = safeDate(record[field]);
    if (!date || date < window.from || date > window.to) return latest;
    return !latest || date > latest ? date : latest;
  }, null);

const loadWhatsAppRestaurants = async (
  filter: Record<string, unknown>,
  limit: number
): Promise<LeanRecord[]> =>
  (await Restaurant.find(filter)
    .select("_id name wasenderSessionId updatedAt +wasenderApiToken")
    .sort({ _id: 1 })
    .limit(limit)
    .lean()) as unknown as LeanRecord[];

const loadInboundActivity = async (
  sessionIds: string[],
  window: OperationsWindow,
  limit: number
): Promise<LeanRecord[]> => {
  if (sessionIds.length === 0) return [];

  return (await WebhookEvent.aggregate([
    {
      $match: {
        sessionId: { $in: sessionIds },
        $or: [
          { processedAt: { $gte: window.from, $lte: window.to } },
          { updatedAt: { $gte: window.from, $lte: window.to } },
          { createdAt: { $gte: window.from, $lte: window.to } }
        ]
      }
    },
    {
      $addFields: {
        diagnosticActivityAt: { $max: ["$processedAt", "$updatedAt", "$createdAt"] }
      }
    },
    { $match: { diagnosticActivityAt: { $gte: window.from, $lte: window.to } } },
    { $sort: { diagnosticActivityAt: -1, _id: -1 } },
    { $limit: limit },
    {
      $project: {
        restaurantId: 1,
        sessionId: 1,
        status: 1,
        createdAt: 1,
        updatedAt: 1,
        processedAt: 1,
        diagnosticActivityAt: 1
      }
    }
  ])) as LeanRecord[];
};

const loadOutboundActivity = async (
  restaurantIds: unknown[],
  window: OperationsWindow,
  limit: number
): Promise<LeanRecord[]> => {
  if (restaurantIds.length === 0) return [];

  return (await OutboundMessage.aggregate([
    {
      $match: {
        restaurantId: { $in: restaurantIds },
        $or: [
          { sentAt: { $gte: window.from, $lte: window.to } },
          { lastAttemptAt: { $gte: window.from, $lte: window.to } },
          { createdAt: { $gte: window.from, $lte: window.to } }
        ]
      }
    },
    {
      $addFields: {
        diagnosticActivityAt: { $max: ["$sentAt", "$lastAttemptAt", "$createdAt"] }
      }
    },
    { $match: { diagnosticActivityAt: { $gte: window.from, $lte: window.to } } },
    { $sort: { diagnosticActivityAt: -1, _id: -1 } },
    { $limit: limit },
    {
      $project: {
        restaurantId: 1,
        sessionId: 1,
        status: 1,
        attempts: 1,
        createdAt: 1,
        sentAt: 1,
        lastAttemptAt: 1,
        diagnosticActivityAt: 1
      }
    }
  ])) as LeanRecord[];
};

export const getWhatsAppOperations = async (input: {
  window: OperationsWindow;
  limit: number;
  after?: string;
}, dependencies: WhatsAppOperationsDependencies = {}) => {
  const generatedAt = new Date();
  const restaurantFilter =
    input.after && Types.ObjectId.isValid(input.after)
      ? { _id: { $gt: new Types.ObjectId(input.after) } }
      : {};
  const restaurants = await (dependencies.loadRestaurants ?? loadWhatsAppRestaurants)(
    restaurantFilter,
    input.limit + 1
  );
  const hasMore = restaurants.length > input.limit;
  const page = restaurants.slice(0, input.limit);
  const restaurantIds = page.map((restaurant) => restaurant._id).filter(Boolean);
  const sessionIds = page
    .map((restaurant) => safeString(restaurant.wasenderSessionId))
    .filter((value): value is string => Boolean(value));

  const [webhooks, outboundMessages] = await Promise.all([
    (dependencies.loadInboundActivity ?? loadInboundActivity)(
      sessionIds,
      input.window,
      maxOperationalRecords + 1
    ),
    (dependencies.loadOutboundActivity ?? loadOutboundActivity)(
      restaurantIds,
      input.window,
      maxOperationalRecords + 1
    )
  ]);

  const inboundActivity = webhooks
    .map((record) => ({
      record,
      activityAt: latestDateInWindow(
        record,
        ["diagnosticActivityAt", "processedAt", "updatedAt", "createdAt"],
        input.window
      )
    }))
    .filter((entry): entry is { record: LeanRecord; activityAt: Date } => Boolean(entry.activityAt))
    .sort((left, right) => right.activityAt.getTime() - left.activityAt.getTime());
  const outboundActivity = outboundMessages
    .map((record) => ({
      record,
      activityAt: latestDateInWindow(
        record,
        ["diagnosticActivityAt", "sentAt", "lastAttemptAt", "createdAt"],
        input.window
      )
    }))
    .filter((entry): entry is { record: LeanRecord; activityAt: Date } => Boolean(entry.activityAt))
    .sort((left, right) => right.activityAt.getTime() - left.activityAt.getTime());
  const inboundTruncated = inboundActivity.length > maxOperationalRecords;
  const outboundTruncated = outboundActivity.length > maxOperationalRecords;
  const boundedWebhooks = inboundActivity.slice(0, maxOperationalRecords);
  const boundedOutbound = outboundActivity.slice(0, maxOperationalRecords);

  const sessions = page.map((restaurant) => {
    const restaurantId = String(restaurant._id);
    const sessionId = safeString(restaurant.wasenderSessionId);
    const inbound = boundedWebhooks.filter(
      ({ record }) =>
        String(record.restaurantId ?? "") === restaurantId ||
        Boolean(sessionId && record.sessionId === sessionId)
    );
    const outbound = boundedOutbound.filter(
      ({ record }) => String(record.restaurantId ?? "") === restaurantId
    );
    const lastInbound = inbound[0];
    const lastOutbound = outbound[0];
    const lastInboundAt = lastInbound?.activityAt ?? null;
    const lastOutboundAt = lastOutbound?.activityAt ?? null;

    return {
      restaurantId,
      restaurantName: safeString(restaurant.name) ?? "Unnamed restaurant",
      configuration: {
        status: sessionId ? "configured" : "not_configured",
        sessionReference: sessionId ? maskSessionReference(sessionId) : null,
        apiTokenConfigured: Boolean(safeString(restaurant.wasenderApiToken)),
        observedAt: generatedAt
      },
      providerConnection: {
        status: "unknown",
        reason: "not_monitored",
        observedAt: null
      },
      inbound: {
        status: lastInbound
          ? lastInbound.record.status === "failed"
            ? "failure_observed"
            : "activity_observed"
          : "unknown",
        observedAt: lastInboundAt,
        freshness: getFreshness(
          lastInboundAt,
          whatsappObservationStaleAfterSeconds,
          generatedAt
        ),
        staleAfterSeconds: whatsappObservationStaleAfterSeconds,
        processed: inbound.filter(({ record }) => record.status === "processed").length,
        failed: inbound.filter(({ record }) => record.status === "failed").length
      },
      outbound: {
        status: lastOutbound ? safeString(lastOutbound.record.status) ?? "unknown" : "unknown",
        observedAt: lastOutboundAt,
        freshness: getFreshness(
          lastOutboundAt,
          whatsappObservationStaleAfterSeconds,
          generatedAt
        ),
        staleAfterSeconds: whatsappObservationStaleAfterSeconds,
        sent: outbound.filter(({ record }) => record.status === "sent").length,
        failed: outbound.filter(({ record }) => record.status === "failed").length,
        pending: outbound.filter(({ record }) => record.status === "pending").length
      }
    };
  });

  return {
    generatedAt,
    window: input.window,
    sample: {
      limit: maxOperationalRecords,
      truncated: inboundTruncated || outboundTruncated,
      inboundTruncated,
      outboundTruncated,
      countsRepresent: "records_with_activity_in_window"
    },
    summary: {
      total: sessions.length,
      configured: sessions.filter((session) => session.configuration.status === "configured").length,
      notConfigured: sessions.filter(
        (session) => session.configuration.status === "not_configured"
      ).length,
      providerConnectionMonitored: 0
    },
    sessions,
    nextCursor: hasMore ? String(page[page.length - 1]?._id ?? "") : null
  };
};

export const getAgentOperations = async (input: {
  window: OperationsWindow;
  restaurantId?: string;
}) => {
  const generatedAt = new Date();
  const filter = {
    startedAt: { $gte: input.window.from, $lte: input.window.to },
    ...(input.restaurantId && Types.ObjectId.isValid(input.restaurantId)
      ? { restaurantId: new Types.ObjectId(input.restaurantId) }
      : {})
  };
  const telemetry = (await OperationalTelemetry.find(filter)
    .select(
      "kind restaurantId senderRole provider model toolName success timeout errorCode startedAt completedAt latencyMs inputTokens outputTokens totalTokens"
    )
    .sort({ startedAt: -1 })
    .limit(maxOperationalRecords + 1)
    .lean()) as unknown as LeanRecord[];
  const truncated = telemetry.length > maxOperationalRecords;
  const records = telemetry.slice(0, maxOperationalRecords);
  const summary = summarizeAgentTelemetryRecords(records, generatedAt);

  return {
    generatedAt,
    window: input.window,
    monitoring: {
      status: records.length > 0 ? "observed" : "unknown",
      reason: records.length > 0 ? null : "no_observation",
      observedAt: summary.lastObservedAt,
      freshness: summary.freshness,
      staleAfterSeconds: agentObservationStaleAfterSeconds,
      retentionDays: operationalTelemetryRetentionDays,
      sampleLimit: maxOperationalRecords,
      truncated
    },
    agentTurns: summary.agentTurns,
    providerRequests: summary.providerRequests,
    toolExecutions: summary.toolExecutions,
    recentFailures: records
      .filter((record) => record.success === false)
      .slice(0, 20)
      .map((record) => ({
        kind: record.kind,
        restaurantId: record.restaurantId ? String(record.restaurantId) : null,
        senderRole: safeString(record.senderRole) ?? null,
        provider: safeString(record.provider) ?? null,
        model: safeString(record.model) ?? null,
        toolName: safeString(record.toolName) ?? null,
        errorCode: safeString(record.errorCode) ?? "UNKNOWN_FAILURE",
        timeout: record.timeout === true,
        latencyMs: Number(record.latencyMs) || 0,
        observedAt: safeDate(record.completedAt)
      }))
  };
};

interface QueueBacklogValues {
  pending: number;
  due: number;
  sending: number;
  failedLast24h: number;
  oldestPendingAt: Date | null;
  lastAttemptAt: Date | null;
}

type QueueBacklogUnavailableReason =
  | "mongodb_disconnected"
  | "mongodb_ping_failed"
  | "mongodb_ping_timeout"
  | "query_failed"
  | "query_timeout";

interface QueueBacklogObservation {
  status: "available" | "unavailable";
  reason: QueueBacklogUnavailableReason | null;
  observedAt: Date | null;
  pending: number | null;
  due: number | null;
  sending: number | null;
  failedLast24h: number | null;
  oldestPendingAt: Date | null;
  lastAttemptAt: Date | null;
}

interface SystemHealthDependencies {
  now?: () => Date;
  getMongoReadyState?: () => number;
  pingMongo?: () => Promise<void>;
  loadQueueBacklog?: (generatedAt: Date, deadlineMs: number) => Promise<QueueBacklogValues>;
  pingDeadlineMs?: number;
  backlogDeadlineMs?: number;
}

const loadQueueBacklog = async (
  generatedAt: Date,
  deadlineMs: number
): Promise<QueueBacklogValues> => {
  const oneDayAgo = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1000);
  const [pending, due, sending, failedLast24h, oldestPending, latestAttempt] = await Promise.all([
    OutboundMessage.countDocuments({ status: "pending" }).maxTimeMS(deadlineMs).exec(),
    OutboundMessage.countDocuments({ status: "pending", nextAttemptAt: { $lte: generatedAt } })
      .maxTimeMS(deadlineMs)
      .exec(),
    OutboundMessage.countDocuments({ status: "sending" }).maxTimeMS(deadlineMs).exec(),
    OutboundMessage.countDocuments({ status: "failed", updatedAt: { $gte: oneDayAgo } })
      .maxTimeMS(deadlineMs)
      .exec(),
    OutboundMessage.findOne({ status: "pending" })
      .select("createdAt nextAttemptAt")
      .sort({ createdAt: 1 })
      .maxTimeMS(deadlineMs)
      .lean()
      .exec(),
    OutboundMessage.findOne({ lastAttemptAt: { $exists: true } })
      .select("lastAttemptAt")
      .sort({ lastAttemptAt: -1 })
      .maxTimeMS(deadlineMs)
      .lean()
      .exec()
  ]);

  return {
    pending,
    due,
    sending,
    failedLast24h,
    oldestPendingAt: safeDate((oldestPending as unknown as LeanRecord | null)?.createdAt),
    lastAttemptAt: safeDate((latestAttempt as unknown as LeanRecord | null)?.lastAttemptAt)
  };
};

const unavailableBacklog = (
  reason: QueueBacklogUnavailableReason
): QueueBacklogObservation => ({
  status: "unavailable" as const,
  reason,
  observedAt: null,
  pending: null,
  due: null,
  sending: null,
  failedLast24h: null,
  oldestPendingAt: null,
  lastAttemptAt: null
});

export const getSystemHealth = async (dependencies: SystemHealthDependencies = {}) => {
  const now = dependencies.now ?? (() => new Date());
  const generatedAt = now();
  const runtime = getAllRuntimeHealthSnapshots(generatedAt);
  const auditState = getAdminAuditPersistenceState();
  const readyState = dependencies.getMongoReadyState?.() ?? mongoose.connection.readyState;
  const pingDeadlineMs = dependencies.pingDeadlineMs ?? defaultMongoPingDeadlineMs;
  const backlogDeadlineMs = dependencies.backlogDeadlineMs ?? defaultMongoBacklogDeadlineMs;
  const mongoStartedAt = Date.now();
  let mongoStatus: "healthy" | "degraded" | "unknown" = "unknown";
  let mongoObservedAt: Date | null = null;
  let mongoLatencyMs: number | null = null;
  let mongoFailureCode: string | null = null;
  let backlog: QueueBacklogObservation = unavailableBacklog("mongodb_disconnected");

  if (readyState !== 1) {
    mongoStatus = "degraded";
    mongoObservedAt = generatedAt;
    mongoFailureCode = "MONGODB_DISCONNECTED";
  } else {
    const pingMongo =
      dependencies.pingMongo ??
      (async () => {
        if (!mongoose.connection.db) throw new Error("MongoDB handle unavailable");
        await mongoose.connection.db.admin().ping();
      });

    try {
      await withDeadline(pingMongo(), pingDeadlineMs);
      mongoObservedAt = now();
      mongoLatencyMs = Date.now() - mongoStartedAt;
      mongoStatus = "healthy";

      try {
        const values = await withDeadline(
          (dependencies.loadQueueBacklog ?? loadQueueBacklog)(generatedAt, backlogDeadlineMs),
          backlogDeadlineMs
        );
        backlog = {
          status: "available",
          reason: null,
          observedAt: now(),
          ...values
        };
      } catch (error) {
        const timedOut = error instanceof DiagnosticDeadlineError;
        mongoStatus = "degraded";
        mongoObservedAt = now();
        mongoFailureCode = timedOut
          ? "MONGODB_BACKLOG_QUERY_TIMEOUT"
          : "MONGODB_BACKLOG_QUERY_FAILED";
        backlog = unavailableBacklog(timedOut ? "query_timeout" : "query_failed");
      }
    } catch (error) {
      const timedOut = error instanceof DiagnosticDeadlineError;
      mongoStatus = "degraded";
      mongoObservedAt = now();
      mongoFailureCode = timedOut ? "MONGODB_PING_TIMEOUT" : "MONGODB_PING_FAILED";
      backlog = unavailableBacklog(
        timedOut ? "mongodb_ping_timeout" : "mongodb_ping_failed"
      );
    }
  }

  const baseAuditRuntime =
    runtime.find((entry) => entry.name === "audit_persistence") ?? null;
  const auditRuntime =
    baseAuditRuntime && auditState.unresolvedEntries > 0
      ? {
          ...baseAuditRuntime,
          status: "degraded" as const,
          lastFailureCode: "AUDIT_RETRY_PENDING"
        }
      : baseAuditRuntime;

  return {
    generatedAt,
    api: {
      status: "healthy",
      startedAt: processStartedAt,
      observedAt: generatedAt,
      uptimeSeconds: Math.floor(process.uptime())
    },
    mongodb: {
      status: mongoStatus,
      observedAt: mongoObservedAt,
      latencyMs: mongoLatencyMs,
      readyState,
      failureCode: mongoFailureCode
    },
    queue: {
      runtime: runtime.find((entry) => entry.name === "wasender_queue") ?? null,
      backlog
    },
    schedulers: runtime.filter(
      (entry) => entry.name !== "wasender_queue" && entry.name !== "audit_persistence"
    ),
    auditPersistence: {
      runtime: auditRuntime,
      ...auditState
    }
  };
};

export const getAdminAuditLogs = async (input: {
  limit: number;
  after?: string;
  action?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
}) => {
  const generatedAt = new Date();
  const filter: Record<string, unknown> = {};

  if (input.after && Types.ObjectId.isValid(input.after)) {
    filter._id = { $lt: new Types.ObjectId(input.after) };
  }
  if (input.action) filter.action = input.action;
  if (input.actorId && Types.ObjectId.isValid(input.actorId)) {
    filter.actorId = new Types.ObjectId(input.actorId);
  }
  if (input.from || input.to) {
    filter.occurredAt = {
      ...(input.from ? { $gte: input.from } : {}),
      ...(input.to ? { $lte: input.to } : {})
    };
  }

  const logs = (await AdminAuditLog.find(filter)
    .select(
      "occurredAt actorId actorEmail actorRole action targetType targetId restaurantId changedFields metadata"
    )
    .sort({ _id: -1 })
    .limit(input.limit + 1)
    .lean()) as unknown as LeanRecord[];
  const hasMore = logs.length > input.limit;
  const page = logs.slice(0, input.limit);

  return {
    generatedAt,
    retentionDays: adminAuditRetentionDays,
    items: page.map((log) => ({
      id: String(log._id),
      occurredAt: safeDate(log.occurredAt),
      actor: {
        id: String(log.actorId),
        email: safeString(log.actorEmail) ?? "unknown",
        role: "super_admin"
      },
      action: safeString(log.action) ?? "unknown",
      target: {
        type: safeString(log.targetType) ?? "unknown",
        id: safeString(log.targetId) ?? "unknown",
        restaurantId: log.restaurantId ? String(log.restaurantId) : null
      },
      changedFields: sanitizeAuditChangedFields(
        Array.isArray(log.changedFields)
          ? log.changedFields.filter((value): value is string => typeof value === "string")
          : []
      ),
      metadata:
        log.metadata && typeof log.metadata === "object" && !Array.isArray(log.metadata)
          ? sanitizeAuditMetadata(log.metadata as Record<string, unknown>)
          : undefined
    })),
    nextCursor: hasMore ? String(page[page.length - 1]?._id ?? "") : null
  };
};
