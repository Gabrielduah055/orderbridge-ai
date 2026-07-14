import type { NextFunction, Request, Response } from "express";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { WebhookEvent } from "../models/webhookEvent.model";
import * as agentCustomerService from "../services/agentCustomer.service";
import * as agentOwnerService from "../services/agentOwner.service";
import {
  normalizeIncomingWebhook,
  sendDocumentMessage,
  sendTextMessage,
  type NormalizedWasenderWebhook
} from "../services/wasender.service";
import { normalizeGhanaPhone } from "../utils/phone.util";

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

const findRestaurantForWebhook = async (
  webhook: NormalizedWasenderWebhook
): Promise<IRestaurantDocument | null> => {
  const receiver = normalizePhone(webhook.receiver);
  const possibleWhatsappNumbers = [webhook.receiver, receiver].filter(Boolean);
  const query = [
    ...(webhook.sessionId ? [{ wasenderSessionId: webhook.sessionId }] : []),
    ...possibleWhatsappNumbers.map((phone) => ({ whatsappNumber: phone }))
  ];

  if (query.length === 0) {
    return null;
  }

  return Restaurant.findOne({
    $or: query
  });
};

const isOwnerOrManagerSender = (
  restaurant: IRestaurantDocument,
  senderPhone: string
): boolean => {
  const normalizedSender = normalizePhone(senderPhone);
  const allowedPhones = [
    restaurant.ownerPhone,
    ...restaurant.managerPhones,
    ...restaurant.managerContacts.map((manager) => manager.phone)
  ].map(normalizePhone);

  return allowedPhones.includes(normalizedSender);
};

const getPublicReceiptUrl = (receiptUrl?: string): string | null => {
  if (!receiptUrl) {
    return null;
  }

  if (/^https?:\/\//i.test(receiptUrl)) {
    return receiptUrl;
  }

  const publicUrl = process.env.APP_PUBLIC_URL?.replace(/\/$/, "");

  if (!publicUrl) {
    return null;
  }

  return `${publicUrl}${receiptUrl.startsWith("/") ? receiptUrl : `/${receiptUrl}`}`;
};

const formatCurrency = (value: number): string => {
  return `GHS ${value.toFixed(2)}`;
};

const buildOwnerOrderNotification = (
  order: NonNullable<Awaited<ReturnType<typeof agentCustomerService.handleCustomerMessage>>["data"]>["order"]
): string => {
  if (!order) {
    return "";
  }

  const items = order.items
    .map((item) => `- ${item.quantity} x ${item.name} (${formatCurrency(item.totalPrice)})`)
    .join("\n");
  const deliveryAddress =
    order.orderType === "delivery" && order.deliveryAddress
      ? `\nDelivery address: ${order.deliveryAddress}`
      : "";

  return [
    "New customer order confirmed",
    `Order: ${order.orderNumber ?? String(order._id)}`,
    `Customer: ${order.customerName || "Guest"} (${order.customerPhone})`,
    `Type: ${order.orderType}`,
    "Items:",
    items,
    `Total: ${formatCurrency(order.total)}`,
    deliveryAddress
  ]
    .filter(Boolean)
    .join("\n");
};

const sendReceiptIfAvailable = async (
  sessionId: string,
  to: string,
  receiptUrl?: string,
  caption?: string
): Promise<void> => {
  const publicReceiptUrl = getPublicReceiptUrl(receiptUrl);

  if (!publicReceiptUrl) {
    return;
  }

  await sendDocumentMessage(sessionId, to, publicReceiptUrl, caption);
};

const sendCustomerOrderSideEffects = async (
  restaurant: IRestaurantDocument,
  webhook: NormalizedWasenderWebhook,
  customerResponse: Awaited<ReturnType<typeof agentCustomerService.handleCustomerMessage>>
): Promise<void> => {
  const order = customerResponse.data?.order;

  if (!order) {
    return;
  }

  const sessionId = restaurant.wasenderSessionId;

  await sendReceiptIfAvailable(
    sessionId,
    webhook.from,
    order.receiptUrl,
    `Receipt for ${order.orderNumber ?? "your order"}`
  );

  const ownerMessage = buildOwnerOrderNotification(order);

  if (ownerMessage) {
    await sendTextMessage(sessionId, restaurant.ownerPhone, ownerMessage);
    await sendReceiptIfAvailable(
      sessionId,
      restaurant.ownerPhone,
      order.receiptUrl,
      `Receipt for ${order.orderNumber ?? "new order"}`
    );
  }
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
      webhookEvent.processedAt = new Date();
      await webhookEvent.save();
      return;
    }

    if (!webhook.from) {
      throw new Error("Wasender webhook missing sender phone");
    }

    if (webhook.messageType !== "text" || !webhook.message.trim()) {
      await sendTextMessage(
        restaurant.wasenderSessionId,
        webhook.from,
        "Please send a text message so I can help with your order."
      );
      webhookEvent.status = "processed";
      webhookEvent.processedAt = new Date();
      await webhookEvent.save();
      return;
    }

    if (isOwnerOrManagerSender(restaurant, webhook.from)) {
      const ownerResponse = await agentOwnerService.handleOwnerMessage({
        restaurantId: String(restaurant._id),
        senderPhone: webhook.from,
        message: webhook.message
      });
      await sendTextMessage(restaurant.wasenderSessionId, webhook.from, ownerResponse.message);
    } else {
      const customerResponse = await agentCustomerService.handleCustomerMessage({
        restaurantId: String(restaurant._id),
        customerPhone: webhook.from,
        message: webhook.message
      });
      await sendTextMessage(restaurant.wasenderSessionId, webhook.from, customerResponse.message);
      await sendCustomerOrderSideEffects(restaurant, webhook, customerResponse);
    }

    webhookEvent.status = "processed";
    webhookEvent.processedAt = new Date();
    await webhookEvent.save();
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

    await WebhookEvent.updateOne(
      {
        provider: "wasender",
        eventId
      },
      {
        $set: {
          status: "failed",
          processedAt: new Date()
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
