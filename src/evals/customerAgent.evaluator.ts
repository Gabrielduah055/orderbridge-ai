import type { AiProviderResponse, AiToolCall } from "../services/ai/ai.types";
import type { CustomerAgentEvalScenario } from "./customerAgent.scenarios";

export interface CustomerAgentEvalResult {
  passed: number;
  failed: number;
  total: number;
  outcomes: Array<{
    scenario: CustomerAgentEvalScenario;
    passed: boolean;
    actual: AiProviderResponse;
    reasons: string[];
  }>;
}

const normalize = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const argumentMatches = (actual: unknown, expected: unknown): boolean =>
  typeof actual === "string" && typeof expected === "string"
    ? normalize(actual) === normalize(expected)
    : Object.is(actual, expected);

const findTool = (
  toolCalls: AiToolCall[],
  toolName: string
): AiToolCall | undefined => toolCalls.find((tool) => tool.name === toolName);

export const evaluateCustomerAgentDecision = (
  scenario: CustomerAgentEvalScenario,
  actual: AiProviderResponse
): string[] => {
  const reasons: string[] = [];
  const toolNames = actual.toolCalls.map((tool) => tool.name);
  let expectedCall: AiToolCall | undefined;

  if (scenario.expectNoTool && actual.toolCalls.length > 0) {
    reasons.push(`expected no tool call; received ${toolNames.join(", ")}`);
  }

  if (scenario.expectedTool) {
    expectedCall = findTool(actual.toolCalls, scenario.expectedTool);
    if (!expectedCall && !(scenario.allowNoTool && actual.toolCalls.length === 0)) {
      reasons.push(
        `expected ${scenario.expectedTool}; received ${toolNames.join(", ") || "conversation"}`
      );
    }
  }

  if (scenario.expectedOneOfTools?.length) {
    expectedCall = actual.toolCalls.find((tool) =>
      scenario.expectedOneOfTools!.includes(tool.name)
    );
    if (!expectedCall) {
      reasons.push(
        `expected one of ${scenario.expectedOneOfTools.join(", ")}; received ${toolNames.join(", ") || "conversation"}`
      );
    }
  }

  if (expectedCall) {
    for (const [key, value] of Object.entries(scenario.expectedArguments ?? {})) {
      if (!argumentMatches(expectedCall.arguments[key], value)) {
        reasons.push(
          `expected ${expectedCall.name}.${key}=${JSON.stringify(value)}; received ${JSON.stringify(expectedCall.arguments[key])}`
        );
      }
    }

    for (const forbiddenArgument of scenario.forbiddenArguments ?? []) {
      if (forbiddenArgument in expectedCall.arguments) {
        reasons.push(
          `forbidden argument selected: ${expectedCall.name}.${forbiddenArgument}`
        );
      }
    }
  }

  for (const forbiddenTool of scenario.forbiddenTools ?? []) {
    if (toolNames.includes(forbiddenTool)) {
      reasons.push(`forbidden tool selected: ${forbiddenTool}`);
    }
  }

  if (
    scenario.expectedTextPattern &&
    !scenario.expectedTextPattern.test(actual.text ?? "")
  ) {
    reasons.push(`response did not clarify with ${scenario.expectedTextPattern}`);
  }

  return reasons;
};

export const runCustomerAgentEvaluation = async (
  scenarios: CustomerAgentEvalScenario[],
  decide: (scenario: CustomerAgentEvalScenario) => Promise<AiProviderResponse>
): Promise<CustomerAgentEvalResult> => {
  const outcomes = [];

  for (const scenario of scenarios) {
    const actual = await decide(scenario);
    const reasons = evaluateCustomerAgentDecision(scenario, actual);
    outcomes.push({ scenario, actual, reasons, passed: reasons.length === 0 });
  }

  return {
    passed: outcomes.filter((outcome) => outcome.passed).length,
    failed: outcomes.filter((outcome) => !outcome.passed).length,
    total: outcomes.length,
    outcomes
  };
};

export const formatCustomerAgentEvaluation = (
  result: CustomerAgentEvalResult
): string => {
  const lines = ["CUSTOMER AI EVALUATION", ""];

  for (const outcome of result.outcomes) {
    lines.push(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.scenario.name}`);
    for (const reason of outcome.reasons) {
      lines.push(`      ${reason}`);
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
