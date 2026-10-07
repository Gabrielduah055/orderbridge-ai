import type { NextFunction, Request, Response } from "express";
import type { DecodedIdToken } from "firebase-admin/auth";
import { firebaseAdmin } from "../config/firebase";
import { User } from "../models/User";

const authenticatedUserLookupDeadlineMs = 1_500;

class AuthenticationStoreDeadlineError extends Error {}

const withAuthenticationStoreDeadline = async <T>(operation: Promise<T>): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new AuthenticationStoreDeadlineError("Authentication store deadline exceeded")),
          authenticatedUserLookupDeadlineMs
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const sendAuthenticationStoreUnavailable = (res: Response): void => {
  res.status(503).json({
    success: false,
    message: "Authenticated access could not be authorized at this time"
  });
};

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

    // Firebase proves token ownership, but active status and the authoritative
    // application role live in MongoDB. Never substitute token claims or
    // client-provided role data when that authorization store is unavailable.
    if (User.db.readyState !== 1) {
      sendAuthenticationStoreUnavailable(res);
      return;
    }

    let user;
    try {
      user = await withAuthenticationStoreDeadline(
        User.findOne({ firebaseUid: decodedToken.uid })
          .maxTimeMS(authenticatedUserLookupDeadlineMs)
          .exec()
      );
    } catch {
      sendAuthenticationStoreUnavailable(res);
      return;
    }

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
