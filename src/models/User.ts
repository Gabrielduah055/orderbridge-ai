import { Schema, Types, model, type Document } from "mongoose";
import { userRoles, type UserRole } from "../types/user.types";

export interface IUser {
  firebaseUid: string;
  name: string;
  email: string;
  role: UserRole;
  restaurantId?: Types.ObjectId;
  isActive: boolean;
}

export interface IUserDocument extends IUser, Document {
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUserDocument>(
  {
    firebaseUid: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    role: {
      type: String,
      enum: userRoles,
      required: true
    },
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: function requiredRestaurantId(this: IUserDocument) {
        return this.role === "restaurant_admin";
      }
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

export const User = model<IUserDocument>("User", userSchema);
