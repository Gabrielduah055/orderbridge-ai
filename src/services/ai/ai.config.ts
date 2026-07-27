import type { AiProviderName } from "./ai.types";

const defaultOpenRouterTimeoutMs = 45_000;
const defaultMaxToolRounds = 6;
const defaultMaxOutputTokens = 800;

const cleanEnvValue = (value?: string): string | undefined => {
  const cleaned = value?.trim().replace(/;$/, "");

  return cleaned || undefined;
};

const parsePositiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getProviderName = (): AiProviderName => {
  const provider = cleanEnvValue(process.env.AI_PROVIDER)?.toLowerCase() ?? "hermes";

  if (provider === "openrouter" || provider === "hermes") {
    return provider;
  }

  throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
};

export const getAiProviderName = (): AiProviderName => getProviderName();

export const getOpenRouterConfig = () => ({
  apiKey: cleanEnvValue(process.env.OPENROUTER_API_KEY),
  model: cleanEnvValue(process.env.OPENROUTER_MODEL),
  timeoutMs: parsePositiveNumber(process.env.OPENROUTER_TIMEOUT_MS, defaultOpenRouterTimeoutMs),
  maxToolRounds: Math.floor(
    parsePositiveNumber(process.env.OPENROUTER_MAX_TOOL_ROUNDS, defaultMaxToolRounds)
  ),
  maxOutputTokens: Math.floor(
    parsePositiveNumber(process.env.OPENROUTER_MAX_OUTPUT_TOKENS, defaultMaxOutputTokens)
  ),
  siteUrl: cleanEnvValue(process.env.OPENROUTER_SITE_URL),
  appName: cleanEnvValue(process.env.OPENROUTER_APP_NAME) ?? "OrderBridgeAI",
  customerAgentEnabled: process.env.OPENROUTER_CUSTOMER_AGENT_ENABLED === "true",
  customerLegacyFallback: process.env.OPENROUTER_CUSTOMER_LEGACY_FALLBACK === "true",
  baseUrl:
    cleanEnvValue(process.env.OPENROUTER_BASE_URL)?.replace(/\/$/, "") ??
    "https://openrouter.ai/api/v1"
});

export const validateSelectedAiProviderConfig = (): void => {
  const provider = getProviderName();

  if (provider !== "openrouter") {
    return;
  }

  const config = getOpenRouterConfig();
  const missing = [
    !config.apiKey ? "OPENROUTER_API_KEY" : null,
    !config.model ? "OPENROUTER_MODEL" : null
  ].filter((value): value is string => Boolean(value));

  if (missing.length > 0) {
    throw new Error(`Missing required OpenRouter environment variables: ${missing.join(", ")}`);
  }
};
