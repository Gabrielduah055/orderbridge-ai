import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { Types } from "mongoose";
import { Order, type IOrderDocument, type OrderStatus } from "../models/order.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";

interface ReceiptResult {
  receiptUrl: string;
  filePath: string;
  order: IOrderDocument;
}

const receiptEligibleStatuses: OrderStatus[] = ["confirmed", "preparing", "ready", "completed"];
const receiptWidth = 242;
const receiptMargin = 14;
const contentWidth = receiptWidth - receiptMargin * 2;
const brandColor = "#111827";
const mutedColor = "#6B7280";
const ruleColor = "#E5E7EB";
const accentColor = "#F59E0B";

const ensureValidObjectId = (id: string, fieldName: string): void => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${fieldName}`);
  }
};

const formatCurrency = (value: number): string => {
  return `GHS ${value.toFixed(2)}`;
};

const formatDateTime = (date: Date): string => {
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const titleCase = (value: string): string => {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
};

const getOrderOrThrow = async (orderId: string): Promise<IOrderDocument> => {
  ensureValidObjectId(orderId, "orderId");
  const order = await Order.findById(orderId);

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  return order;
};

const getRestaurantOrThrow = async (
  restaurantId: string
): Promise<IRestaurantDocument> => {
  const restaurant = await Restaurant.findById(restaurantId);

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  return restaurant;
};

const getReceiptUrl = (orderId: string): string => {
  return `/uploads/receipts/order-${orderId}.pdf`;
};

const getReceiptFilePath = (orderId: string): string => {
  return path.join(process.cwd(), "uploads", "receipts", `order-${orderId}.pdf`);
};

const getOptionalRestaurantImageUrl = (restaurant: IRestaurantDocument): string | null => {
  const imageFields = ["logoUrl", "imageUrl", "businessImageUrl", "photoUrl"];
  const restaurantRecord = restaurant.toObject() as Record<string, unknown>;

  for (const field of imageFields) {
    const value = restaurantRecord[field];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
};

const getLocalImagePath = (imageUrl: string | null): string | null => {
  if (!imageUrl) {
    return null;
  }

  if (!imageUrl.startsWith("/uploads/")) {
    return null;
  }

  const filePath = path.join(process.cwd(), imageUrl.replace(/^\//, ""));
  const supportedImage = /\.(jpe?g|png)$/i.test(filePath);

  if (!supportedImage || !fs.existsSync(filePath)) {
    return null;
  }

  return filePath;
};

const estimateReceiptHeight = (
  order: IOrderDocument,
  restaurant: IRestaurantDocument,
  hasLogo: boolean
): number => {
  const addressLength =
    (restaurant.pickupAddress?.length ?? 0) + (order.deliveryAddress?.length ?? 0);
  const addressLines = Math.ceil(addressLength / 36);
  const itemLines = order.items.reduce(
    (sum, item) => sum + Math.max(1, Math.ceil(item.name.length / 26)),
    0
  );

  return Math.max(420, 302 + (hasLogo ? 46 : 0) + addressLines * 10 + itemLines * 22);
};

const moveY = (doc: PDFKit.PDFDocument, amount: number): void => {
  doc.y += amount;
};

const drawDivider = (doc: PDFKit.PDFDocument, dashed = false): void => {
  const y = doc.y + 7;

  if (dashed) {
    doc.dash(2, { space: 3 });
  }

  doc
    .moveTo(receiptMargin, y)
    .lineTo(receiptWidth - receiptMargin, y)
    .strokeColor(ruleColor)
    .lineWidth(1)
    .stroke();

  if (dashed) {
    doc.undash();
  }

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
  if (value === undefined || value === null || value === "") {
    return;
  }

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

const drawLogo = (doc: PDFKit.PDFDocument, logoPath: string | null): void => {
  if (!logoPath) {
    return;
  }

  try {
    const logoSize = 38;
    const logoX = (receiptWidth - logoSize) / 2;
    doc.image(logoPath, logoX, doc.y, {
      fit: [logoSize, logoSize],
      align: "center",
      valign: "center"
    });
    doc.y += logoSize + 7;
  } catch {
    // Ignore invalid image files and continue with the text-only receipt header.
  }
};

const drawReceiptHeader = (
  doc: PDFKit.PDFDocument,
  order: IOrderDocument,
  restaurant: IRestaurantDocument,
  logoPath: string | null
): void => {
  doc.rect(0, 0, receiptWidth, 78).fill("#FFF7ED");
  doc.fillColor(accentColor).rect(0, 0, receiptWidth, 4).fill();
  doc.y = 14;

  drawLogo(doc, logoPath);
  drawCenteredText(doc, restaurant.name, 15, "Helvetica-Bold");

  if (restaurant.pickupAddress) {
    moveY(doc, 3);
    drawCenteredText(doc, restaurant.pickupAddress, 7.8, "Helvetica", mutedColor);
  }

  if (restaurant.whatsappNumber || restaurant.ownerPhone) {
    moveY(doc, 2);
    drawCenteredText(
      doc,
      restaurant.whatsappNumber || restaurant.ownerPhone,
      8,
      "Helvetica-Bold",
      brandColor
    );
  }

  moveY(doc, 11);
  doc
    .roundedRect(receiptMargin, doc.y, contentWidth, 30, 6)
    .fillAndStroke(brandColor, brandColor);
  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(10)
    .text("FOOD ORDER RECEIPT", receiptMargin, doc.y + 6, {
      align: "center",
      width: contentWidth
    });
  doc
    .font("Helvetica")
    .fontSize(7.4)
    .text(order.orderNumber || String(order._id), receiptMargin, doc.y + 1, {
      align: "center",
      width: contentWidth
    });
  doc.y += 19;
  drawDivider(doc);
};

const drawOrderMeta = (doc: PDFKit.PDFDocument, order: IOrderDocument): void => {
  drawLabelValue(doc, "Order no.", order.orderNumber, { boldValue: true });
  drawLabelValue(doc, "Date", formatDateTime(order.createdAt));
  drawLabelValue(doc, "Customer", order.customerName || "Guest");
  drawLabelValue(doc, "Phone", order.customerPhone);
  drawLabelValue(doc, "Type", titleCase(order.orderType), { boldValue: true });

  if (order.orderType === "delivery") {
    drawLabelValue(doc, "Address", order.deliveryAddress);
  }

  drawDivider(doc, true);
};

const drawItems = (doc: PDFKit.PDFDocument, order: IOrderDocument): void => {
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(brandColor)
    .text("Items", receiptMargin, doc.y);
  moveY(doc, 3);

  for (const item of order.items) {
    const itemStartY = doc.y;
    doc.font("Helvetica-Bold").fontSize(8.8).fillColor(brandColor).text(item.name, receiptMargin, itemStartY, {
      width: contentWidth - 52
    });
    doc
      .font("Helvetica-Bold")
      .fontSize(8.8)
      .text(formatCurrency(item.totalPrice), receiptMargin + contentWidth - 56, itemStartY, {
        align: "right",
        width: 56
      });

    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(mutedColor)
      .text(`${item.quantity} x ${formatCurrency(item.unitPrice)}`, receiptMargin, doc.y + 1, {
        width: contentWidth
      });
    moveY(doc, 7);
  }

  drawDivider(doc, true);
};

const drawTotals = (doc: PDFKit.PDFDocument, order: IOrderDocument): void => {
  drawLabelValue(doc, "Subtotal", formatCurrency(order.subtotal));
  drawLabelValue(doc, "Delivery", formatCurrency(order.deliveryFee));

  moveY(doc, 3);
  doc.roundedRect(receiptMargin, doc.y, contentWidth, 32, 6).fill("#F3F4F6");
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(brandColor)
    .text("TOTAL", receiptMargin + 10, doc.y + 9, {
      width: 70
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor(brandColor)
    .text(formatCurrency(order.total), receiptMargin + 82, doc.y - 15, {
      align: "right",
      width: contentWidth - 92
    });
  doc.y += 32;
  drawDivider(doc);
};

const drawPaymentAndFooter = (doc: PDFKit.PDFDocument, order: IOrderDocument): void => {
  drawLabelValue(doc, "Payment", titleCase(order.paymentMethod));
  drawLabelValue(doc, "Paid", titleCase(order.paymentStatus));
  drawLabelValue(doc, "Status", titleCase(order.status), { boldValue: true });

  if (order.notes) {
    drawLabelValue(doc, "Notes", order.notes);
  }

  drawDivider(doc, true);
  drawCenteredText(doc, "Thank you for your order.", 9, "Helvetica-Bold");
  moveY(doc, 3);
  drawCenteredText(doc, "Powered by OrderBridge AI", 7.4, "Helvetica", mutedColor);
};

const writeReceiptPdf = async (
  order: IOrderDocument,
  restaurant: IRestaurantDocument,
  filePath: string
): Promise<void> => {
  await fs.promises.mkdir(path.dirname(filePath), {
    recursive: true
  });

  const logoPath = getLocalImagePath(getOptionalRestaurantImageUrl(restaurant));
  const receiptHeight = estimateReceiptHeight(order, restaurant, Boolean(logoPath));

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      margin: receiptMargin,
      size: [receiptWidth, receiptHeight]
    });
    const stream = fs.createWriteStream(filePath);

    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
    doc.pipe(stream);

    drawReceiptHeader(doc, order, restaurant, logoPath);
    drawOrderMeta(doc, order);
    drawItems(doc, order);
    drawTotals(doc, order);
    drawPaymentAndFooter(doc, order);

    doc.end();
  });
};

export const generateOrderReceipt = async (orderId: string): Promise<ReceiptResult> => {
  const order = await getOrderOrThrow(orderId);

  if (order.items.length === 0) {
    throw new BadRequestError("Order has no items");
  }

  if (!receiptEligibleStatuses.includes(order.status)) {
    throw new BadRequestError("Receipts can only be generated for confirmed orders");
  }

  const receiptUrl = order.receiptUrl || getReceiptUrl(orderId);
  const filePath = getReceiptFilePath(orderId);

  if (order.receiptUrl) {
    return {
      receiptUrl,
      filePath,
      order
    };
  }

  const restaurant = await getRestaurantOrThrow(String(order.restaurantId));
  await writeReceiptPdf(order, restaurant, filePath);

  order.receiptUrl = receiptUrl;
  order.receiptGeneratedAt = new Date();
  await order.save();

  return {
    receiptUrl,
    filePath,
    order
  };
};
