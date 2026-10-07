const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { requireSuperAdmin } = require("../dist/middleware/requireSuperAdmin");
const {
  flushAdminAuditRetryQueue,
  getAdminAuditPersistenceState,
  getQueuedAdminAuditCount,
  recordAdminAudit,
  resetAdminAuditStateForTests
} = require("../dist/services/adminAudit.service");
const {
  getSystemHealth,
  getWhatsAppOperations,
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

test("disconnected MongoDB returns partial health without running backlog queries or inventing zeroes", async () => {
  resetRuntimeHealthForTests();
  const observedAt = new Date("2026-10-07T10:00:00.000Z");
  markRuntimeStarted("wasender_queue", 1_000);
  markRuntimeRunStarted("wasender_queue", observedAt);
  markRuntimeRunSucceeded("wasender_queue", observedAt);
  let pingCalls = 0;
  let backlogCalls = 0;

  const health = await getSystemHealth({
    now: () => new Date("2026-10-07T10:00:01.000Z"),
    getMongoReadyState: () => 0,
    pingMongo: async () => {
      pingCalls += 1;
    },
    loadQueueBacklog: async () => {
      backlogCalls += 1;
      throw new Error("must not run");
    }
  });

  assert.equal(pingCalls, 0);
  assert.equal(backlogCalls, 0);
  assert.equal(health.api.status, "healthy");
  assert.equal(health.queue.runtime.status, "healthy");
  assert.equal(health.mongodb.status, "degraded");
  assert.equal(health.mongodb.failureCode, "MONGODB_DISCONNECTED");
  assert.equal(health.queue.backlog.status, "unavailable");
  assert.equal(health.queue.backlog.reason, "mongodb_disconnected");
  assert.equal(health.queue.backlog.observedAt, null);
  assert.equal(health.queue.backlog.pending, null);
  assert.equal(health.queue.backlog.due, null);
  assert.equal(health.queue.backlog.sending, null);
  assert.equal(health.queue.backlog.failedLast24h, null);
});

test("MongoDB ping failure and deadline return bounded partial health snapshots", async () => {
  let backlogCalls = 0;
  const failed = await getSystemHealth({
    getMongoReadyState: () => 1,
    pingMongo: async () => {
      throw new Error("private database error");
    },
    loadQueueBacklog: async () => {
      backlogCalls += 1;
      throw new Error("must not run");
    },
    pingDeadlineMs: 10
  });

  assert.equal(backlogCalls, 0);
  assert.equal(failed.mongodb.status, "degraded");
  assert.equal(failed.mongodb.failureCode, "MONGODB_PING_FAILED");
  assert.equal(failed.queue.backlog.reason, "mongodb_ping_failed");
  assert.equal(JSON.stringify(failed).includes("private database error"), false);

  const startedAt = Date.now();
  const timedOut = await getSystemHealth({
    getMongoReadyState: () => 1,
    pingMongo: () => new Promise(() => undefined),
    pingDeadlineMs: 10
  });

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(timedOut.mongodb.status, "degraded");
  assert.equal(timedOut.mongodb.failureCode, "MONGODB_PING_TIMEOUT");
  assert.equal(timedOut.queue.backlog.reason, "mongodb_ping_timeout");
});

test("backlog query failure and deadline preserve API/runtime health and return unavailable values", async () => {
  const failed = await getSystemHealth({
    getMongoReadyState: () => 1,
    pingMongo: async () => undefined,
    loadQueueBacklog: async () => {
      throw new Error("sensitive query detail");
    },
    backlogDeadlineMs: 10
  });

  assert.equal(failed.api.status, "healthy");
  assert.equal(failed.mongodb.status, "degraded");
  assert.equal(failed.mongodb.failureCode, "MONGODB_BACKLOG_QUERY_FAILED");
  assert.equal(failed.queue.backlog.status, "unavailable");
  assert.equal(failed.queue.backlog.reason, "query_failed");
  assert.equal(failed.queue.backlog.pending, null);
  assert.equal(JSON.stringify(failed).includes("sensitive query detail"), false);

  const startedAt = Date.now();
  const timedOut = await getSystemHealth({
    getMongoReadyState: () => 1,
    pingMongo: async () => undefined,
    loadQueueBacklog: () => new Promise(() => undefined),
    backlogDeadlineMs: 10
  });

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(timedOut.mongodb.failureCode, "MONGODB_BACKLOG_QUERY_TIMEOUT");
  assert.equal(timedOut.queue.backlog.reason, "query_timeout");
  assert.equal(timedOut.queue.backlog.failedLast24h, null);
});

test("WhatsApp observations include older records with processing, retry, or send activity in the window", async () => {
  const window = {
    from: new Date("2026-10-07T10:00:00.000Z"),
    to: new Date("2026-10-07T11:00:00.000Z")
  };
  const restaurantId = "64b000000000000000000b01";
  const result = await getWhatsAppOperations(
    { window, limit: 50 },
    {
      loadRestaurants: async () => [
        {
          _id: restaurantId,
          name: "Observed Restaurant",
          wasenderSessionId: "session-123456",
          wasenderApiToken: "configured-secret"
        }
      ],
      loadInboundActivity: async () => [
        {
          sessionId: "session-123456",
          status: "processed",
          createdAt: new Date("2026-10-06T08:00:00.000Z"),
          processedAt: new Date("2026-10-07T10:30:00.000Z")
        },
        {
          sessionId: "session-123456",
          status: "failed",
          createdAt: new Date("2026-10-06T07:00:00.000Z"),
          updatedAt: new Date("2026-10-07T10:45:00.000Z")
        },
        {
          sessionId: "session-123456",
          status: "processed",
          createdAt: new Date("2026-10-06T06:00:00.000Z")
        }
      ],
      loadOutboundActivity: async () => [
        {
          restaurantId,
          status: "failed",
          createdAt: new Date("2026-10-06T08:00:00.000Z"),
          lastAttemptAt: new Date("2026-10-07T10:20:00.000Z"),
          attempts: 3
        },
        {
          restaurantId,
          status: "sent",
          createdAt: new Date("2026-10-06T09:00:00.000Z"),
          sentAt: new Date("2026-10-07T10:40:00.000Z")
        },
        {
          restaurantId,
          status: "pending",
          createdAt: new Date("2026-10-06T10:00:00.000Z")
        }
      ]
    }
  );

  assert.equal(result.sample.countsRepresent, "records_with_activity_in_window");
  assert.equal(result.sample.truncated, false);
  assert.equal(result.sessions[0].inbound.processed, 1);
  assert.equal(result.sessions[0].inbound.failed, 1);
  assert.equal(
    result.sessions[0].inbound.observedAt.toISOString(),
    "2026-10-07T10:45:00.000Z"
  );
  assert.equal(result.sessions[0].outbound.sent, 1);
  assert.equal(result.sessions[0].outbound.failed, 1);
  assert.equal(result.sessions[0].outbound.pending, 0);
  assert.equal(
    result.sessions[0].outbound.observedAt.toISOString(),
    "2026-10-07T10:40:00.000Z"
  );
});

test("overlapping audit retry triggers share one pass and expose in-flight unresolved work", async () => {
  resetAdminAuditStateForTests();
  resetRuntimeHealthForTests();
  markRuntimeStarted("audit_persistence", 5_000);
  markRuntimeRunStarted("audit_persistence");
  markRuntimeRunSucceeded("audit_persistence");
  const actor = { _id: actorId, email: "admin@example.com", role: "super_admin" };

  await recordAdminAudit(
    {
      actor,
      action: "restaurant.update",
      targetType: "restaurant",
      targetId: "64b000000000000000000b01"
    },
    { create: async () => { throw new Error("queue it"); } }
  );

  let releasePersistence;
  const persistenceGate = new Promise((resolve) => {
    releasePersistence = resolve;
  });
  let createCalls = 0;
  const dependencies = {
    create: async () => {
      createCalls += 1;
      await persistenceGate;
    }
  };

  const firstPass = flushAdminAuditRetryQueue(dependencies);
  const secondPass = flushAdminAuditRetryQueue(dependencies);
  await Promise.resolve();

  assert.equal(createCalls, 1);
  assert.deepEqual(getAdminAuditPersistenceState(), {
    queuedEntries: 0,
    inFlightEntries: 1,
    unresolvedEntries: 1,
    retryPassRunning: true
  });

  const healthWhileRunning = await getSystemHealth({ getMongoReadyState: () => 0 });
  assert.equal(healthWhileRunning.auditPersistence.runtime.status, "degraded");
  assert.equal(healthWhileRunning.auditPersistence.unresolvedEntries, 1);

  releasePersistence();
  const [firstResult, secondResult] = await Promise.all([firstPass, secondPass]);
  assert.deepEqual(firstResult, { persisted: 1, remaining: 0 });
  assert.deepEqual(secondResult, firstResult);
  assert.equal(createCalls, 1);
  assert.equal(getAdminAuditPersistenceState().unresolvedEntries, 0);
});

test("admin router protects all four contracts and controllers preserve the response envelope", async () => {
  const firebaseAuthPath = require.resolve("../dist/middleware/firebaseAuth.middleware");
  const routesPath = require.resolve("../dist/routes/adminOperations.routes");
  const fakeFirebaseAuth = function firebaseAuth(_req, _res, next) { next(); };
  require.cache[firebaseAuthPath] = {
    id: firebaseAuthPath,
    filename: firebaseAuthPath,
    loaded: true,
    exports: { firebaseAuth: fakeFirebaseAuth }
  };
  delete require.cache[routesPath];

  const router = require(routesPath).default;
  assert.equal(router.stack[0].handle, fakeFirebaseAuth);
  assert.equal(router.stack[1].handle, requireSuperAdmin);
  assert.deepEqual(
    router.stack.filter((layer) => layer.route).map((layer) => layer.route.path),
    ["/operations/whatsapp", "/operations/agents", "/operations/health", "/audit-logs"]
  );

  const service = require("../dist/services/adminOperations.service");
  const originals = {
    getWhatsAppOperations: service.getWhatsAppOperations,
    getAgentOperations: service.getAgentOperations,
    getSystemHealth: service.getSystemHealth,
    getAdminAuditLogs: service.getAdminAuditLogs
  };
  const sentinels = {
    whatsapp: { contract: "whatsapp" },
    agents: { contract: "agents" },
    health: { contract: "health" },
    audit: { contract: "audit" }
  };

  try {
    service.getWhatsAppOperations = async () => sentinels.whatsapp;
    service.getAgentOperations = async () => sentinels.agents;
    service.getSystemHealth = async () => sentinels.health;
    service.getAdminAuditLogs = async () => sentinels.audit;
    const controllers = require("../dist/controllers/adminOperations.controller");
    const cases = [
      [controllers.getWhatsAppOperationsController, sentinels.whatsapp, "WhatsApp operations fetched successfully"],
      [controllers.getAgentOperationsController, sentinels.agents, "Agent operations fetched successfully"],
      [controllers.getSystemHealthController, sentinels.health, "System health fetched successfully"],
      [controllers.getAdminAuditLogsController, sentinels.audit, "Admin audit logs fetched successfully"]
    ];

    for (const [controller, data, message] of cases) {
      const response = makeResponse();
      let nextError;
      await controller({ query: {} }, response, (error) => { nextError = error; });
      assert.equal(nextError, undefined);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, { success: true, message, data });
    }
  } finally {
    Object.assign(service, originals);
    delete require.cache[routesPath];
    delete require.cache[firebaseAuthPath];
  }
});

test("authenticated health route returns bounded service unavailable when MongoDB authorization is unavailable", async () => {
  const firebaseConfigPath = require.resolve("../dist/config/firebase");
  const firebaseAuthPath = require.resolve("../dist/middleware/firebaseAuth.middleware");
  const routesPath = require.resolve("../dist/routes/adminOperations.routes");
  const appPath = require.resolve("../dist/app");
  let firebaseVerificationCalls = 0;
  const firebaseAuthClient = {
    verifyIdToken: async (token) => {
      firebaseVerificationCalls += 1;
      assert.equal(token, "verified-firebase-token");
      return { uid: "firebase-user-1" };
    }
  };
  require.cache[firebaseConfigPath] = {
    id: firebaseConfigPath,
    filename: firebaseConfigPath,
    loaded: true,
    exports: { firebaseAdmin: { auth: () => firebaseAuthClient } }
  };
  delete require.cache[firebaseAuthPath];
  delete require.cache[routesPath];
  delete require.cache[appPath];

  const { User } = require("../dist/models/User");
  const originalFindOne = User.findOne;
  let userLookupCalls = 0;
  let server;

  User.findOne = (...args) => {
    userLookupCalls += 1;
    return originalFindOne.apply(User, args);
  };

  try {
    assert.notEqual(User.db.readyState, 1, "test requires a disconnected MongoDB authorization store");
    const { app } = require("../dist/app");
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const startedAt = Date.now();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/admin/operations/health?role=super_admin`,
      {
        headers: {
          authorization: "Bearer verified-firebase-token",
          "x-user-role": "super_admin"
        }
      }
    );
    const elapsedMs = Date.now() - startedAt;
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.deepEqual(body, {
      success: false,
      message: "Authenticated access could not be authorized at this time"
    });
    assert.equal(firebaseVerificationCalls, 1);
    assert.equal(userLookupCalls, 0);
    assert.ok(elapsedMs < 1_000, `expected bounded response, received in ${elapsedMs}ms`);
  } finally {
    User.findOne = originalFindOne;
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    delete require.cache[appPath];
    delete require.cache[routesPath];
    delete require.cache[firebaseAuthPath];
    delete require.cache[firebaseConfigPath];
  }
});
