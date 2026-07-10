import type { NextFunction, Request, Response } from "express";
import * as agentOwnerService from "../services/agentOwner.service";

export const handleOwnerMessage = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const response = await agentOwnerService.handleOwnerMessage(req.body);

    res.status(response.success ? 200 : 400).json(response);
  } catch (error) {
    next(error);
  }
};
