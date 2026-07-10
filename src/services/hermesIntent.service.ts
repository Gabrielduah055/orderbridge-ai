import type { IMenuCategoryDocument } from "../models/MenuCategory";
import type { IMenuItemDocument } from "../models/MenuItem";
import type { IRestaurantDocument } from "../models/Restaurant";

export const hermesIntents = [
  "add_menu_item",
  "update_menu_item",
  "update_price",
  "set_availability",
  "create_promo",
  "update_promo",
  "create_order",
  "update_order_status",
  "generate_report",
  "none"
] as const;

export type HermesIntentName = (typeof hermesIntents)[number];

export interface HermesIntent {
  intent: HermesIntentName;
  requires_confirmation: boolean;
  confirmed: boolean;
  action: Record<string, unknown>;
  reply_text: string;
}

interface GetHermesIntentInput {
  restaurant: IRestaurantDocument;
  senderPhone: string;
  message: string;
  categories: IMenuCategoryDocument[];
  menuItems: IMenuItemDocument[];
}

const hermesTimeoutMs = 10_000;

const getHermesConfig = (): { apiUrl: string; apiKey: string } | null => {
  const apiUrl = process.env.HERMES_API_URL;
  const apiKey = process.env.HERMES_API_KEY;

  if (!apiUrl || !apiKey) {
    return null;
  }

  return {
    apiUrl,
    apiKey
  };
};

const extractResponseText = (responseBody: unknown): string => {
  if (!responseBody || typeof responseBody !== "object") {
    throw new Error("Hermes returned an empty response");
  }

  const body = responseBody as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
      text?: unknown;
    }>;
    message?: unknown;
    content?: unknown;
    reply_text?: unknown;
  };
  const choice = body.choices?.[0];
  const content =
    choice?.message?.content ?? choice?.text ?? body.content ?? body.message ?? body.reply_text;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Hermes response did not include text content");
  }

  return content;
};

const extractJsonText = (content: string): string => {
  const fencedJson = content.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fencedJson) {
    return fencedJson[1].trim();
  }

  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return content.slice(firstBrace, lastBrace + 1);
  }

  return content.trim();
};

const isHermesIntentName = (intent: unknown): intent is HermesIntentName => {
  return typeof intent === "string" && hermesIntents.includes(intent as HermesIntentName);
};

const validateHermesIntent = (value: unknown): HermesIntent => {
  if (!value || typeof value !== "object") {
    throw new Error("Hermes JSON was not an object");
  }

  const intent = value as Partial<HermesIntent>;

  if (!isHermesIntentName(intent.intent)) {
    throw new Error("Hermes JSON included an unsupported intent");
  }

  if (!intent.action || typeof intent.action !== "object" || Array.isArray(intent.action)) {
    throw new Error("Hermes JSON action must be an object");
  }

  return {
    intent: intent.intent,
    requires_confirmation: Boolean(intent.requires_confirmation),
    confirmed: Boolean(intent.confirmed),
    action: intent.action as Record<string, unknown>,
    reply_text: typeof intent.reply_text === "string" ? intent.reply_text : ""
  };
};

const parseHermesIntent = (content: string): HermesIntent => {
  const jsonText = extractJsonText(content);
  const parsed = JSON.parse(jsonText) as unknown;

  return validateHermesIntent(parsed);
};

const buildCategoryNameById = (
  categories: IMenuCategoryDocument[]
): Map<string, string> => {
  return new Map(categories.map((category) => [String(category._id), category.name]));
};

const buildHermesPromptPayload = (input: GetHermesIntentInput) => {
  const categoryNameById = buildCategoryNameById(input.categories);

  return {
    restaurant: {
      id: String(input.restaurant._id),
      name: input.restaurant.name,
      primaryCuisine: input.restaurant.primaryCuisine,
      assistantTone: input.restaurant.assistantTone
    },
    categories: input.categories.map((category) => category.name),
    menuItems: input.menuItems.map((item) => ({
      name: item.name,
      price: item.price,
      isAvailable: item.isAvailable,
      categoryName: categoryNameById.get(String(item.categoryId)) ?? null
    })),
    sender: {
      phone: input.senderPhone
    },
    message: input.message
  };
};

export const getHermesIntent = async (
  input: GetHermesIntentInput
): Promise<HermesIntent | null> => {
  const config = getHermesConfig();

  if (!config) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), hermesTimeoutMs);
  const payload = buildHermesPromptPayload(input);

  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.HERMES_MODEL || "hermes",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You understand restaurant owner menu-management messages. Return only JSON with this shape: {\"intent\":\"add_menu_item | update_menu_item | update_price | set_availability | create_promo | update_promo | create_order | update_order_status | generate_report | none\",\"requires_confirmation\":true,\"confirmed\":false,\"action\":{},\"reply_text\":\"...\"}. Do not execute actions."
          },
          {
            role: "user",
            content: JSON.stringify(payload)
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Hermes request failed with status ${response.status}`);
    }

    const responseBody = (await response.json()) as unknown;
    const content = extractResponseText(responseBody);

    return parseHermesIntent(content);
  } catch (error) {
    console.error("Hermes intent extraction failed", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
