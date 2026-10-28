import type { NextFunction, Request, Response } from "express";

interface RateWindow {
  count: number;
  resetAt: number;
}

const windows = new Map<string, RateWindow>();
const windowMs = 60_000;
const maxConversationRequestsPerMinute = 30;

const consumeWindow = (
  key: string,
  now: number
): RateWindow => {
  const current = windows.get(key);
  const rateWindow = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;

  rateWindow.count += 1;
  windows.set(key, rateWindow);
  return rateWindow;
};

export const resetWebsiteChatRateLimitsForTests = (): void => {
  windows.clear();
};

export const enforceWebsiteChatRateLimit = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const business = req.trustedBusiness;
  const conversationId =
    req.body && typeof req.body.conversationId === "string"
      ? req.body.conversationId
      : undefined;

  if (!business) {
    res.status(401).json({ success: false, message: "Website integration is not authorized" });
    return;
  }

  const businessLimit = Math.min(
    Math.max(business.websiteIntegration?.requestsPerMinute ?? 60, 1),
    600
  );
  const conversationLimit = Math.min(
    businessLimit,
    maxConversationRequestsPerMinute
  );
  const now = Date.now();
  const businessWindow = consumeWindow(
    `business:${business._id}`,
    now
  );

  if (businessWindow.count > businessLimit) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil((businessWindow.resetAt - now) / 1000)))
    );
    res.setHeader("X-RateLimit-Scope", "business");
    res.status(429).json({ success: false, message: "Too many website chat requests" });
    return;
  }

  const conversationWindow = conversationId
    ? consumeWindow(
        `conversation:${business._id}:${conversationId}`,
        now
      )
    : undefined;

  if (windows.size > 10_000) {
    for (const [candidateKey, candidate] of windows) {
      if (candidate.resetAt <= now) windows.delete(candidateKey);
    }
  }

  const exceededConversation =
    conversationWindow && conversationWindow.count > conversationLimit;

  if (exceededConversation) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((conversationWindow.resetAt - now) / 1000))));
    res.setHeader("X-RateLimit-Scope", "conversation");
    res.status(429).json({ success: false, message: "Too many website chat requests" });
    return;
  }

  next();
};
