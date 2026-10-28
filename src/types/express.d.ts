import type { IUserDocument } from "../models/User";
import type { IBusinessDocument } from "../models/business.model";

declare global {
  namespace Express {
    interface Request {
      user?: IUserDocument;
      trustedBusiness?: IBusinessDocument;
    }
  }
}

export {};
