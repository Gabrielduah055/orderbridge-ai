import type { Types } from "mongoose";
import { Order, type OrderStatus } from "../models/order.model";
import { BadRequestError } from "../utils/httpErrors";
import {
  calculatePercentageChange,
  resolvePreviousEquivalentBusinessReportPeriod,
  resolveRequestedBusinessReportPeriod,
  type BusinessReportPeriod,
  type BusinessReportPeriodType
} from "./ownerSummary.service";

export const itemPerformanceMetrics = [
  "demand_quantity",
  "demand_orders",
  "fulfilled_quantity",
  "fulfilled_revenue",
  "growth"
] as const;
export type ItemPerformanceMetric = (typeof itemPerformanceMetrics)[number];

/**
 * Orders become customer-submitted at awaiting_restaurant_confirmation. Draft and
 * pre-confirmation lifecycle states are deliberately excluded from demand.
 */
export const demandOrderStatuses: readonly OrderStatus[] = [
  "awaiting_restaurant_confirmation",
  "pending",
  "confirmed",
  "accepted",
  "expired",
  "rejected",
  "preparing",
  "ready",
  "out_for_delivery",
  "completed",
  "cancelled"
];

export interface GetItemPerformanceInput {
  restaurantId: string;
  timezone?: string;
  period: BusinessReportPeriodType;
  metric: ItemPerformanceMetric;
  startDate?: string;
  endDate?: string;
  limit?: number;
  now?: Date;
}

interface ItemPerformanceOrder {
  status: OrderStatus;
  createdAt: Date;
  items: Array<{
    menuItemId?: Types.ObjectId | string;
    name: string;
    quantity: number;
    totalPrice: number;
  }>;
}

export interface ItemPerformanceItem {
  menuItemId?: string;
  name: string;
  demandOrderCount: number;
  demandQuantity: number;
  fulfilledOrderCount: number;
  fulfilledQuantity: number;
  fulfilledRevenue: number;
  growth?: {
    metric: "demand_quantity";
    current: number;
    previous: number;
    percentageChange: number | null;
  };
}

export interface ItemPerformanceResult {
  period: {
    type: BusinessReportPeriodType;
    label: string;
    start: string;
    end: string;
    timezone: string;
  };
  comparisonPeriod?: {
    start: string;
    end: string;
  };
  metric: ItemPerformanceMetric;
  items: ItemPerformanceItem[];
}

interface AggregateItem extends ItemPerformanceItem {
  lastSeenAt: Date;
}

const roundCurrency = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const itemKey = (item: ItemPerformanceOrder["items"][number]): string => {
  const menuItemId = item.menuItemId ? String(item.menuItemId) : undefined;
  return menuItemId
    ? `id:${menuItemId}`
    : `name:${item.name.trim().replace(/\s+/g, " ").toLowerCase()}`;
};

export const buildItemPerformanceAggregates = (
  orders: ItemPerformanceOrder[]
): Map<string, AggregateItem> => {
  const aggregates = new Map<string, AggregateItem>();

  for (const order of orders) {
    const itemsInOrder = new Map<
      string,
      { menuItemId?: string; name: string; quantity: number; totalPrice: number }
    >();

    for (const item of order.items) {
      const key = itemKey(item);
      const current = itemsInOrder.get(key) ?? {
        menuItemId: item.menuItemId ? String(item.menuItemId) : undefined,
        name: item.name.trim().replace(/\s+/g, " "),
        quantity: 0,
        totalPrice: 0
      };
      current.quantity += item.quantity;
      current.totalPrice = roundCurrency(current.totalPrice + item.totalPrice);
      itemsInOrder.set(key, current);
    }

    for (const [key, item] of itemsInOrder) {
      const current = aggregates.get(key) ?? {
        menuItemId: item.menuItemId,
        name: item.name,
        demandOrderCount: 0,
        demandQuantity: 0,
        fulfilledOrderCount: 0,
        fulfilledQuantity: 0,
        fulfilledRevenue: 0,
        lastSeenAt: order.createdAt
      };

      current.demandOrderCount += 1;
      current.demandQuantity += item.quantity;

      if (order.status === "completed") {
        current.fulfilledOrderCount += 1;
        current.fulfilledQuantity += item.quantity;
        current.fulfilledRevenue = roundCurrency(
          current.fulfilledRevenue + item.totalPrice
        );
      }

      if (order.createdAt >= current.lastSeenAt) {
        current.name = item.name;
        current.lastSeenAt = order.createdAt;
      }

      aggregates.set(key, current);
    }
  }

  return aggregates;
};

const periodView = (period: BusinessReportPeriod) => ({
  type: period.type,
  label: period.label,
  start: period.periodStart.toISOString(),
  end: period.periodEnd.toISOString(),
  timezone: period.timezone
});

const sortItems = (
  items: ItemPerformanceItem[],
  metric: ItemPerformanceMetric
): ItemPerformanceItem[] =>
  items.sort((first, second) => {
    if (metric === "growth") {
      const firstGrowth = first.growth?.percentageChange;
      const secondGrowth = second.growth?.percentageChange;
      if (firstGrowth === null || firstGrowth === undefined) {
        if (secondGrowth !== null && secondGrowth !== undefined) return 1;
      } else if (secondGrowth === null || secondGrowth === undefined) {
        return -1;
      } else if (secondGrowth !== firstGrowth) {
        return secondGrowth - firstGrowth;
      }
      return (
        (second.growth?.current ?? 0) - (first.growth?.current ?? 0) ||
        first.name.localeCompare(second.name)
      );
    }

    const value = {
      demand_quantity: "demandQuantity",
      demand_orders: "demandOrderCount",
      fulfilled_quantity: "fulfilledQuantity",
      fulfilled_revenue: "fulfilledRevenue"
    }[metric] as keyof Pick<
      ItemPerformanceItem,
      | "demandQuantity"
      | "demandOrderCount"
      | "fulfilledQuantity"
      | "fulfilledRevenue"
    >;

    return (
      Number(second[value]) - Number(first[value]) ||
      first.name.localeCompare(second.name)
    );
  });

const toPublicItem = (item: AggregateItem): ItemPerformanceItem => {
  const { lastSeenAt: _lastSeenAt, ...publicItem } = item;
  return publicItem;
};

export const getItemPerformance = async (
  input: GetItemPerformanceInput,
  dependencies: {
    resolvePeriod?: typeof resolveRequestedBusinessReportPeriod;
    findOrders?: (filter: Record<string, unknown>) => Promise<ItemPerformanceOrder[]>;
  } = {}
): Promise<ItemPerformanceResult> => {
  if (input.metric === "growth" && input.period === "all_time") {
    throw new BadRequestError(
      "Growth requires a finite period such as today, this week, or a custom date range.",
      "ITEM_GROWTH_REQUIRES_FINITE_PERIOD"
    );
  }

  const resolvePeriod =
    dependencies.resolvePeriod ?? resolveRequestedBusinessReportPeriod;
  const period = await resolvePeriod({
    restaurantId: input.restaurantId,
    period: input.period,
    timezone: input.timezone,
    startDate: input.startDate,
    endDate: input.endDate,
    now: input.now
  });
  const findOrders =
    dependencies.findOrders ??
    (async (filter: Record<string, unknown>) =>
      Order.find(filter).select("status items createdAt"));
  const currentFilter = {
    restaurantId: input.restaurantId,
    status: { $in: demandOrderStatuses },
    createdAt: { $gte: period.periodStart, $lt: period.periodEnd }
  };
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 25);

  if (input.metric !== "growth") {
    const currentOrders = await findOrders(currentFilter);
    const items = Array.from(buildItemPerformanceAggregates(currentOrders).values()).map(
      toPublicItem
    );
    return {
      period: periodView(period),
      metric: input.metric,
      items: sortItems(items, input.metric).slice(0, limit)
    };
  }

  const previousPeriod = resolvePreviousEquivalentBusinessReportPeriod(period);
  const [currentOrders, previousOrders] = await Promise.all([
    findOrders(currentFilter),
    findOrders({
      restaurantId: input.restaurantId,
      status: { $in: demandOrderStatuses },
      createdAt: {
        $gte: previousPeriod.periodStart,
        $lt: previousPeriod.periodEnd
      }
    })
  ]);
  const current = buildItemPerformanceAggregates(currentOrders);
  const previous = buildItemPerformanceAggregates(previousOrders);
  const keys = new Set([...current.keys(), ...previous.keys()]);
  const items = Array.from(keys).map((key): ItemPerformanceItem => {
    const currentItem = current.get(key);
    const previousItem = previous.get(key);
    const base = currentItem ?? previousItem!;
    const publicItem = currentItem
      ? toPublicItem(currentItem)
      : {
          ...toPublicItem(base),
          demandOrderCount: 0,
          demandQuantity: 0,
          fulfilledOrderCount: 0,
          fulfilledQuantity: 0,
          fulfilledRevenue: 0
        };
    const currentDemand = currentItem?.demandQuantity ?? 0;
    const previousDemand = previousItem?.demandQuantity ?? 0;

    return {
      ...publicItem,
      growth: {
        metric: "demand_quantity",
        current: currentDemand,
        previous: previousDemand,
        percentageChange: calculatePercentageChange(
          currentDemand,
          previousDemand
        )
      }
    };
  });

  return {
    period: periodView(period),
    comparisonPeriod: {
      start: previousPeriod.periodStart.toISOString(),
      end: previousPeriod.periodEnd.toISOString()
    },
    metric: input.metric,
    items: sortItems(items, input.metric).slice(0, limit)
  };
};
