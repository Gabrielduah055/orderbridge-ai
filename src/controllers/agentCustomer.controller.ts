import type { NextFunction, Request, Response } from "express";
import * as agentCustomerService from "../services/agentCustomer.service";

export const handleCustomerMessage = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const response = await agentCustomerService.handleCustomerMessage(req.body);

    res.status(response.success ? 200 : 400).json(response);
  } catch (error) {
    next(error);
  }
};
