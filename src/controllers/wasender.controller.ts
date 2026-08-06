import type { NextFunction, Request, Response } from "express";
import { sendTextMessage, sendImageMessage } from "../services/wasender.service";
import { Order } from "../models/order.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { WebhookEvent } from "../models/webhookEvent.model";
import { findActiveDraft, recordInboundCustomerTurn } from "../services/orderDraft.service";
import { handleRestaurantAgentMessage } from "../services/restaurantAgent.service";
import {
  notifyCustomerOfConfirmedOrderAndSendReceipt,
  notifyCustomerOfRejectedOrder,
  notifyOwnerOfSubmittedOrder
} from "../services/orderSideEffects.service";
import {
  normalizeIncomingWebhook,
  type NormalizedWasenderWebhook,
} from "../services/wasender.service";
import { enqueueWasenderMessage } from "../services/wasenderQueue.service";
import {
  isCloudinaryConfigured,
  uploadImageFromUrl
} from "../services/cloudinary.service";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import type { RestaurantAgentResponse } from "../types/agent.types";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { resolveSenderIdentity } from "../services/senderIdentity.service";

const customerConversationQueues = new Map<string, Promise<void>>();

export const runCustomerConversationSequentially = async <T>(
  restaurantId: string,
  customerPhone: string,
  task: () => Promise<T>
): Promise<T> => {
  const key = `${restaurantId}:${normalizeGhanaPhone(customerPhone)}`;
  const previous = customerConversationQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const cleanup = next
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (customerConversationQueues.get(key) === cleanup) {
        customerConversationQueues.delete(key);
      }
    });

  customerConversationQueues.set(key, cleanup);

  return next;
};

const getWebhookSecret = (req: Request): string | undefined => {
  const headerSecret =
    req.header("x-webhook-signature") ??
    req.header("x-wasender-webhook-secret") ??
    req.header("x-webhook-secret") ??
    req.header("x-webhook-token");
  const querySecret = typeof req.query.secret === "string" ? req.query.secret : undefined;

  return headerSecret ?? querySecret;
};

const isWebhookVerified = (req: Request): boolean => {
  const expectedSecret = process.env.WASENDER_WEBHOOK_SECRET?.trim();

  if (!expectedSecret) {
    return true;
  }

  const incomingSecret = getWebhookSecret(req)?.trim();

  if (process.env.NODE_ENV !== "production" && incomingSecret !== expectedSecret) {
    console.warn("Wasender webhook auth failed", {
      hasExpectedSecret: Boolean(expectedSecret),
      hasSignatureHeader: Boolean(req.header("x-webhook-signature")),
      hasLegacySecretHeader: Boolean(req.header("x-wasender-webhook-secret")),
      hasQuerySecret: typeof req.query.secret === "string"
    });
  }

  return incomingSecret === expectedSecret;
};

const getQueryString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const buildWebhookPayload = (req: Request): Record<string, unknown> => {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const bodyQuery =
    body.query && typeof body.query === "object" ? (body.query as Record<string, unknown>) : {};
  const bodyParams =
    body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>) : {};

  return {
    ...body,
    params: {
      ...bodyParams,
      sessionId: req.params.sessionId ?? bodyParams.sessionId
    },
    query: {
      ...bodyQuery,
      sessionId: getQueryString(req.query.sessionId) ?? bodyQuery.sessionId,
      wasenderSessionId:
        getQueryString(req.query.wasenderSessionId) ?? bodyQuery.wasenderSessionId,
      whatsappSessionId:
        getQueryString(req.query.whatsappSessionId) ?? bodyQuery.whatsappSessionId,
      receiver: getQueryString(req.query.receiver) ?? bodyQuery.receiver,
      whatsappNumber: getQueryString(req.query.whatsappNumber) ?? bodyQuery.whatsappNumber,
      businessNumber: getQueryString(req.query.businessNumber) ?? bodyQuery.businessNumber
    }
  };
};

const shouldProcessWebhook = (webhook: NormalizedWasenderWebhook): boolean => {
  if (webhook.fromMe) {
    return false;
  }

  if (!webhook.event) {
    return true;
  }

  return ["messages.received", "messages-personal.received", "messages.upsert"].includes(
    webhook.event
  );
};

const normalizePhone = (phone?: string): string => {
  return phone ? normalizeGhanaPhone(phone) : "";
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown webhook processing error";
};

const getErrorDetails = (error: unknown): Record<string, unknown> => {
  if (!error || typeof error !== "object") {
    return {};
  }

  const details: Record<string, unknown> = {};
  const maybeDetailedError = error as {
    context?: unknown;
    wasenderSendResult?: unknown;
    stack?: unknown;
  };

  if (maybeDetailedError.context) {
    details.context = maybeDetailedError.context;
  }

  if (maybeDetailedError.wasenderSendResult) {
    details.wasenderSendResult = maybeDetailedError.wasenderSendResult;
  }

  if (process.env.NODE_ENV !== "production" && maybeDetailedError.stack) {
    details.stack = maybeDetailedError.stack;
  }

  return details;
};

const latestResponsePurpose = (message: string): string => {
  if (/welcome|hello|hi\b/i.test(message)) {
    return "greeting";
  }

  if (/how many|number of portions|1, 2, or more/i.test(message)) {
    return "quantity_clarification";
  }

  if (/pickup or delivery/i.test(message)) {
    return "order_type_question";
  }

  if (/delivery location|where should we deliver|address/i.test(message)) {
    return "address_question";
  }

  if (/may I have your name|name please/i.test(message)) {
    return "name_question";
  }

  return "conversation";
};

const enqueueTextMessageOrThrow = async (
  sessionId: string,
  to: string,
  message: string,
  context: Record<string, unknown>,
  apiKey?: string
): Promise<void> => {
  const recipient = normalizePhone(to) || to;
  await enqueueWasenderMessage({
    restaurantId: typeof context.restaurantId === "string" ? context.restaurantId : undefined,
    sessionId,
    to: recipient,
    type: "text",
    text: message,
    apiKey,
    idempotencyKey:
      typeof context.eventId === "string" && typeof context.action === "string"
        ? `${context.action}:${context.eventId}:${recipient}`
        : undefined,
    metadata: {
      ...context,
      recipientType: "webhook_sender",
      usesRestaurantApiToken: Boolean(apiKey?.trim())
    }
  });
};

// Option A: Send the AI reply directly — no queue, no wait, instant delivery.
// If Wasender rejects it (e.g. rate limit), we silently fall back to the queue
// so the customer still gets the message, just slightly delayed.
const sendAgentReplyDirectly = async (
  sessionId: string,
  to: string,
  message: string,
  context: Record<string, unknown>,
  apiKey?: string
): Promise<void> => {
  const recipient = normalizePhone(to) || to;

  try {
    const result = await sendTextMessage(sessionId, recipient, message, { apiKey });

    if (result.success) {
      return; // delivered instantly ✅
    }

    console.warn("[agentReply] Direct send failed, falling back to queue", {
      sessionId,
      recipient,
      status: result.status,
      error: result.error
    });
  } catch (directSendError) {
    console.warn("[agentReply] Direct send threw error, falling back to queue", {
      sessionId,
      recipient,
      error: directSendError instanceof Error ? directSendError.message : "Unknown"
    });
  }

  // Fallback to queue on any failure
  await enqueueWasenderMessage({
    restaurantId: typeof context.restaurantId === "string" ? context.restaurantId : undefined,
    sessionId,
    to: recipient,
    type: "text",
    text: message,
    apiKey,
    idempotencyKey:
      typeof context.eventId === "string" && typeof context.action === "string"
        ? `${context.action}:${context.eventId}:${recipient}`
        : undefined,
    metadata: {
      ...context,
      recipientType: "webhook_sender",
      usesRestaurantApiToken: Boolean(apiKey?.trim()),
      directSendFailed: true
    }
  });
};

const findRestaurantForWebhook = async (
  webhook: NormalizedWasenderWebhook
): Promise<IRestaurantDocument | null> => {
  const receiver = normalizePhone(webhook.receiver);
  const possibleWhatsappNumbers = [webhook.receiver, receiver].filter(Boolean);

  if (possibleWhatsappNumbers.length > 0) {
    const restaurantByWhatsappNumber = await Restaurant.findOne({
      $or: possibleWhatsappNumbers.map((phone) => ({ whatsappNumber: phone }))
    }).select("+wasenderApiToken");

    if (restaurantByWhatsappNumber) {
      return restaurantByWhatsappNumber;
    }
  }

  if (!webhook.sessionId) {
    return null;
  }

  return Restaurant.findOne({
    wasenderSessionId: webhook.sessionId
  }).select("+wasenderApiToken");
};

const getStructuredOrderId = (orderData: unknown): string => {
  return typeof orderData === "object" && orderData !== null && "_id" in orderData
    ? String((orderData as { _id?: unknown })._id)
    : typeof orderData === "object" && orderData !== null && "id" in orderData
      ? String((orderData as { id?: unknown }).id)
      : "";
};

const sendSingleCustomerOrderSideEffect = async (
  restaurant: IRestaurantDocument,
  customerResponse: RestaurantAgentResponse,
  orderData: unknown
): Promise<void> => {
  const orderEvent = customerResponse.data?.orderEvent;

  if (!orderData || !orderEvent) {
    return;
  }

  const orderId = getStructuredOrderId(orderData);

  if (!orderId) {
    console.error("Order side effect skipped because structured order ID is missing", {
      restaurantId: String(restaurant._id),
      orderEvent
    });
    return;
  }

  const order = await Order.findOne({
    _id: orderId,
    restaurantId: restaurant._id
  });

  if (!order) {
    console.error("Order side effect skipped because order was not found", {
      restaurantId: String(restaurant._id),
      orderId,
      orderEvent
    });
    return;
  }

  if (orderEvent === "submitted" && customerResponse.data?.notifyOwner) {
    await notifyOwnerOfSubmittedOrder(restaurant, order);
    return;
  }

  if (orderEvent === "confirmed" && customerResponse.data?.notifyCustomer) {
    await notifyCustomerOfConfirmedOrderAndSendReceipt(restaurant, order);
    return;
  }

  if (orderEvent === "rejected" && customerResponse.data?.notifyCustomer) {
    await notifyCustomerOfRejectedOrder(restaurant, order);
  }
};

export const sendCustomerOrderSideEffects = async (
  restaurant: IRestaurantDocument,
  customerResponse: RestaurantAgentResponse
): Promise<void> => {
  const orderList = Array.isArray(customerResponse.data?.orders)
    ? customerResponse.data.orders
    : undefined;

  if (orderList) {
    for (const orderData of orderList) {
      await sendSingleCustomerOrderSideEffect(restaurant, customerResponse, orderData);
    }
    return;
  }

  await sendSingleCustomerOrderSideEffect(restaurant, customerResponse, customerResponse.data?.order);
};

const processNormalizedWebhook = async (
  webhook: NormalizedWasenderWebhook
): Promise<void> => {
  const eventId = webhook.messageId ?? "";

  try {
    const webhookEvent = await WebhookEvent.create({
      provider: "wasender",
      eventId,
      sessionId: webhook.sessionId,
      from: webhook.from,
      payload: webhook.rawPayload,
      status: "processing"
    });

    const restaurant = await findRestaurantForWebhook(webhook);

    if (!restaurant) {
      console.error("Wasender webhook restaurant not found", {
        sessionId: webhook.sessionId,
        receiver: webhook.receiver
      });
      webhookEvent.status = "failed";
      webhookEvent.failureReason = "Restaurant not found for Wasender webhook";
      webhookEvent.failureDetails = {
        sessionId: webhook.sessionId,
        receiver: webhook.receiver
      };
      webhookEvent.processedAt = new Date();
      await webhookEvent.save();
      return;
    }

    if (!webhook.from) {
      throw new Error("Wasender webhook missing sender phone");
    }

    const sender = resolveSenderIdentity(restaurant, webhook.from);
    const processWebhookTurn = async (): Promise<void> => {
      let conversationMetadata: Record<string, unknown> = {};

      if (sender.role === "customer") {
        const turnSession = await recordInboundCustomerTurn(
          String(restaurant._id),
          normalizeGhanaPhone(webhook.from),
          eventId,
          sender.name
        );

        conversationMetadata = {
          customerPhone: turnSession.customerPhone,
          inboundEventId: eventId,
          draftId: String(turnSession._id),
          conversationVersion: turnSession.conversationVersion,
          expectedDraftStep: turnSession.currentStep
        };
      }

      // ── Inbound image from owner/manager ──────────────────────────────────
      // When an owner or manager sends a photo, upload it to Cloudinary and
      // create a pending action so the AI can ask which menu item it belongs to.
      if (webhook.messageType === "image" && sender.role !== "customer") {
        const mediaUrl = webhook.mediaUrl;

        if (!mediaUrl || !isCloudinaryConfigured()) {
          await enqueueTextMessageOrThrow(
            restaurant.wasenderSessionId,
            webhook.from,
            isCloudinaryConfigured()
              ? "I received your image but couldn't retrieve the media URL. Please try again."
              : "Image uploads are not configured yet. Please contact support.",
            { action: "image_upload_error", restaurantId: String(restaurant._id), eventId },
            restaurant.wasenderApiToken
          );
          webhookEvent.status = "processed";
          webhookEvent.processedAt = new Date();
          await webhookEvent.save();
          return;
        }

        try {
          // Download from WaSender (auth required) then upload to Cloudinary
          const cloudinaryUrl = await uploadImageFromUrl(mediaUrl, restaurant.wasenderApiToken ?? undefined);

          // Store the Cloudinary URL in a pending action so the AI can
          // link it to a menu item once the owner names the item
          await PendingAgentAction.updateMany(
            {
              restaurantId: restaurant._id,
              senderPhone: normalizeGhanaPhone(webhook.from),
              action: "TOOL_CALL",
              status: "pending"
            },
            { $set: { status: "cancelled", resultMessage: "Superseded by new image upload." } }
          );

          await PendingAgentAction.create({
            restaurantId: restaurant._id,
            senderPhone: normalizeGhanaPhone(webhook.from),
            senderRole: sender.role,
            action: "TOOL_CALL",
            toolName: "set_menu_item_image",
            arguments: { imageUrl: cloudinaryUrl },
            data: { imageUrl: cloudinaryUrl },
            status: "pending",
            summary: "Set menu item image",
            confirmationMessage: "Set menu item image",
            expiresAt: new Date(Date.now() + 10 * 60 * 1000)
          });

          await enqueueTextMessageOrThrow(
            restaurant.wasenderSessionId,
            webhook.from,
            "Got your image! 📸 Which menu item is this for? Reply with the item name.",
            { action: "image_received", restaurantId: String(restaurant._id), eventId },
            restaurant.wasenderApiToken
          );
        } catch (uploadError) {
          console.error("Image upload to Cloudinary failed", {
            restaurantId: String(restaurant._id),
            error: uploadError instanceof Error ? uploadError.message : "Unknown error"
          });
          await enqueueTextMessageOrThrow(
            restaurant.wasenderSessionId,
            webhook.from,
            "Sorry, I had trouble uploading your image. Please try again.",
            { action: "image_upload_failed", restaurantId: String(restaurant._id), eventId },
            restaurant.wasenderApiToken
          );
        }

        webhookEvent.status = "processed";
        webhookEvent.processedAt = new Date();
        await webhookEvent.save();
        return;
      }

      // ── Non-text, non-image message (documents, audio, etc.) ──────────────
      if (webhook.messageType !== "text" || !webhook.message.trim()) {
        await enqueueTextMessageOrThrow(
          restaurant.wasenderSessionId,
          webhook.from,
          "Please send a text message so I can help with your order.",
          {
            action: "send_unsupported_message_type_reply",
            restaurantId: String(restaurant._id),
            eventId,
            ...conversationMetadata,
            responsePurpose: "unsupported_message_type"
          },
          restaurant.wasenderApiToken
        );
        webhookEvent.status = "processed";
        webhookEvent.processedAt = new Date();
        await webhookEvent.save();
        return;
      }

      const agentResponse = await handleRestaurantAgentMessage({
        restaurant,
        senderPhone: webhook.from,
        message: webhook.message,
        quotedMessageId: webhook.quotedMessageId,
        inboundEventId: eventId
      });

      // ── Send image to customer if the response includes one ───────────────
      // Only send when a specific item image is available; never on full menu.
      const responseImageUrl = typeof agentResponse.data === "object" &&
        agentResponse.data !== null &&
        "imageUrl" in agentResponse.data &&
        typeof (agentResponse.data as Record<string, unknown>).imageUrl === "string"
          ? (agentResponse.data as Record<string, unknown>).imageUrl as string
          : undefined;

      if (responseImageUrl && sender.role === "customer") {
        await sendImageMessage(
          restaurant.wasenderSessionId,
          webhook.from,
          responseImageUrl,
          undefined,
          { apiKey: restaurant.wasenderApiToken }
        );
      }

      if (sender.role === "customer") {
        const latestDraft = await findActiveDraft(String(restaurant._id), sender.normalizedPhone);

        if (latestDraft) {
          conversationMetadata = {
            ...conversationMetadata,
            draftId: String(latestDraft._id),
            conversationVersion: latestDraft.conversationVersion,
            expectedDraftStep: latestDraft.currentStep
          };
        }
      }

      await sendAgentReplyDirectly(
        restaurant.wasenderSessionId,
        webhook.from,
        agentResponse.message,
        {
          action: "send_restaurant_agent_reply",
          restaurantId: String(restaurant._id),
          eventId,
          source: agentResponse.source,
          senderRole: agentResponse.sender?.role,
          ...conversationMetadata,
          responsePurpose:
            agentResponse.sender?.role === "customer"
              ? latestResponsePurpose(agentResponse.message)
              : "owner_agent_reply"
        },
        restaurant.wasenderApiToken
      );
      await sendCustomerOrderSideEffects(restaurant, agentResponse);

      webhookEvent.status = "processed";
      webhookEvent.processedAt = new Date();
      await webhookEvent.save();
    };

    if (sender.role === "customer") {
      await runCustomerConversationSequentially(
        String(restaurant._id),
        sender.normalizedPhone,
        processWebhookTurn
      );
      return;
    }

    await processWebhookTurn();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      return;
    }

    console.error("Wasender webhook processing failed", error);

    const failureReason = getErrorMessage(error);
    const failureDetails = getErrorDetails(error);

    await WebhookEvent.updateOne(
      {
        provider: "wasender",
        eventId
      },
      {
        $set: {
          status: "failed",
          processedAt: new Date(),
          failureReason,
          failureDetails
        },
        $setOnInsert: {
          sessionId: webhook.sessionId,
          from: webhook.from,
          payload: webhook.rawPayload
        }
      },
      {
        upsert: true
      }
    );
  }
};

export const handleWasenderWebhook = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    if (!isWebhookVerified(req)) {
      res.status(401).json({
        success: false,
        message: "Invalid webhook secret"
      });
      return;
    }

    const webhook = normalizeIncomingWebhook(buildWebhookPayload(req));

    res.status(200).json({
      success: true
    });

    if (!shouldProcessWebhook(webhook)) {
      return;
    }

    void processNormalizedWebhook(webhook);
  } catch (error) {
    next(error);
  }
};
