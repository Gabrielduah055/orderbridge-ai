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
    req.header("x-wasender-webhook-secret") ??
    req.header("x-webhook-secret") ??
    req.header("x-webhook-token");
  const querySecret = typeof req.query.secret === "string" ? req.query.secret : undefined;

  return headerSecret ?? querySecret;
};

const isWebhookVerified = (req: Request): boolean => {
  const expectedSecret = process.env.WASENDER_WEBHOOK_SECRET;

  if (!expectedSecret) {
    return true;
  }

  return getWebhookSecret(req) === expectedSecret;
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

  await sendReceiptIfAvailable(
    webhook.sessionId,
    webhook.from,
    order.receiptUrl,
    `Receipt for ${order.orderNumber ?? "your order"}`
  );

  const ownerMessage = buildOwnerOrderNotification(order);

  if (ownerMessage) {
    await sendTextMessage(webhook.sessionId, restaurant.ownerPhone, ownerMessage);
    await sendReceiptIfAvailable(
      webhook.sessionId,
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
        webhook.sessionId,
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
      await sendTextMessage(webhook.sessionId, webhook.from, ownerResponse.message);
    } else {
      const customerResponse = await agentCustomerService.handleCustomerMessage({
        restaurantId: String(restaurant._id),
        customerPhone: webhook.from,
        message: webhook.message
      });
      await sendTextMessage(webhook.sessionId, webhook.from, customerResponse.message);
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

    const webhook = normalizeIncomingWebhook(req.body);

    res.status(200).json({
      success: true
    });

    void processNormalizedWebhook(webhook);
  } catch (error) {
    next(error);
  }
};
