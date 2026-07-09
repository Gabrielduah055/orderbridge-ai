import type { NextFunction, Request, Response } from "express";

export const requireSuperAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.role !== "super_admin") {
    res.status(403).json({
      success: false,
      message: "Super admin access is required"
    });
    return;
  }

  next();
};
