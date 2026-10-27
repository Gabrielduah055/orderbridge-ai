import type { NextFunction, Request, Response } from "express";

interface RateWindow {
  count: number;
  resetAt: number;
}

const windows = new Map<string, RateWindow>();
const windowMs = 60_000;

export const enforceWebsiteChatRateLimit = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const business = req.trustedBusiness;
  const conversationId =
    req.body && typeof req.body.conversationId === "string"
      ? req.body.conversationId
      : "invalid";

  if (!business) {
    res.status(401).json({ success: false, message: "Website integration is not authorized" });
    return;
  }

  const limit = Math.min(
    Math.max(business.websiteIntegration?.requestsPerMinute ?? 60, 1),
    600
  );
  const now = Date.now();
  const key = `${business._id}:${conversationId}`;
  const current = windows.get(key);
  const rateWindow = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;

  rateWindow.count += 1;
  windows.set(key, rateWindow);

  if (windows.size > 10_000) {
    for (const [candidateKey, candidate] of windows) {
      if (candidate.resetAt <= now) windows.delete(candidateKey);
    }
  }

  if (rateWindow.count > limit) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rateWindow.resetAt - now) / 1000))));
    res.status(429).json({ success: false, message: "Too many website chat requests" });
    return;
  }

  next();
};
