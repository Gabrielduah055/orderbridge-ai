import { Schema, model, type Document, type Types } from "mongoose";
import {
  agentChannels,
  businessCapabilities,
  businessStatuses,
  businessTypes,
  type AgentChannel,
  type BusinessCapability,
  type BusinessStatus,
  type BusinessType
} from "../types/business.types";

export interface BusinessStaffContact {
  name?: string;
  phone?: string;
  email?: string;
  role: "owner" | "manager";
}

export interface WebsiteIntegrationConfiguration {
  enabled: boolean;
  integrationKeyHash?: string;
  allowedOrigins: string[];
  requestsPerMinute: number;
}

export interface WhatsappIntegrationConfiguration {
  enabled: boolean;
  wasenderSessionId?: string;
  wasenderApiToken?: string;
  whatsappNumber?: string;
}

export interface CommerceApiPaths {
  search: string;
  product: string;
  availability: string;
  policies: string;
}

export interface CommerceIntegrationConfiguration {
  baseUrl: string;
  apiKey?: string;
  authType: "bearer" | "header";
  apiKeyHeader?: string;
  timeoutMs: number;
  paths: CommerceApiPaths;
  canonicalProductHosts: string[];
}

export interface IBusiness {
  name: string;
  slug: string;
  type: BusinessType;
  status: BusinessStatus;
  restaurantId?: Types.ObjectId;
  ownerName?: string;
  ownerEmail?: string;
  ownerPhone?: string;
  staff: BusinessStaffContact[];
  timezone: string;
  enabledChannels: AgentChannel[];
  capabilities: BusinessCapability[];
  agentInstructions?: string;
  websiteIntegration?: WebsiteIntegrationConfiguration;
  whatsappIntegration?: WhatsappIntegrationConfiguration;
  commerceIntegration?: CommerceIntegrationConfiguration;
}

export interface IBusinessDocument extends IBusiness, Document {
  createdAt: Date;
  updatedAt: Date;
}

const localPathValidator = {
  validator: (value: string): boolean => value.startsWith("/") && !value.startsWith("//"),
  message: "Commerce API paths must be origin-relative paths"
};

const businessSchema = new Schema<IBusinessDocument>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    type: { type: String, enum: businessTypes, required: true, index: true },
    status: { type: String, enum: businessStatuses, default: "trial", index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant" },
    ownerName: { type: String, trim: true },
    ownerEmail: { type: String, trim: true, lowercase: true },
    ownerPhone: { type: String, trim: true },
    staff: {
      type: [
        new Schema(
          {
            name: { type: String, trim: true },
            phone: { type: String, trim: true },
            email: { type: String, trim: true, lowercase: true },
            role: { type: String, enum: ["owner", "manager"], required: true }
          },
          { _id: false }
        )
      ],
      default: []
    },
    timezone: {
      type: String,
      default: "Africa/Accra",
      trim: true,
      validate: {
        validator: (value: string) => {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
            return true;
          } catch {
            return false;
          }
        },
        message: "timezone must be a valid IANA timezone"
      }
    },
    enabledChannels: { type: [String], enum: agentChannels, default: [] },
    capabilities: { type: [String], enum: businessCapabilities, default: [] },
    agentInstructions: { type: String, trim: true, maxlength: 4_000 },
    websiteIntegration: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          integrationKeyHash: { type: String, trim: true, select: false },
          allowedOrigins: { type: [String], default: [] },
          requestsPerMinute: { type: Number, min: 1, max: 600, default: 60 }
        },
        { _id: false }
      )
    },
    whatsappIntegration: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          wasenderSessionId: { type: String, trim: true },
          wasenderApiToken: { type: String, trim: true, select: false },
          whatsappNumber: { type: String, trim: true }
        },
        { _id: false }
      )
    },
    commerceIntegration: {
      type: new Schema(
        {
          baseUrl: {
            type: String,
            required: true,
            trim: true,
            validate: {
              validator: (value: string): boolean => {
                try {
                  return new URL(value).protocol === "https:";
                } catch {
                  return false;
                }
              },
              message: "Commerce API baseUrl must be an HTTPS URL"
            }
          },
          apiKey: { type: String, trim: true, select: false },
          authType: { type: String, enum: ["bearer", "header"], default: "bearer" },
          apiKeyHeader: { type: String, trim: true, default: "x-api-key" },
          timeoutMs: { type: Number, min: 500, max: 15_000, default: 5_000 },
          paths: {
            type: new Schema(
              {
                search: { type: String, required: true, validate: localPathValidator },
                product: { type: String, required: true, validate: localPathValidator },
                availability: { type: String, required: true, validate: localPathValidator },
                policies: { type: String, required: true, validate: localPathValidator }
              },
              { _id: false }
            ),
            required: true
          },
          canonicalProductHosts: { type: [String], default: [] }
        },
        { _id: false }
      )
    }
  },
  {
    timestamps: true,
    strict: true,
    toJSON: {
      transform: (_document, returned) => {
        if (returned.websiteIntegration) {
          delete returned.websiteIntegration.integrationKeyHash;
        }
        if (returned.whatsappIntegration) {
          delete returned.whatsappIntegration.wasenderApiToken;
        }
        if (returned.commerceIntegration) {
          delete returned.commerceIntegration.apiKey;
        }
        return returned;
      }
    }
  }
);

businessSchema.index({ restaurantId: 1 }, { unique: true, sparse: true });
businessSchema.index(
  { "whatsappIntegration.wasenderSessionId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "whatsappIntegration.enabled": true,
      "whatsappIntegration.wasenderSessionId": { $type: "string" }
    }
  }
);
businessSchema.index(
  { "whatsappIntegration.whatsappNumber": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "whatsappIntegration.enabled": true,
      "whatsappIntegration.whatsappNumber": { $type: "string" }
    }
  }
);

businessSchema.pre("validate", function validateBusinessConfiguration(next) {
  if (this.type === "ecommerce" && !this.commerceIntegration) {
    next(new Error("E-commerce businesses require commerceIntegration configuration"));
    return;
  }

  if (this.websiteIntegration?.enabled && !this.enabledChannels.includes("website")) {
    next(new Error("Website integration requires the website channel to be enabled"));
    return;
  }

  next();
});

export const Business = model<IBusinessDocument>("Business", businessSchema);
