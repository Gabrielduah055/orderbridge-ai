import { createHash } from "crypto";
import type { z } from "zod";
import { CommercePaidOrderEvent } from "../models/commercePaidOrderEvent.model";
import type { commercePaidOrderEventSchema } from "../middleware/validateRequest";

export type CommercePaidOrderEventInput = z.infer<
  typeof commercePaidOrderEventSchema
>;

export type ReceiveCommercePaidOrderEventResult =
  | { outcome: "created"; eventId: string }
  | { outcome: "duplicate"; eventId: string }
  | { outcome: "conflict"; eventId: string };

const hashEventPayload = (input: CommercePaidOrderEventInput): string =>
  createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000
  );

export const receiveCommercePaidOrderEvent = async (
  businessId: string,
  input: CommercePaidOrderEventInput
): Promise<ReceiveCommercePaidOrderEventResult> => {
  const payloadHash = hashEventPayload(input);

  try {
    await CommercePaidOrderEvent.create({
      businessId,
      type: input.type,
      eventId: input.eventId,
      occurredAt: input.occurredAt,
      order: input.order,
      receivedAt: new Date(),
      status: "received",
      payloadHash
    });

    return { outcome: "created", eventId: input.eventId };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const equivalent = await CommercePaidOrderEvent.exists({
      businessId,
      eventId: input.eventId,
      "order.externalOrderId": input.order.externalOrderId,
      "order.paymentReference": input.order.paymentReference,
      payloadHash
    });

    return {
      outcome: equivalent ? "duplicate" : "conflict",
      eventId: input.eventId
    };
  }
};
