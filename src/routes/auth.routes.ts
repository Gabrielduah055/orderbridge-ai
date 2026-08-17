import { Router } from "express";
import { getCurrentUser } from "../controllers/auth.controller";
import { firebaseAuth } from "../middleware/firebaseAuth.middleware";

const router = Router();

router.get("/me", firebaseAuth, getCurrentUser);

export default router;
