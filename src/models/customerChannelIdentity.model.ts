import { Schema, model, type Document, type Types } from "mongoose";

export interface ICustomerChannelIdentity {
  restaurantId: Types.ObjectId;
  provider: "wasender";
  channel: "whatsapp";
  phone?: string;
  lid?: string;
}

export interface ICustomerChannelIdentityDocument
  extends ICustomerChannelIdentity,
    Document {
  createdAt: Date;
  updatedAt: Date;
}

const customerChannelIdentitySchema =
  new Schema<ICustomerChannelIdentityDocument>(
    {
      restaurantId: {
        type: Schema.Types.ObjectId,
        ref: "Restaurant",
        required: true
      },
      provider: {
        type: String,
        enum: ["wasender"],
        required: true,
        default: "wasender"
      },
      channel: {
        type: String,
        enum: ["whatsapp"],
        required: true,
        default: "whatsapp"
      },
      phone: {
        type: String,
        trim: true
      },
      lid: {
        type: String,
        trim: true
      }
    },
    {
      timestamps: true
    }
  );

customerChannelIdentitySchema.index(
  { restaurantId: 1, provider: 1, channel: 1, lid: 1 },
  {
    unique: true,
    partialFilterExpression: { lid: { $type: "string" } }
  }
);
customerChannelIdentitySchema.index(
  { restaurantId: 1, provider: 1, channel: 1, phone: 1 },
  {
    unique: true,
    partialFilterExpression: { phone: { $type: "string" } }
  }
);

export const CustomerChannelIdentity =
  model<ICustomerChannelIdentityDocument>(
    "CustomerChannelIdentity",
    customerChannelIdentitySchema
  );
