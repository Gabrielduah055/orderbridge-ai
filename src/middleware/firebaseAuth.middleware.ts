import type { NextFunction, Request, Response } from "express";
import type { DecodedIdToken } from "firebase-admin/auth";
import { firebaseAdmin } from "../config/firebase";
import { User } from "../models/User";

export const firebaseAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        message: "Authorization Bearer token is required"
      });
      return;
    }

    const token = authorization.split(" ")[1];
    let decodedToken: DecodedIdToken;

    try {
      decodedToken = await firebaseAdmin.auth().verifyIdToken(token);
    } catch {
      res.status(401).json({
        success: false,
        message: "Invalid or expired Firebase token"
      });
      return;
    }

    const user = await User.findOne({ firebaseUid: decodedToken.uid });

    if (!user) {
      res.status(401).json({
        success: false,
        message: "User does not exist in OrderBridge AI"
      });
      return;
    }

    if (!user.isActive) {
      res.status(403).json({
        success: false,
        message: "User account is inactive"
      });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};
