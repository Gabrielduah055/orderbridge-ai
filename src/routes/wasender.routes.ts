import { Router } from "express";
import { handleWasenderWebhook } from "../controllers/wasender.controller";

const router = Router();

router.post("/", handleWasenderWebhook);

export default router;
