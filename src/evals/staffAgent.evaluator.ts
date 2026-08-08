import type { AiProviderResponse, AiToolCall } from "../services/ai/ai.types";
import type { StaffAgentEvalScenario } from "./staffAgent.scenarios";

export interface StaffAgentEvalFailure {
  scenario: StaffAgentEvalScenario;
  actual: AiProviderResponse;
  reasons: string[];
}

export interface StaffAgentEvalResult {
  passed: number;
  failed: number;
  total: number;
  failures: StaffAgentEvalFailure[];
  outcomes: Array<{
    scenario: StaffAgentEvalScenario;
    passed: boolean;
    actual: AiProviderResponse;
    reasons: string[];
  }>;
}

const normalizeComparableString = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const hasExpectedArgument = (
  actual: Record<string, unknown>,
  key: string,
  expected: unknown
): boolean => {
  const actualValue = actual[key];

  if (typeof actualValue === "string" && typeof expected === "string") {
    return normalizeComparableString(actualValue) === normalizeComparableString(expected);
  }

  return Object.is(actualValue, expected);
};

const findExpectedToolCall = (
  toolCalls: AiToolCall[],
  expectedTool: string
): AiToolCall | undefined => toolCalls.find((toolCall) => toolCall.name === expectedTool);

export const evaluateStaffAgentDecision = (
  scenario: StaffAgentEvalScenario,
  actual: AiProviderResponse
): string[] => {
  const reasons: string[] = [];
  const toolNames = actual.toolCalls.map((toolCall) => toolCall.name);

  if (scenario.expectNoTool && actual.toolCalls.length > 0) {
    reasons.push(`expected no tool call; received ${toolNames.join(", ")}`);
  }

  if (scenario.expectedTool) {
    const expectedCall = findExpectedToolCall(actual.toolCalls, scenario.expectedTool);

    if (!expectedCall) {
      reasons.push(
        `expected ${scenario.expectedTool}; received ${toolNames.join(", ") || "conversation"}`
      );
    } else {
      for (const [key, expectedValue] of Object.entries(
        scenario.expectedArguments ?? {}
      )) {
        if (!hasExpectedArgument(expectedCall.arguments, key, expectedValue)) {
          reasons.push(
            `expected ${scenario.expectedTool}.${key}=${JSON.stringify(expectedValue)}; received ${JSON.stringify(expectedCall.arguments[key])}`
          );
        }
      }
    }
  }

  for (const forbiddenTool of scenario.forbiddenTools ?? []) {
    if (toolNames.includes(forbiddenTool)) {
      reasons.push(`forbidden tool selected: ${forbiddenTool}`);
    }
  }

  return reasons;
};

export const runStaffAgentEvaluation = async (
  scenarios: StaffAgentEvalScenario[],
  decide: (scenario: StaffAgentEvalScenario) => Promise<AiProviderResponse>
): Promise<StaffAgentEvalResult> => {
  const outcomes = [];

  for (const scenario of scenarios) {
    const actual = await decide(scenario);
    const reasons = evaluateStaffAgentDecision(scenario, actual);
    outcomes.push({ scenario, actual, reasons, passed: reasons.length === 0 });
  }

  const failures = outcomes
    .filter((outcome) => !outcome.passed)
    .map(({ scenario, actual, reasons }) => ({ scenario, actual, reasons }));

  return {
    passed: outcomes.length - failures.length,
    failed: failures.length,
    total: outcomes.length,
    failures,
    outcomes
  };
};

export const formatStaffAgentEvaluation = (result: StaffAgentEvalResult): string => {
  const lines = ["STAFF AI EVALUATION", ""];

  for (const outcome of result.outcomes) {
    lines.push(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.scenario.name}`);

    if (!outcome.passed) {
      for (const reason of outcome.reasons) {
        lines.push(`      ${reason}`);
      }
    }
  }

  lines.push(
    "",
    `Passed: ${result.passed}`,
    `Failed: ${result.failed}`,
    `Total: ${result.total}`
  );

  return lines.join("\n");
};
