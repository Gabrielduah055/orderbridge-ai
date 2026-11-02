import { Schema, model, type Document, type Types } from "mongoose";

export const commercePaidOrderEventStatuses = ["received"] as const;

export type CommercePaidOrderEventStatus =
  (typeof commercePaidOrderEventStatuses)[number];

export interface CommercePaidOrderItem {
  externalProductId: string;
  name: string;
  quantity: number;
  unitPricePesewas: number;
  lineTotalPesewas: number;
}

export interface CommercePaidOrderCustomer {
  name: string;
  phone: string;
  email?: string;
  whatsappConsent: boolean;
}

export interface CommercePaidOrderDelivery {
  recipientName?: string;
  recipientPhone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  instructions?: string;
  chargeStatus: "to_be_arranged";
}

export interface CommercePaidOrderSnapshot {
  externalOrderId: string;
  orderNumber: string;
  paymentReference: string;
  paidAt: Date;
  currency: "GHS";
  productPaymentTotalPesewas: number;
  items: CommercePaidOrderItem[];
  customer: CommercePaidOrderCustomer;
  delivery: CommercePaidOrderDelivery;
}

export interface ICommercePaidOrderEvent {
  businessId: Types.ObjectId;
  type: "order.paid";
  eventId: string;
  occurredAt: Date;
  order: CommercePaidOrderSnapshot;
  receivedAt: Date;
  status: CommercePaidOrderEventStatus;
  payloadHash: string;
}

export interface ICommercePaidOrderEventDocument
  extends ICommercePaidOrderEvent,
    Document {}

const itemSchema = new Schema<CommercePaidOrderItem>(
  {
    externalProductId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    unitPricePesewas: { type: Number, required: true },
    lineTotalPesewas: { type: Number, required: true }
  },
  { _id: false }
);

const customerSchema = new Schema<CommercePaidOrderCustomer>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    whatsappConsent: { type: Boolean, required: true }
  },
  { _id: false }
);

const deliverySchema = new Schema<CommercePaidOrderDelivery>(
  {
    recipientName: { type: String, trim: true },
    recipientPhone: { type: String, trim: true },
    addressLine1: { type: String, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, trim: true },
    region: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    countryCode: { type: String, trim: true, uppercase: true },
    instructions: { type: String, trim: true },
    chargeStatus: {
      type: String,
      enum: ["to_be_arranged"],
      required: true
    }
  },
  { _id: false }
);

const orderSchema = new Schema<CommercePaidOrderSnapshot>(
  {
    externalOrderId: { type: String, required: true, trim: true },
    orderNumber: { type: String, required: true, trim: true },
    paymentReference: { type: String, required: true, trim: true },
    paidAt: { type: Date, required: true },
    currency: { type: String, enum: ["GHS"], required: true },
    productPaymentTotalPesewas: { type: Number, required: true },
    items: { type: [itemSchema], required: true },
    customer: { type: customerSchema, required: true },
    delivery: { type: deliverySchema, required: true }
  },
  { _id: false }
);

const commercePaidOrderEventSchema =
  new Schema<ICommercePaidOrderEventDocument>(
    {
      businessId: {
        type: Schema.Types.ObjectId,
        ref: "Business",
        required: true
      },
      type: { type: String, enum: ["order.paid"], required: true },
      eventId: { type: String, required: true, trim: true },
      occurredAt: { type: Date, required: true },
      order: { type: orderSchema, required: true },
      receivedAt: { type: Date, required: true, default: Date.now },
      status: {
        type: String,
        enum: commercePaidOrderEventStatuses,
        required: true,
        default: "received"
      },
      payloadHash: {
        type: String,
        required: true,
        select: false
      }
    },
    {
      strict: true,
      versionKey: false
    }
  );

commercePaidOrderEventSchema.index(
  { businessId: 1, eventId: 1 },
  { unique: true, name: "commerce_event_business_event_unique" }
);
commercePaidOrderEventSchema.index(
  { businessId: 1, "order.externalOrderId": 1 },
  { unique: true, name: "commerce_event_business_order_unique" }
);
commercePaidOrderEventSchema.index(
  { businessId: 1, "order.paymentReference": 1 },
  { unique: true, name: "commerce_event_business_payment_unique" }
);
commercePaidOrderEventSchema.index(
  { businessId: 1, receivedAt: -1 },
  { name: "commerce_event_business_received" }
);

export const CommercePaidOrderEvent =
  model<ICommercePaidOrderEventDocument>(
    "CommercePaidOrderEvent",
    commercePaidOrderEventSchema
  );

export const ensureCommercePaidOrderEventIndexes = async (): Promise<void> => {
  await CommercePaidOrderEvent.collection.createIndex(
    { businessId: 1, eventId: 1 },
    { unique: true, name: "commerce_event_business_event_unique" }
  );
  await CommercePaidOrderEvent.collection.createIndex(
    { businessId: 1, "order.externalOrderId": 1 },
    { unique: true, name: "commerce_event_business_order_unique" }
  );
  await CommercePaidOrderEvent.collection.createIndex(
    { businessId: 1, "order.paymentReference": 1 },
    { unique: true, name: "commerce_event_business_payment_unique" }
  );
  await CommercePaidOrderEvent.collection.createIndex(
    { businessId: 1, receivedAt: -1 },
    { name: "commerce_event_business_received" }
  );
};
