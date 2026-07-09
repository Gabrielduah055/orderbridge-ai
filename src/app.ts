import cors from "cors";
import express, { type Request, type Response } from "express";
import morgan from "morgan";
import { errorMiddleware } from "./middleware/error.middleware";
import restaurantRoutes from "./routes/restaurant.routes";

export const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "OrderBridge AI backend is running"
  });
});

app.use("/api/restaurants", restaurantRoutes);

app.use(errorMiddleware);
