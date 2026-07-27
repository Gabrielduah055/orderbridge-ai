import { getAiProviderName } from "./ai.config";
import type { AiProvider } from "./ai.types";
import { OpenRouterProvider } from "./providers/openRouter.provider";

export const createAiProvider = (): AiProvider => {
  const provider = getAiProviderName();

  if (provider === "openrouter") {
    return new OpenRouterProvider();
  }

  throw new Error("Hermes uses the legacy provider path during migration.");
};
