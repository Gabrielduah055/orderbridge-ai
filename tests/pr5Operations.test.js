const assert = require("node:assert/strict");
const test = require("node:test");

const { requireSuperAdmin } = require("../dist/middleware/requireSuperAdmin");
const {
  flushAdminAuditRetryQueue,
  getQueuedAdminAuditCount,
  recordAdminAudit,
  resetAdminAuditStateForTests
} = require("../dist/services/adminAudit.service");
const {
  summarizeAgentTelemetryRecords
} = require("../dist/services/adminOperations.service");
const {
  recordOperationalTelemetry
} = require("../dist/services/operationalTelemetry.service");
const {
  getRuntimeHealthSnapshot,
  markRuntimeRunStarted,
  markRuntimeRunSucceeded,
  markRuntimeStarted,
  resetRuntimeHealthForTests
} = require("../dist/services/runtimeHealth.service");

const actorId = "64b000000000000000000a01";

const makeResponse = () => {
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  return response;
};

test("admin diagnostics reject non-super-admin users", () => {
  const response = makeResponse();
  let nextCalled = false;

  requireSuperAdmin(
    { user: { role: "restaurant_admin" } },
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(response.statusCode, 403);
  assert.equal(nextCalled, false);
});

test("admin diagnostics allow authenticated super-admin users", () => {
  const response = makeResponse();
  let nextCalled = false;

  requireSuperAdmin(
    { user: { role: "super_admin" } },
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(nextCalled, true);
});

test("runtime snapshots keep generated time separate from observation freshness", () => {
  resetRuntimeHealthForTests();
  markRuntimeStarted("follow_up_scheduler", 60_000);

  const beforeObservation = getRuntimeHealthSnapshot(
    "follow_up_scheduler",
    new Date("2026-10-06T10:00:00.000Z")
  );
  assert.equal(beforeObservation.status, "unknown");
  assert.equal(beforeObservation.observedAt, null);

  const observedAt = new Date("2026-10-06T10:00:00.000Z");
  markRuntimeRunStarted("follow_up_scheduler", observedAt);
  markRuntimeRunSucceeded("follow_up_scheduler", observedAt);

  const fresh = getRuntimeHealthSnapshot(
    "follow_up_scheduler",
    new Date("2026-10-06T10:02:59.000Z")
  );
  const stale = getRuntimeHealthSnapshot(
    "follow_up_scheduler",
    new Date("2026-10-06T10:03:01.000Z")
  );

  assert.equal(fresh.status, "healthy");
  assert.equal(stale.status, "stale");
  assert.equal(stale.observedAt.toISOString(), observedAt.toISOString());
  assert.equal(stale.staleAfterSeconds, 180);
});

test("agent, provider, and tool metrics are counted independently", () => {
  const completedAt = new Date("2026-10-06T10:00:00.000Z");
  const summary = summarizeAgentTelemetryRecords(
    [
      { kind: "agent_turn", success: true, latencyMs: 300, completedAt, totalTokens: 20 },
      { kind: "provider_request", success: true, latencyMs: 200, completedAt, provider: "openrouter" },
      { kind: "tool_execution", success: false, latencyMs: 50, completedAt, toolName: "list_orders" }
    ],
    new Date("2026-10-06T10:01:00.000Z")
  );

  assert.equal(summary.agentTurns.count, 1);
  assert.equal(summary.providerRequests.count, 1);
  assert.equal(summary.toolExecutions.count, 1);
  assert.equal(summary.agentTurns.usage.totalTokens, 20);
});

test("telemetry persistence failure is isolated from agent execution", async () => {
  const persisted = await recordOperationalTelemetry(
    {
      kind: "provider_request",
      restaurantId: "64b000000000000000000b01",
      provider: "openrouter",
      model: "safe-model-label",
      success: false,
      errorCode: "PROVIDER_TIMEOUT",
      timeout: true,
      startedAt: new Date("2026-10-06T10:00:00.000Z")
    },
    {
      create: async () => {
        throw new Error("database unavailable with secret provider payload");
      }
    }
  );

  assert.equal(persisted, false);
});

test("failed audit persistence queues a redacted trusted-actor record without failing the mutation", async () => {
  resetAdminAuditStateForTests();
  const actor = {
    _id: actorId,
    email: "admin@example.com",
    role: "super_admin"
  };

  const result = await recordAdminAudit(
    {
      actor,
      action: "restaurant.update",
      targetType: "restaurant",
      targetId: "64b000000000000000000b01",
      restaurantId: "64b000000000000000000b01",
      changedFields: ["name", "wasenderApiToken", "password"],
      metadata: {
        status: "active",
        token: "must-not-persist",
        customerName: "must-not-persist"
      }
    },
    {
      create: async () => {
        throw new Error("temporary audit database failure");
      }
    }
  );

  assert.equal(result, "queued");
  assert.equal(getQueuedAdminAuditCount(), 1);

  let captured;
  const flushed = await flushAdminAuditRetryQueue({
    create: async (entry) => {
      captured = entry;
    }
  });

  assert.deepEqual(flushed, { persisted: 1, remaining: 0 });
  assert.equal(String(captured.actorId), actorId);
  assert.equal(captured.actorEmail, actor.email);
  assert.deepEqual(captured.changedFields, ["name"]);
  assert.deepEqual(captured.metadata, { status: "active" });
  assert.equal(JSON.stringify(captured).includes("must-not-persist"), false);
});
