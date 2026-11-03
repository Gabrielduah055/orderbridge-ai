export class NotFoundError extends Error {
  statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends Error {
  statusCode = 400;
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "BadRequestError";
    this.code = code;
  }
}

export class ConflictError extends Error {
  statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ForbiddenError extends Error {
  statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}
