import { Router } from "express";
import { handleMcpRequest } from "../controllers/mcp.controller";

const router = Router();

router.post("/", handleMcpRequest);

export default router;
