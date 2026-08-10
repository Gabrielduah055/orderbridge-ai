import type { NextFunction, Request, Response } from "express";
import {
  decryptWasenderMedia,
  sendTextMessage,
  validateWasenderMenuItemImageMetadata,
} from "../services/wasender.service";
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
  uploadTrustedDecryptedImageFromUrl
} from "../services/cloudinary.service";
import type {
  MenuItemImageDelivery,
  RestaurantAgentResponse
} from "../types/agent.types";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { resolveSenderIdentity } from "../services/senderIdentity.service";
import { resolveWasenderCustomerIdentity } from "../services/wasenderIdentity.service";
import { prepareUploadedMenuItemImage } from "../services/menuItemImageWorkflow.service";
import { getSafeErrorMessage, redactUrls } from "../utils/error.util";

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
  return getSafeErrorMessage(error, "Webhook processing failed without an error message");
};

const getErrorDetails = (error: unknown): Record<string, unknown> => {
  if (!error || typeof error !== "object") {
    return {};
  }

  const details: Record<string, unknown> = {};
  const maybeDetailedError = error as {
    code?: unknown;
    http_code?: unknown;
    status?: unknown;
    stack?: unknown;
  };

  const code = maybeDetailedError.code ?? maybeDetailedError.http_code ?? maybeDetailedError.status;

  if (typeof code === "string" || typeof code === "number") {
    details.code = code;
  }

  if (process.env.NODE_ENV !== "production" && typeof maybeDetailedError.stack === "string") {
    details.stack = redactUrls(maybeDetailedError.stack);
  }

  return details;
};

export const getTrustedMenuItemImageDelivery = (
  data: RestaurantAgentResponse["data"]
): MenuItemImageDelivery | undefined => {
  const candidate = data?.menuItemImage;

  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const delivery = candidate;
  const source = delivery.source;

  if (
    typeof delivery.imageUrl !== "string" ||
    !delivery.imageUrl.trim() ||
    (source !== "menu_item_record" && source !== "search_menu_items_tool")
  ) {
    return undefined;
  }

  return {
    menuItemId:
      typeof delivery.menuItemId === "string" ? delivery.menuItemId : undefined,
    imageUrl: delivery.imageUrl,
    caption: delivery.caption,
    source
  };
};

export const buildMenuItemImageReplyMessage = (
  agentMessage: string,
  caption: string
): string => {
  if (/https?:\/\/\S+/i.test(agentMessage)) {
    return `Here is ${caption}.`;
  }

  const withoutUrls = agentMessage
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();

  return withoutUrls || `Here is ${caption}.`;
};

export const buildMenuItemImageFallbackMessage = (
  agentMessage: string
): string => {
  return `${agentMessage}\n\nI couldn't send the image right now. Please try again.`;
};

export const buildCustomerImageFallbackMessage = (
  agentMessage: string,
  _imageUrl: string
): string => {
  return buildMenuItemImageFallbackMessage(agentMessage);
};

export interface EnqueueTrustedMenuItemImageReplyInput {
  restaurantId: string;
  sessionId: string;
  to: string;
  customerPhone?: string;
  delivery: MenuItemImageDelivery;
  agentMessage: string;
  eventId?: string;
  apiKey?: string;
  metadata?: Record<string, unknown>;
}

export const enqueueTrustedMenuItemImageReply = async (
  input: EnqueueTrustedMenuItemImageReplyInput,
  enqueueMessage: typeof enqueueWasenderMessage = enqueueWasenderMessage
): Promise<void> => {
  const recipient = normalizePhone(input.to) || input.to;
  const caption = buildMenuItemImageReplyMessage(
    input.agentMessage,
    input.delivery.caption
  );

  await enqueueMessage({
    restaurantId: input.restaurantId,
    sessionId: input.sessionId,
    to: recipient,
    type: "image",
    imageUrl: input.delivery.imageUrl,
    caption,
    apiKey: input.apiKey,
    idempotencyKey: input.eventId
      ? `send_restaurant_agent_image:${input.eventId}:${recipient}`
      : undefined,
    metadata: {
      ...input.metadata,
      kind: "menu_item_image_delivery",
      restaurantId: input.restaurantId,
      customerPhone: input.customerPhone ?? recipient,
      menuItemId: input.delivery.menuItemId,
      menuItemName: input.delivery.caption,
      responsePurpose: "menu_item_image",
      recipientType: "webhook_sender",
      usesRestaurantApiToken: Boolean(input.apiKey?.trim())
    }
  });

  console.info("[customerAgent] trusted menu image queued", {
    restaurantId: input.restaurantId,
    recipientAddressingMode: /@lid$/i.test(recipient) ? "lid" : "pn",
    hasCanonicalCustomerPhone: Boolean(input.customerPhone),
    menuItemId: input.delivery.menuItemId,
    menuItemName: input.delivery.caption
  });
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
export const sendAgentReplyDirectly = async (
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
      error: getSafeErrorMessage(directSendError, "Direct WaSender text delivery failed")
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
      throw new Error("Wasender webhook missing sender identity");
    }

    const customerIdentity = await resolveWasenderCustomerIdentity(
      String(restaurant._id),
      webhook,
      restaurant.wasenderApiToken
    );

    console.info("WhatsApp sender identity resolved", {
      restaurantId: String(restaurant._id),
      addressingMode: customerIdentity.addressingMode,
      hasCleanedParticipantPn: webhook.hasCleanedParticipantPn,
      hasCleanedSenderPn: webhook.hasCleanedSenderPn,
      hasSenderPn: webhook.hasSenderPn,
      hasSenderLid: Boolean(webhook.senderLid),
      resolutionSource: customerIdentity.resolutionSource
    });

    if (!customerIdentity.customerPhone) {
      await sendAgentReplyDirectly(
        restaurant.wasenderSessionId,
        customerIdentity.recipientAddress,
        "I can't verify your WhatsApp phone number right now. Please try again shortly.",
        {
          action: "send_unresolved_whatsapp_identity_reply",
          restaurantId: String(restaurant._id),
          eventId,
          responsePurpose: "unresolved_whatsapp_identity",
          addressingMode: customerIdentity.addressingMode
        },
        restaurant.wasenderApiToken
      );
      webhookEvent.status = "processed";
      webhookEvent.processedAt = new Date();
      await webhookEvent.save();
      return;
    }

    const canonicalCustomerPhone = customerIdentity.customerPhone;
    const replyAddress = customerIdentity.recipientAddress;
    const sender = resolveSenderIdentity(restaurant, canonicalCustomerPhone);
    const processWebhookTurn = async (): Promise<void> => {
      let conversationMetadata: Record<string, unknown> = {};

      if (sender.role === "customer") {
        const turnSession = await recordInboundCustomerTurn(
          String(restaurant._id),
          canonicalCustomerPhone,
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
      // Decrypt the complete raw message through WaSender, then upload only its
      // temporary public URL and prepare the menu-item confirmation workflow.
      if (webhook.messageType === "image" && sender.role !== "customer") {
        if (!isCloudinaryConfigured()) {
          await enqueueTextMessageOrThrow(
            restaurant.wasenderSessionId,
            replyAddress,
            "Image uploads are not configured yet. Please contact support.",
            { action: "image_upload_error", restaurantId: String(restaurant._id), eventId },
            restaurant.wasenderApiToken
          );

          throw new Error("Cloudinary image upload is not configured.");
        }

        try {
          validateWasenderMenuItemImageMetadata(webhook.rawMessage);
          const decryptedPublicUrl = await decryptWasenderMedia(webhook.rawMessage, {
            apiKey: restaurant.wasenderApiToken
          });
          const trustedImage = await uploadTrustedDecryptedImageFromUrl(decryptedPublicUrl);
          const workflowResult = await prepareUploadedMenuItemImage({
            restaurantId: String(restaurant._id),
            senderPhone: canonicalCustomerPhone,
            senderRole: sender.role,
            image: trustedImage
          });

          await enqueueTextMessageOrThrow(
            restaurant.wasenderSessionId,
            replyAddress,
            workflowResult.message,
            { action: "image_received", restaurantId: String(restaurant._id), eventId },
            restaurant.wasenderApiToken
          );
        } catch (imageProcessingError) {
          const errorMessage = getSafeErrorMessage(
            imageProcessingError,
            "Image decryption or Cloudinary upload failed"
          );

          console.error("Owner image processing failed", {
            restaurantId: String(restaurant._id),
            messageId: webhook.messageId,
            error: errorMessage
          });
          await enqueueTextMessageOrThrow(
            restaurant.wasenderSessionId,
            replyAddress,
            "Sorry, I couldn't process that image. Please send it again.",
            { action: "image_upload_failed", restaurantId: String(restaurant._id), eventId },
            restaurant.wasenderApiToken
          );

          throw new Error(`Owner image processing failed: ${errorMessage}`);
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
          replyAddress,
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
        senderPhone: canonicalCustomerPhone,
        message: webhook.message,
        quotedMessageId: webhook.quotedMessageId,
        inboundEventId: eventId
      });

      // ── Send a trusted menu-item image when the response includes one ─────
      // Send only explicitly trusted menu-item image payloads, for every authorized role.
      const menuItemImage = getTrustedMenuItemImageDelivery(agentResponse.data);
      let replyMessage = agentResponse.message;

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

      if (menuItemImage) {
        await enqueueTrustedMenuItemImageReply({
          restaurantId: String(restaurant._id),
          sessionId: restaurant.wasenderSessionId,
          to: replyAddress,
          customerPhone:
            sender.role === "customer" ? canonicalCustomerPhone : undefined,
          delivery: menuItemImage,
          agentMessage: agentResponse.message,
          eventId,
          apiKey: restaurant.wasenderApiToken,
          metadata: {
            action: "send_restaurant_agent_image",
            eventId,
            source: agentResponse.source,
            senderRole: agentResponse.sender?.role,
            ...conversationMetadata
          }
        });
      } else {
        await sendAgentReplyDirectly(
          restaurant.wasenderSessionId,
          replyAddress,
          replyMessage,
          {
            action: "send_restaurant_agent_reply",
            restaurantId: String(restaurant._id),
            eventId,
            source: agentResponse.source,
            senderRole: agentResponse.sender?.role,
            ...conversationMetadata,
            responsePurpose:
              agentResponse.sender?.role === "customer"
                ? latestResponsePurpose(replyMessage)
                : "owner_agent_reply"
          },
          restaurant.wasenderApiToken
        );
      }
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

    const failureReason = getErrorMessage(error);
    const failureDetails = getErrorDetails(error);

    console.error("Wasender webhook processing failed", {
      eventId,
      failureReason
    });

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
