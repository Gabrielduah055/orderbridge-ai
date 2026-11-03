import { randomUUID } from "crypto";
import PDFDocument from "pdfkit";
import { Business } from "../models/business.model";
import {
  CommerceReceipt,
  type ICommerceReceiptDocument
} from "../models/commerceReceipt.model";
import {
  CommercePaidOrderEvent,
  type ICommercePaidOrderEventDocument
} from "../models/commercePaidOrderEvent.model";
import {
  isCloudinaryConfigured,
  uploadRawBuffer
} from "./cloudinary.service";
import {
  commercePaidOrderReceiptNotificationKind,
  getCommerceNotificationConfigurationReason
} from "./commerceNotificationConfiguration.service";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { enqueueWasenderMessage } from "./wasenderQueue.service";
import {
  markRuntimeRunFailed,
  markRuntimeRunStarted,
  markRuntimeRunSucceeded,
  markRuntimeStarted
} from "./runtimeHealth.service";

const workerIntervalMs = 3_000;
const generationLeaseMs = 5 * 60_000;
const initialDeferralMs = 30_000;
const maximumDeferralMs = 15 * 60_000;
let workerStarted = false;
let workerBusy = false;

// ── PDF layout constants ───────────────────────────────────────────────

const receiptWidth = 242;
const receiptMargin = 14;
const contentWidth = receiptWidth - receiptMargin * 2;
const brandColor = "#111827";
const mutedColor = "#6B7280";
const ruleColor = "#E5E7EB";
const accentColor = "#F59E0B";

// ── Helpers ────────────────────────────────────────────────────────────

const formatMoney = (pesewas: number, currency: string): string =>
  `${currency} ${(pesewas / 100).toFixed(2)}`;

const formatDateTime = (date: Date): string =>
  date.toISOString().replace("T", " ").slice(0, 16);

const buildReceiptNumber = (
  businessId: string,
  eventId: string
): string => `CR-${businessId.slice(-6).toUpperCase()}-${eventId.slice(0, 12).toUpperCase()}`;

const buildAssetPublicId = (
  businessId: string,
  commerceEventId: string
): string =>
  `${businessId}/${commerceEventId}`;

const buildReceiptQueueIdempotencyKey = (
  businessId: string,
  eventId: string,
  normalizedRecipient: string
): string =>
  `commerce:${businessId}:${eventId}:receipt:${normalizedRecipient}`;

// ── PDF drawing ────────────────────────────────────────────────────────

const moveY = (doc: PDFKit.PDFDocument, amount: number): void => {
  doc.y += amount;
};

const drawDivider = (doc: PDFKit.PDFDocument, dashed = false): void => {
  const y = doc.y + 7;
  if (dashed) doc.dash(2, { space: 3 });
  doc
    .moveTo(receiptMargin, y)
    .lineTo(receiptWidth - receiptMargin, y)
    .strokeColor(ruleColor)
    .lineWidth(1)
    .stroke();
  if (dashed) doc.undash();
  doc.strokeColor(brandColor);
  doc.y = y + 11;
};

const drawCenteredText = (
  doc: PDFKit.PDFDocument,
  text: string,
  fontSize: number,
  font = "Helvetica",
  color = brandColor
): void => {
  doc
    .font(font)
    .fontSize(fontSize)
    .fillColor(color)
    .text(text, receiptMargin, doc.y, {
      align: "center",
      width: contentWidth
    });
};

const drawLabelValue = (
  doc: PDFKit.PDFDocument,
  label: string,
  value?: string | number | null,
  options: { boldValue?: boolean; large?: boolean } = {}
): void => {
  if (value === undefined || value === null || value === "") return;
  const y = doc.y;
  const valueFont = options.boldValue ? "Helvetica-Bold" : "Helvetica";
  const fontSize = options.large ? 11 : 8.4;
  doc.font("Helvetica").fontSize(fontSize).fillColor(mutedColor).text(label, receiptMargin, y, {
    width: 76
  });
  doc
    .font(valueFont)
    .fontSize(fontSize)
    .fillColor(brandColor)
    .text(String(value), receiptMargin + 80, y, {
      align: "right",
      width: contentWidth - 80
    });
  doc.y = Math.max(doc.y, y + fontSize + 4);
};

const estimateCommerceReceiptHeight = (
  event: ICommercePaidOrderEventDocument
): number => {
  const itemLines = event.order.items.reduce(
    (sum, item) => sum + Math.max(1, Math.ceil(item.name.length / 26)),
    0
  );
  return Math.max(480, 380 + itemLines * 22);
};

const generateCommerceReceiptPdf = (
  merchantName: string,
  receiptNumber: string,
  event: ICommercePaidOrderEventDocument
): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    const receiptHeight = estimateCommerceReceiptHeight(event);
    const doc = new PDFDocument({
      margin: receiptMargin,
      size: [receiptWidth, receiptHeight]
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header
    doc.rect(0, 0, receiptWidth, 78).fill("#FFF7ED");
    doc.fillColor(accentColor).rect(0, 0, receiptWidth, 4).fill();
    doc.y = 14;
    drawCenteredText(doc, merchantName, 15, "Helvetica-Bold");
    moveY(doc, 11);
    doc
      .roundedRect(receiptMargin, doc.y, contentWidth, 30, 6)
      .fillAndStroke(brandColor, brandColor);
    doc
      .fillColor("#FFFFFF")
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("PAYMENT RECEIPT", receiptMargin, doc.y + 6, {
        align: "center",
        width: contentWidth
      });
    doc
      .font("Helvetica")
      .fontSize(7.4)
      .text(receiptNumber, receiptMargin, doc.y + 1, {
        align: "center",
        width: contentWidth
      });
    doc.y += 19;
    drawDivider(doc);

    // Order meta
    drawLabelValue(doc, "Order no.", event.order.orderNumber, { boldValue: true });
    drawLabelValue(doc, "Paid at", formatDateTime(event.order.paidAt));
    drawLabelValue(doc, "Customer", event.order.customer.name);
    drawLabelValue(doc, "Phone", event.order.customer.phone);
    if (event.order.customer.email) {
      drawLabelValue(doc, "Email", event.order.customer.email);
    }
    drawDivider(doc, true);

    // Items
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(brandColor)
      .text("Items", receiptMargin, doc.y);
    moveY(doc, 3);

    for (const item of event.order.items) {
      const itemStartY = doc.y;
      doc
        .font("Helvetica-Bold")
        .fontSize(8.8)
        .fillColor(brandColor)
        .text(item.name, receiptMargin, itemStartY, {
          width: contentWidth - 52
        });
      doc
        .font("Helvetica-Bold")
        .fontSize(8.8)
        .text(
          formatMoney(item.lineTotalPesewas, event.order.currency),
          receiptMargin + contentWidth - 56,
          itemStartY,
          { align: "right", width: 56 }
        );
      doc
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor(mutedColor)
        .text(
          `${item.quantity} x ${formatMoney(item.unitPricePesewas, event.order.currency)}`,
          receiptMargin,
          doc.y + 1,
          { width: contentWidth }
        );
      moveY(doc, 7);
    }

    drawDivider(doc, true);

    // Total
    moveY(doc, 3);
    doc.roundedRect(receiptMargin, doc.y, contentWidth, 32, 6).fill("#F3F4F6");
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(brandColor)
      .text("PRODUCT TOTAL", receiptMargin + 6, doc.y + 9, { width: 90 });
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor(brandColor)
      .text(
        formatMoney(event.order.productPaymentTotalPesewas, event.order.currency),
        receiptMargin + 82,
        doc.y - 15,
        { align: "right", width: contentWidth - 92 }
      );
    doc.y += 32;

    // Delivery note
    moveY(doc, 4);
    drawCenteredText(
      doc,
      "Delivery fees are arranged separately.",
      7.8,
      "Helvetica",
      mutedColor
    );
    drawDivider(doc);

    // Footer
    drawCenteredText(doc, "Thank you for your order.", 9, "Helvetica-Bold");
    moveY(doc, 3);
    drawCenteredText(doc, "Powered by OrderBridge AI", 7.4, "Helvetica", mutedColor);

    doc.end();
  });

// ── Claim/defer helpers ────────────────────────────────────────────────

const getGenerationDeferralMs = (attempts: number): number => {
  const exponent = Math.min(Math.max(attempts - 1, 0), 8);
  return Math.min(initialDeferralMs * 2 ** exponent, maximumDeferralMs);
};

const deferClaimedReceipt = async (
  receipt: ICommerceReceiptDocument,
  claimId: string,
  reason: string,
  now = new Date()
): Promise<void> => {
  const isFinalFailure =
    receipt.generationAttempts >= receipt.maxGenerationAttempts;
  await CommerceReceipt.updateOne(
    {
      _id: receipt._id,
      status: "generating",
      generationClaimId: claimId
    },
    {
      $set: {
        status: isFinalFailure ? "failed" : "pending",
        nextGenerationAttemptAt: new Date(
          now.getTime() + getGenerationDeferralMs(receipt.generationAttempts)
        ),
        lastGenerationError: reason
      },
      $unset: {
        generationClaimId: "",
        generationLeaseExpiresAt: ""
      }
    }
  );
};

const claimNextReceipt = async (
  now = new Date()
): Promise<{ receipt: ICommerceReceiptDocument; claimId: string } | null> => {
  const claimId = randomUUID();
  const receipt = await CommerceReceipt.findOneAndUpdate(
    {
      status: { $in: ["pending", "generating"] },
      $and: [
        {
          $or: [
            { nextGenerationAttemptAt: { $lte: now } },
            { nextGenerationAttemptAt: { $exists: false } }
          ]
        },
        {
          $or: [
            { status: "pending" },
            { generationLeaseExpiresAt: { $lte: now } },
            { generationLeaseExpiresAt: { $exists: false } }
          ]
        }
      ]
    },
    {
      $set: {
        status: "generating",
        generationClaimId: claimId,
        generationLeaseExpiresAt: new Date(now.getTime() + generationLeaseMs),
        lastGenerationAttemptAt: now
      },
      $inc: { generationAttempts: 1 }
    },
    {
      new: true,
      sort: { nextGenerationAttemptAt: 1, createdAt: 1 }
    }
  );
  return receipt ? { receipt, claimId } : null;
};

// ── Ensure receipt record ──────────────────────────────────────────────

/**
 * Creates a receipt record for an enqueued commerce event if one does
 * not already exist. Called by the text-notification consumer after it
 * marks the event `enqueued`. A duplicate-key race returns the existing
 * record.
 */
export const ensureCommerceReceiptRecord = async (
  businessId: string,
  commerceEventId: string,
  merchantName: string
): Promise<ICommerceReceiptDocument> => {
  const receiptNumber = buildReceiptNumber(businessId, commerceEventId);
  try {
    return await CommerceReceipt.create({
      businessId,
      commerceEventId,
      receiptNumber,
      merchantName,
      status: "pending",
      generationAttempts: 0,
      maxGenerationAttempts: 8,
      nextGenerationAttemptAt: new Date()
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      const existing = await CommerceReceipt.findOne({
        businessId,
        commerceEventId
      });
      if (existing) return existing;
    }
    throw error;
  }
};

// ── Process one receipt ────────────────────────────────────────────────

export const processNextCommerceReceipt = async (): Promise<boolean> => {
  const claimed = await claimNextReceipt();
  if (!claimed) return false;

  const { receipt, claimId } = claimed;
  const businessId = String(receipt.businessId);

  try {
    // If the PDF is already stored, skip generation and go to enqueue.
    if (!receipt.pdfAssetUrl || !receipt.pdfAssetPublicId) {
      if (!isCloudinaryConfigured()) {
        await deferClaimedReceipt(receipt, claimId, "cloudinary_not_configured");
        return true;
      }

      const event = await CommercePaidOrderEvent.findOne({
        businessId,
        eventId: receipt.commerceEventId,
        status: "enqueued"
      });
      if (!event) {
        await deferClaimedReceipt(receipt, claimId, "commerce_event_not_ready");
        return true;
      }

      const pdfBuffer = await generateCommerceReceiptPdf(
        receipt.merchantName,
        receipt.receiptNumber,
        event
      );

      const assetPublicId = buildAssetPublicId(businessId, receipt.commerceEventId);
      const asset = await uploadRawBuffer(
        pdfBuffer,
        assetPublicId,
        "commerce-receipts",
        "pdf"
      );

      await CommerceReceipt.updateOne(
        {
          _id: receipt._id,
          status: "generating",
          generationClaimId: claimId
        },
        {
          $set: {
            status: "generated",
            pdfAssetPublicId: asset.publicId,
            pdfAssetUrl: asset.secureUrl,
            generatedAt: new Date()
          },
          $unset: {
            lastGenerationError: ""
          }
        }
      );
      receipt.status = "generated";
      receipt.pdfAssetUrl = asset.secureUrl;
      receipt.pdfAssetPublicId = asset.publicId;
    }

    // Enqueue the document delivery message.
    const business = await Business.findById(businessId).select(
      "+whatsappIntegration.wasenderApiToken"
    );
    if (!business) {
      await deferClaimedReceipt(receipt, claimId, "business_missing");
      return true;
    }

    const configurationReason = getCommerceNotificationConfigurationReason(business);
    if (configurationReason) {
      await deferClaimedReceipt(receipt, claimId, configurationReason);
      return true;
    }

    const event = await CommercePaidOrderEvent.findOne({
      businessId,
      eventId: receipt.commerceEventId,
      status: "enqueued"
    });
    if (!event) {
      await deferClaimedReceipt(receipt, claimId, "commerce_event_not_ready");
      return true;
    }

    if (!event.order.customer.whatsappConsent) {
      await CommerceReceipt.updateOne(
        {
          _id: receipt._id,
          generationClaimId: claimId
        },
        {
          $set: {
            status: "failed",
            lastGenerationError: "customer_whatsapp_consent_missing"
          },
          $unset: {
            generationClaimId: "",
            generationLeaseExpiresAt: ""
          }
        }
      );
      return true;
    }

    const integration = business.whatsappIntegration!;
    const sessionId = integration.wasenderSessionId!;
    const apiKey = integration.wasenderApiToken!;
    const customerRecipient =
      normalizeGhanaPhone(event.order.customer.phone) ||
      event.order.customer.phone.trim();

    await enqueueWasenderMessage({
      businessId,
      sessionId,
      to: customerRecipient,
      type: "document",
      documentUrl: receipt.pdfAssetUrl!,
      caption: `Receipt for order ${event.order.orderNumber}`,
      apiKey,
      idempotencyKey: buildReceiptQueueIdempotencyKey(
        businessId,
        event.eventId,
        customerRecipient
      ),
      metadata: {
        kind: commercePaidOrderReceiptNotificationKind,
        businessId,
        commerceEventId: event.eventId,
        commerceReceiptId: String(receipt._id),
        recipientType: "customer"
      }
    });

    await CommerceReceipt.updateOne(
      {
        _id: receipt._id,
        generationClaimId: claimId
      },
      {
        $set: {
          status: "enqueued",
          enqueueCompletedAt: new Date()
        },
        $unset: {
          generationClaimId: "",
          generationLeaseExpiresAt: "",
          lastGenerationError: ""
        }
      }
    );
    return true;
  } catch {
    await deferClaimedReceipt(receipt, claimId, "receipt_processing_failed");
    console.error("Commerce receipt processing failed", {
      businessId,
      commerceEventId: receipt.commerceEventId
    });
    return true;
  }
};

// ── Worker ─────────────────────────────────────────────────────────────

export const startCommerceReceiptWorker = (): void => {
  if (workerStarted) return;

  workerStarted = true;
  markRuntimeStarted("commerce_receipt_generation", workerIntervalMs);
  console.log(
    `[commerceReceiptGeneration] Worker started (check every ${
      workerIntervalMs / 1000
    }s)`
  );

  const timer = setInterval(() => {
    if (workerBusy) return;

    workerBusy = true;
    markRuntimeRunStarted("commerce_receipt_generation");
    void processNextCommerceReceipt()
      .then(() => {
        markRuntimeRunSucceeded("commerce_receipt_generation");
      })
      .catch((error) => {
        markRuntimeRunFailed(
          "commerce_receipt_generation",
          "COMMERCE_RECEIPT_PASS_FAILED"
        );
        console.error("Commerce receipt generation worker failed", {
          error: error instanceof Error ? error.message : "Unknown worker error"
        });
      })
      .finally(() => {
        workerBusy = false;
      });
  }, workerIntervalMs);

  timer.unref();
};
