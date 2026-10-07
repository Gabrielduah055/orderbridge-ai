import mongoose, { Types } from "mongoose";
import { AdminAuditLog } from "../models/adminAuditLog.model";
import { OperationalTelemetry } from "../models/operationalTelemetry.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { Restaurant } from "../models/Restaurant";
import { WebhookEvent } from "../models/webhookEvent.model";
import {
  getQueuedAdminAuditCount,
  adminAuditRetentionDays,
  sanitizeAuditChangedFields,
  sanitizeAuditMetadata
} from "./adminAudit.service";
import { operationalTelemetryRetentionDays } from "./operationalTelemetry.service";
import { getAllRuntimeHealthSnapshots } from "./runtimeHealth.service";

const maxOperationalRecords = 5_000;
const whatsappObservationStaleAfterSeconds = 24 * 60 * 60;
const agentObservationStaleAfterSeconds = 60 * 60;
const processStartedAt = new Date(Date.now() - process.uptime() * 1000);

type LeanRecord = Record<string, unknown>;

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

export const getWhatsAppOperations = async (input: {
  window: OperationsWindow;
  limit: number;
  after?: string;
}) => {
  const generatedAt = new Date();
  const restaurantFilter =
    input.after && Types.ObjectId.isValid(input.after)
      ? { _id: { $gt: new Types.ObjectId(input.after) } }
      : {};
  const restaurants = (await Restaurant.find(restaurantFilter)
    .select("_id name wasenderSessionId updatedAt +wasenderApiToken")
    .sort({ _id: 1 })
    .limit(input.limit + 1)
    .lean()) as unknown as LeanRecord[];
  const hasMore = restaurants.length > input.limit;
  const page = restaurants.slice(0, input.limit);
  const restaurantIds = page.map((restaurant) => restaurant._id).filter(Boolean);
  const sessionIds = page
    .map((restaurant) => safeString(restaurant.wasenderSessionId))
    .filter((value): value is string => Boolean(value));

  const [webhooks, outboundMessages] = await Promise.all([
    WebhookEvent.find({
      createdAt: { $gte: input.window.from, $lte: input.window.to },
      sessionId: { $in: sessionIds }
    })
      .select("restaurantId sessionId status createdAt processedAt")
      .sort({ createdAt: -1 })
      .limit(maxOperationalRecords + 1)
      .lean(),
    OutboundMessage.find({
      createdAt: { $gte: input.window.from, $lte: input.window.to },
      restaurantId: { $in: restaurantIds }
    })
      .select("restaurantId sessionId status createdAt sentAt lastAttemptAt attempts")
      .sort({ createdAt: -1 })
      .limit(maxOperationalRecords + 1)
      .lean()
  ]);

  const boundedWebhooks = (webhooks as unknown as LeanRecord[]).slice(0, maxOperationalRecords);
  const boundedOutbound = (outboundMessages as unknown as LeanRecord[]).slice(0, maxOperationalRecords);

  const sessions = page.map((restaurant) => {
    const restaurantId = String(restaurant._id);
    const sessionId = safeString(restaurant.wasenderSessionId);
    const inbound = boundedWebhooks.filter(
      (event) =>
        String(event.restaurantId ?? "") === restaurantId ||
        Boolean(sessionId && event.sessionId === sessionId)
    );
    const outbound = boundedOutbound.filter(
      (message) => String(message.restaurantId ?? "") === restaurantId
    );
    const lastInbound = inbound[0];
    const lastOutbound = outbound[0];
    const lastInboundAt = lastInbound
      ? safeDate(lastInbound.processedAt) ?? safeDate(lastInbound.createdAt)
      : null;
    const lastOutboundAt = lastOutbound
      ? safeDate(lastOutbound.sentAt) ??
        safeDate(lastOutbound.lastAttemptAt) ??
        safeDate(lastOutbound.createdAt)
      : null;

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
          ? lastInbound.status === "failed"
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
        processed: inbound.filter((event) => event.status === "processed").length,
        failed: inbound.filter((event) => event.status === "failed").length
      },
      outbound: {
        status: lastOutbound ? safeString(lastOutbound.status) ?? "unknown" : "unknown",
        observedAt: lastOutboundAt,
        freshness: getFreshness(
          lastOutboundAt,
          whatsappObservationStaleAfterSeconds,
          generatedAt
        ),
        staleAfterSeconds: whatsappObservationStaleAfterSeconds,
        sent: outbound.filter((message) => message.status === "sent").length,
        failed: outbound.filter((message) => message.status === "failed").length,
        pending: outbound.filter((message) => message.status === "pending").length
      }
    };
  });

  return {
    generatedAt,
    window: input.window,
    sample: {
      limit: maxOperationalRecords,
      truncated:
        webhooks.length > maxOperationalRecords || outboundMessages.length > maxOperationalRecords
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

export const getSystemHealth = async () => {
  const generatedAt = new Date();
  const mongoStartedAt = Date.now();
  let mongoStatus: "healthy" | "degraded" | "unknown" = "unknown";
  let mongoObservedAt: Date | null = null;
  let mongoLatencyMs: number | null = null;

  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    try {
      await mongoose.connection.db.admin().ping();
      mongoObservedAt = new Date();
      mongoLatencyMs = Date.now() - mongoStartedAt;
      mongoStatus = "healthy";
    } catch {
      mongoObservedAt = new Date();
      mongoLatencyMs = Date.now() - mongoStartedAt;
      mongoStatus = "degraded";
    }
  }

  const oneDayAgo = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1000);
  const [pending, due, sending, failedLast24h, oldestPending, latestAttempt] = await Promise.all([
    OutboundMessage.countDocuments({ status: "pending" }),
    OutboundMessage.countDocuments({ status: "pending", nextAttemptAt: { $lte: generatedAt } }),
    OutboundMessage.countDocuments({ status: "sending" }),
    OutboundMessage.countDocuments({ status: "failed", updatedAt: { $gte: oneDayAgo } }),
    OutboundMessage.findOne({ status: "pending" })
      .select("createdAt nextAttemptAt")
      .sort({ createdAt: 1 })
      .lean(),
    OutboundMessage.findOne({ lastAttemptAt: { $exists: true } })
      .select("lastAttemptAt")
      .sort({ lastAttemptAt: -1 })
      .lean()
  ]);
  const runtime = getAllRuntimeHealthSnapshots(generatedAt);

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
      readyState: mongoose.connection.readyState
    },
    queue: {
      runtime: runtime.find((entry) => entry.name === "wasender_queue") ?? null,
      backlog: {
        observedAt: generatedAt,
        pending,
        due,
        sending,
        failedLast24h,
        oldestPendingAt: safeDate((oldestPending as unknown as LeanRecord | null)?.createdAt),
        lastAttemptAt: safeDate((latestAttempt as unknown as LeanRecord | null)?.lastAttemptAt)
      }
    },
    schedulers: runtime.filter(
      (entry) => entry.name !== "wasender_queue" && entry.name !== "audit_persistence"
    ),
    auditPersistence: {
      runtime: runtime.find((entry) => entry.name === "audit_persistence") ?? null,
      queuedEntries: getQueuedAdminAuditCount()
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
