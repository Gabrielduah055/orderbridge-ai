import { randomBytes, randomUUID } from "crypto";
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
const reconciliationIntervalMs = 60_000;
let workerStarted = false;
let workerBusy = false;
let lastReconciliationAt = 0;

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

/**
 * Generates a stable, opaque receipt number using random bytes.
 * Format: CR-{16 random hex chars}. Per-business uniqueness is enforced
 * by the `(businessId, receiptNumber)` unique index.
 */
const generateReceiptNumber = (): string =>
  `CR-${randomBytes(8).toString("hex").toUpperCase()}`;

/**
 * Builds a Cloudinary-safe raw PDF public ID from the receipt's own
 * ObjectId. Ends with `.pdf` so raw-resource serving sets the correct
 * content type. The folder is supplied separately to `uploadRawBuffer`.
 */
const buildAssetPublicId = (receiptId: string): string =>
  `${receiptId}.pdf`;

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

      // Measure both cells so we can align from the same starting position
      const amountWidth = 56;
      const columnGap = 6;
      const nameWidth = contentWidth - amountWidth - columnGap;
      const amountText = formatMoney(item.lineTotalPesewas, event.order.currency);

      const nameHeight = doc
        .font("Helvetica-Bold")
        .fontSize(8.8)
        .heightOfString(item.name, { width: nameWidth });

      const amountHeight = doc
        .font("Helvetica-Bold")
        .fontSize(8.8)
        .heightOfString(amountText, { width: amountWidth });

      // Render name from start position
      doc
        .font("Helvetica-Bold")
        .fontSize(8.8)
        .fillColor(brandColor)
        .text(item.name, receiptMargin, itemStartY, {
          width: nameWidth
        });

      // Render amount from the same start position
      doc
        .font("Helvetica-Bold")
        .fontSize(8.8)
        .text(
          amountText,
          receiptMargin + contentWidth - amountWidth,
          itemStartY,
          { align: "right", width: amountWidth }
        );

      // Advance past the taller cell before placing the detail line
      const rowHeight = Math.max(nameHeight, amountHeight);
      doc.y = itemStartY + rowHeight + 1;

      doc
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor(mutedColor)
        .text(
          `${item.quantity} x ${formatMoney(item.unitPricePesewas, event.order.currency)}`,
          receiptMargin,
          doc.y,
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

/**
 * Releases a claimed receipt back to a reclaimable state.
 *
 * - Receipts whose PDF is already stored return to `generated` (not
 *   `pending`) so the worker retries only the enqueue, and are never
 *   marked `failed` since the generation budget does not apply.
 * - Receipts without a PDF return to `pending` unless the generation
 *   budget is exhausted, in which case they become `failed`.
 */
const deferClaimedReceipt = async (
  receipt: ICommerceReceiptDocument,
  claimId: string,
  reason: string,
  now = new Date()
): Promise<void> => {
  const hasStoredPdf = Boolean(receipt.pdfAssetUrl && receipt.pdfAssetPublicId);
  const isFinalFailure =
    !hasStoredPdf && receipt.generationAttempts >= receipt.maxGenerationAttempts;

  await CommerceReceipt.updateOne(
    {
      _id: receipt._id,
      status: { $in: ["generating", "generated"] },
      generationClaimId: claimId
    },
    {
      $set: {
        status: isFinalFailure
          ? "failed"
          : hasStoredPdf
            ? "generated"
            : "pending",
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

/**
 * Atomically claims the next receipt eligible for processing.
 *
 * Eligible statuses:
 * - `pending`   – ready for first/next generation attempt (no lease)
 * - `generating`– previous owner's lease expired (crash recovery)
 * - `generated` – PDF exists but enqueue failed or crashed; requires
 *                 expired or absent lease before reclaim
 *
 * `generationAttempts` is NOT incremented here. The caller increments
 * it only when an actual PDF generation/upload attempt is made, keeping
 * configuration deferrals and enqueue retries out of the budget.
 */
const claimNextReceipt = async (
  now = new Date()
): Promise<{ receipt: ICommerceReceiptDocument; claimId: string } | null> => {
  const claimId = randomUUID();
  const receipt = await CommerceReceipt.findOneAndUpdate(
    {
      status: { $in: ["pending", "generating", "generated"] },
      $and: [
        {
          $or: [
            { nextGenerationAttemptAt: { $lte: now } },
            { nextGenerationAttemptAt: { $exists: false } }
          ]
        },
        {
          $or: [
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
        generationLeaseExpiresAt: new Date(now.getTime() + generationLeaseMs)
      }
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
 * completes the event's text enqueueing, and by the reconciliation sweep
 * for events whose original receipt creation failed. A duplicate-key race
 * returns the existing record. Receipt-number collisions are retried with
 * a new random number.
 */
export const ensureCommerceReceiptRecord = async (
  businessId: string,
  commerceEventId: string,
  merchantName: string
): Promise<ICommerceReceiptDocument> => {
  const existing = await CommerceReceipt.findOne({
    businessId,
    commerceEventId
  });
  if (existing) return existing;

  const maxReceiptNumberAttempts = 3;
  for (let attempt = 0; attempt < maxReceiptNumberAttempts; attempt++) {
    const receiptNumber = generateReceiptNumber();
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
        // Duplicate key — either a race on (businessId, commerceEventId)
        // or a receipt-number collision within this business.
        const raceExisting = await CommerceReceipt.findOne({
          businessId,
          commerceEventId
        });
        if (raceExisting) return raceExisting;
        // Receipt-number collision — retry with a new random number
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    "Failed to generate unique receipt number after retries"
  );
};

// ── Reconciliation ─────────────────────────────────────────────────────

/**
 * Finds the oldest `enqueued` commerce event that lacks a receipt record and
 * creates one idempotently. This covers events processed by 3D1 whose
 * `ensureCommerceReceiptRecord` call failed or events that predated the
 * receipt feature. Runs at most once per `reconciliationIntervalMs`,
 * independently of the generation queue.
 */
const reconcileNextMissingReceipt = async (): Promise<boolean> => {
  const [event] = await CommercePaidOrderEvent.aggregate<{
    businessId: unknown;
    eventId: string;
    merchantName: string;
  }>([
    { $match: { status: "enqueued" } },
    { $sort: { enqueueCompletedAt: 1, _id: 1 } },
    {
      $lookup: {
        from: CommerceReceipt.collection.name,
        let: { businessId: "$businessId", eventId: "$eventId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$businessId", "$$businessId"] },
                  { $eq: ["$commerceEventId", "$$eventId"] }
                ]
              }
            }
          },
          { $limit: 1 }
        ],
        as: "receipts"
      }
    },
    { $match: { "receipts.0": { $exists: false } } },
    {
      $lookup: {
        from: Business.collection.name,
        localField: "businessId",
        foreignField: "_id",
        as: "businesses"
      }
    },
    { $unwind: "$businesses" },
    {
      $project: {
        businessId: 1,
        eventId: 1,
        merchantName: "$businesses.name"
      }
    },
    { $limit: 1 }
  ]);

  if (!event) return false;

  const businessId = String(event.businessId);
  try {
    await ensureCommerceReceiptRecord(
      businessId,
      event.eventId,
      event.merchantName
    );
    console.log("[commerceReceiptGeneration] Reconciled missing receipt", {
      businessId,
      eventId: event.eventId
    });
    return true;
  } catch (error) {
    console.error("[commerceReceiptGeneration] Receipt reconciliation failed", {
      businessId,
      eventId: event.eventId,
      error: error instanceof Error ? error.message : "Unknown reconciliation error"
    });
    return false;
  }
};

// ── Process one receipt ────────────────────────────────────────────────

export const processNextCommerceReceipt = async (): Promise<boolean> => {
  if (Date.now() - lastReconciliationAt >= reconciliationIntervalMs) {
    lastReconciliationAt = Date.now();
    try {
      await reconcileNextMissingReceipt();
    } catch (error) {
      console.error("[commerceReceiptGeneration] Reconciliation sweep failed", {
        error: error instanceof Error ? error.message : "Unknown reconciliation error"
      });
    }
  }

  const claimed = await claimNextReceipt();
  if (!claimed) return false;

  const { receipt, claimId } = claimed;
  const businessId = String(receipt.businessId);

  try {
    // If the PDF is already stored, skip generation and go to enqueue.
    if (!receipt.pdfAssetUrl || !receipt.pdfAssetPublicId) {
      // ── Configuration checks (do NOT consume the generation budget) ──
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

      const configBusiness = await Business.findById(businessId).select(
        "+whatsappIntegration.wasenderApiToken"
      );
      if (!configBusiness) {
        await deferClaimedReceipt(receipt, claimId, "business_missing");
        return true;
      }
      const configReason = getCommerceNotificationConfigurationReason(configBusiness);
      if (configReason) {
        await deferClaimedReceipt(receipt, claimId, configReason);
        return true;
      }

      if (receipt.generationAttempts >= receipt.maxGenerationAttempts) {
        await deferClaimedReceipt(
          receipt,
          claimId,
          "receipt_generation_attempts_exhausted"
        );
        return true;
      }

      // ── Actual generation attempt — count it against the budget ──
      const budgetUpdate = await CommerceReceipt.findOneAndUpdate(
        {
          _id: receipt._id,
          status: "generating",
          generationClaimId: claimId
        },
        {
          $inc: { generationAttempts: 1 },
          $set: { lastGenerationAttemptAt: new Date() }
        },
        { new: true }
      );
      if (!budgetUpdate) return true;
      receipt.generationAttempts = budgetUpdate.generationAttempts;

      const pdfBuffer = await generateCommerceReceiptPdf(
        receipt.merchantName,
        receipt.receiptNumber,
        event
      );

      const assetPublicId = buildAssetPublicId(String(receipt._id));
      const asset = await uploadRawBuffer(
        pdfBuffer,
        assetPublicId,
        "commerce-receipts"
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
