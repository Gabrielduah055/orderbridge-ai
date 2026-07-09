import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

type HttpError = Error & {
  statusCode?: number;
  code?: number;
  errors?: unknown;
};

export const errorMiddleware: ErrorRequestHandler = (error: HttpError, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: error.flatten()
    });
    return;
  }

  if (error.name === "MongoServerError" && error.code === 11000) {
    res.status(409).json({
      success: false,
      message: "Duplicate resource",
      errors: error
    });
    return;
  }

  const statusCode = error.statusCode ?? 500;

  res.status(statusCode).json({
    success: false,
    message: error.message || "Internal server error",
    ...(error.errors ? { errors: error.errors } : {})
  });
};
