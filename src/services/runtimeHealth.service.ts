export const runtimeComponentNames = [
  "wasender_queue",
  "follow_up_scheduler",
  "owner_summary_scheduler",
  "owner_pending_action_scheduler",
  "customer_campaign_scheduler",
  "order_feedback_scheduler",
  "subscription_billing_scheduler",
  "audit_persistence"
] as const;

export type RuntimeComponentName = (typeof runtimeComponentNames)[number];
export type RuntimeHealthStatus = "healthy" | "degraded" | "stale" | "unknown" | "not_monitored";

interface RuntimeObservation {
  name: RuntimeComponentName;
  cadenceMs: number;
  staleAfterMs: number;
  startedAt: Date;
  running: boolean;
  lastRunStartedAt?: Date;
  lastRunCompletedAt?: Date;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  lastFailureCode?: string;
}

export interface RuntimeHealthSnapshot {
  name: RuntimeComponentName;
  status: RuntimeHealthStatus;
  cadenceSeconds: number;
  staleAfterSeconds: number;
  startedAt: Date | null;
  running: boolean;
  observedAt: Date | null;
  lastRunStartedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode?: string;
}

const observations = new Map<RuntimeComponentName, RuntimeObservation>();

const defaultStaleAfterMs = (cadenceMs: number): number =>
  Math.max(cadenceMs * 3, 30_000);

export const markRuntimeStarted = (
  name: RuntimeComponentName,
  cadenceMs: number,
  staleAfterMs = defaultStaleAfterMs(cadenceMs)
): void => {
  if (observations.has(name)) {
    return;
  }

  observations.set(name, {
    name,
    cadenceMs,
    staleAfterMs,
    startedAt: new Date(),
    running: false
  });
};

export const markRuntimeRunStarted = (name: RuntimeComponentName, at = new Date()): void => {
  const observation = observations.get(name);
  if (!observation) return;
  observation.running = true;
  observation.lastRunStartedAt = at;
};

export const markRuntimeRunSucceeded = (name: RuntimeComponentName, at = new Date()): void => {
  const observation = observations.get(name);
  if (!observation) return;
  observation.running = false;
  observation.lastRunCompletedAt = at;
  observation.lastSuccessAt = at;
};

export const markRuntimeRunFailed = (
  name: RuntimeComponentName,
  failureCode: string,
  at = new Date()
): void => {
  const observation = observations.get(name);
  if (!observation) return;
  observation.running = false;
  observation.lastRunCompletedAt = at;
  observation.lastFailureAt = at;
  observation.lastFailureCode = failureCode.slice(0, 120);
};

export const getRuntimeHealthSnapshot = (
  name: RuntimeComponentName,
  now = new Date()
): RuntimeHealthSnapshot => {
  const observation = observations.get(name);

  if (!observation) {
    return {
      name,
      status: "not_monitored",
      cadenceSeconds: 0,
      staleAfterSeconds: 0,
      startedAt: null,
      running: false,
      observedAt: null,
      lastRunStartedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null
    };
  }

  const observedAt = observation.lastRunCompletedAt ?? null;
  let status: RuntimeHealthStatus = "unknown";

  if (observedAt) {
    const latestFailed =
      observation.lastFailureAt &&
      (!observation.lastSuccessAt || observation.lastFailureAt > observation.lastSuccessAt);

    if (latestFailed) {
      status = "degraded";
    } else if (now.getTime() - observedAt.getTime() > observation.staleAfterMs) {
      status = "stale";
    } else {
      status = "healthy";
    }
  }

  return {
    name,
    status,
    cadenceSeconds: Math.round(observation.cadenceMs / 1000),
    staleAfterSeconds: Math.round(observation.staleAfterMs / 1000),
    startedAt: observation.startedAt,
    running: observation.running,
    observedAt,
    lastRunStartedAt: observation.lastRunStartedAt ?? null,
    lastSuccessAt: observation.lastSuccessAt ?? null,
    lastFailureAt: observation.lastFailureAt ?? null,
    ...(observation.lastFailureCode
      ? { lastFailureCode: observation.lastFailureCode }
      : {})
  };
};

export const getAllRuntimeHealthSnapshots = (now = new Date()): RuntimeHealthSnapshot[] =>
  runtimeComponentNames.map((name) => getRuntimeHealthSnapshot(name, now));

export const resetRuntimeHealthForTests = (): void => {
  observations.clear();
};
