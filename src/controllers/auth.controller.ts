import type { NextFunction, Request, Response } from "express";

export const getCurrentUser = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        success: false,
        message: "Authenticated user is required"
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Authenticated user fetched successfully",
      data: {
        id: String(user._id),
        email: user.email,
        role: user.role,
        active: user.isActive
      }
    });
  } catch (error) {
    next(error);
  }
};
