import { Types } from "mongoose";
import { AgentClarification } from "../models/agentClarification.model";
import type {
  IAgentClarificationCandidate,
  IAgentClarificationDocument
} from "../models/agentClarification.model";
import type { SenderRole } from "../types/agent.types";

const clarificationTtlMs = 10 * 60 * 1000;

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");
const normalizeComparableText = (value: string): string =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^\w\s.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const confirmationPhrases = [
  "yes",
  "yeah",
  "yep",
  "that is what i mean",
  "that is what i want",
  "thats what i mean",
  "that's what i mean",
  "that one",
  "the spaghetti one"
];

const getMeaningfulSelectionTokens = (text: string): string[] => {
  const normalized = normalizeComparableText(text).replace(/\b(with|from|the|one|option)\b/g, " ");

  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !["please", "want", "mean"].includes(token));
};

const isConfirmationText = (text: string): boolean => {
  const normalized = normalizeComparableText(text);

  return confirmationPhrases.some((phrase) => normalized === phrase || normalized.includes(phrase));
};

const tokenMatches = (candidate: IAgentClarificationCandidate, text: string): boolean => {
  const normalizedText = normalizeComparableText(text);
  const selectionTokens = getMeaningfulSelectionTokens(text);
  const candidateParts = [
    candidate.name,
    candidate.categoryName,
    `ghs ${candidate.price}`,
    String(candidate.price)
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeComparableText);

  return candidateParts.some(
    (part) =>
      part.includes(normalizedText) ||
      normalizedText.includes(part) ||
      selectionTokens.some((token) => part.split(/\s+/).includes(token))
  );
};

export const createOrderItemClarification = async (input: {
  restaurantId: string;
  senderPhone: string;
  senderRole: SenderRole;
  originalText: string;
  quantity?: number;
  candidates: IAgentClarificationCandidate[];
}): Promise<IAgentClarificationDocument> => {
  await AgentClarification.updateMany(
    {
      restaurantId: input.restaurantId,
      senderPhone: input.senderPhone,
      intent: "order_item_selection",
      status: "pending"
    },
    {
      $set: {
        status: "cancelled"
      }
    }
  );

  return AgentClarification.create({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    intent: "order_item_selection",
    status: "pending",
    originalText: normalizeText(input.originalText),
    quantity: input.quantity,
    candidates: input.candidates,
    expiresAt: new Date(Date.now() + clarificationTtlMs)
  });
};

export const findActiveOrderItemClarification = async (input: {
  restaurantId: string;
  senderPhone: string;
}): Promise<IAgentClarificationDocument | null> => {
  return AgentClarification.findOne({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    intent: "order_item_selection",
    status: "pending",
    expiresAt: {
      $gt: new Date()
    }
  }).sort({ createdAt: -1 });
};

export const resolveOrderItemClarification = async (
  clarification: IAgentClarificationDocument,
  text: string
) => {
  const matches =
    clarification.candidates.length === 1 && isConfirmationText(text)
      ? [clarification.candidates[0]]
      : clarification.candidates.filter((candidate) => tokenMatches(candidate, text));

  if (matches.length !== 1) {
    return {
      status: matches.length === 0 ? "none" : "multiple",
      matches
    } as const;
  }

  clarification.status = "resolved";
  clarification.resolvedAt = new Date();
  await clarification.save();

  return {
    status: "matched",
    candidate: matches[0],
    menuItemId: String(matches[0].menuItemId),
    quantity: clarification.quantity
  } as const;
};

export const buildClarificationCandidate = (input: {
  menuItemId: Types.ObjectId;
  name: string;
  categoryId?: Types.ObjectId;
  price: number;
  categoryName?: string;
  available: boolean;
}): IAgentClarificationCandidate => input;
