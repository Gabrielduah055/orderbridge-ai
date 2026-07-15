import cors from "cors";
import express, { type Request, type Response } from "express";
import morgan from "morgan";
import path from "path";
import { errorMiddleware } from "./middleware/error.middleware";
import agentCustomerRoutes from "./routes/agentCustomer.routes";
import agentOwnerRoutes from "./routes/agentOwner.routes";
import mcpRoutes from "./routes/mcp.routes";
import menuRoutes from "./routes/menu.routes";
import orderRoutes, { restaurantOrderRoutes } from "./routes/order.routes";
import restaurantRoutes from "./routes/restaurant.routes";
import wasenderRoutes from "./routes/wasender.routes";

export const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "OrderBridge AI backend is running"
  });
});

app.use("/api/restaurants/:restaurantId/orders", restaurantOrderRoutes);
app.use("/api/restaurants", restaurantRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/orders", orderRoutes);
app.use("/mcp", mcpRoutes);
app.use("/api/agent/customer", agentCustomerRoutes);
app.use("/api/agent/owner", agentOwnerRoutes);
app.use("/api/webhooks/wasender", wasenderRoutes);

app.use(errorMiddleware);
