import { getAllowedToolNamesForRole } from "../../agent-tools/tool.permissions";
import { Order } from "../../models/order.model";
import { PendingAgentAction } from "../../models/pendingAgentAction.model";
import type { IRestaurantDocument } from "../../models/Restaurant";
import type { ResolvedSender, SenderRole } from "../../types/agent.types";
import { getPendingOrderExpiryMinutes } from "../order.service";

export const staffOperationalStateLimits = {
  pendingActions: 5,
  freshPendingOrders: 5,
  recentActiveOrders: 5,
  orderSelectionCandidates: 5
} as const;

const pendingActionQueryLimit = 12;
const activeOrderStatuses = [
  "confirmed",
  "accepted",
  "preparing",
  "ready",
  "out_for_delivery"
] as const;
const imageActionTypes = new Set([
  "MENU_ITEM_IMAGE_CONTEXT",
  "IMAGE_ASSIGNMENT"
]);

interface PendingActionSource {
  _id: unknown;
  action: string;
  toolName?: unknown;
  summary?: unknown;
  confirmationMessage?: unknown;
  data?: Record<string, unknown>;
  status: string;
  selectedMenuItemId?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
}

interface OrderSource {
  _id: unknown;
  orderNumber?: unknown;
  status: string;
  customerName?: unknown;
  total?: unknown;
  createdAt?: unknown;
  customerConfirmedAt?: unknown;
}

interface QueryLike<T> {
  sort(sort: Record<string, 1 | -1>): QueryLike<T>;
  limit(limit: number): Promise<T[]>;
}

type FindRecords<T> = (
  filter: Record<string, unknown>,
  projection: Record<string, 1>
) => QueryLike<T>;

export interface StaffPendingActionView {
  actionId: string;
  type: string;
  toolName?: string;
  summary?: string;
  confirmationMessage?: string;
  status: "pending";
  requiresConfirmation: boolean;
  createdAt?: string;
  expiresAt?: string;
}

export interface StaffImageWorkflowView {
  active: true;
  type: "menu_item_image";
  stage: "awaiting_image" | "awaiting_item" | "awaiting_confirmation";
  imageUploaded: boolean;
  itemId?: string;
  itemName?: string;
  pendingActionId: string;
  createdAt?: string;
}

export interface StaffOrderView {
  id: string;
  orderNumber?: string;
  status: string;
  customerName?: string;
  total?: number;
  createdAt?: string;
}

export interface StaffOrderSelectionReference {
  pendingActionId: string;
  decision: "accept" | "reject";
  awaitingReason: boolean;
  rejectionReason?: string;
  candidates: Array<StaffOrderView & { position: number }>;
}

export interface StaffCampaignReference {
  id: string;
  campaignVersion: number;
  pendingActionId: string;
  status: "pending_approval";
}

export interface StaffOperationalState {
  pendingActions: StaffPendingActionView[];
  imageWorkflow: StaffImageWorkflowView | null;
  orders: {
    freshPending: StaffOrderView[];
    recentActive: StaffOrderView[];
  };
  recentReferences: {
    quotedOrder?: StaffOrderView;
    orderSelection?: StaffOrderSelectionReference;
    menuItem?: {
      id?: string;
      name?: string;
    };
    campaign?: StaffCampaignReference;
  };
  permissions: string[];
}

export interface StaffOperationalStateDependencies {
  findPendingActions?: FindRecords<PendingActionSource>;
  findOrders?: FindRecords<OrderSource>;
  getPermissions?: (role: SenderRole) => string[];
  now?: () => Date;
}

const pendingActionProjection = {
  _id: 1,
  action: 1,
  toolName: 1,
  summary: 1,
  confirmationMessage: 1,
  data: 1,
  status: 1,
  selectedMenuItemId: 1,
  createdAt: 1,
  expiresAt: 1
} as const;

const orderProjection = {
  _id: 1,
  orderNumber: 1,
  status: 1,
  customerName: 1,
  total: 1,
  createdAt: 1,
  customerConfirmedAt: 1
} as const;

const defaultFindPendingActions: FindRecords<PendingActionSource> = (
  filter,
  projection
) =>
  PendingAgentAction.find(filter, projection) as unknown as QueryLike<PendingActionSource>;

const defaultFindOrders: FindRecords<OrderSource> = (filter, projection) =>
  Order.find(filter, projection) as unknown as QueryLike<OrderSource>;

const safeString = (value: unknown, maxLength = 320): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, maxLength) : undefined;
};

const safeId = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 80) : undefined;
};

const safeIsoDate = (value: unknown): string | undefined => {
  if (!(value instanceof Date) && typeof value !== "string") {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const toOrderView = (order: OrderSource): StaffOrderView => ({
  id: safeId(order._id) ?? "unknown",
  orderNumber: safeString(order.orderNumber, 80),
  status: safeString(order.status, 60) ?? "unknown",
  customerName: safeString(order.customerName, 120),
  total:
    typeof order.total === "number" && Number.isFinite(order.total)
      ? order.total
      : undefined,
  createdAt: safeIsoDate(order.createdAt)
});

const getImageWorkflow = (
  pendingActions: PendingActionSource[]
): StaffImageWorkflowView | null => {
  const source = pendingActions.find((action) => {
    if (action.action === "IMAGE_ASSIGNMENT") {
      return (
        action.data?.stage === "awaiting_item" ||
        action.data?.stage === "awaiting_confirmation"
      );
    }

    return (
      action.action === "MENU_ITEM_IMAGE_CONTEXT" &&
      action.data?.stage === "awaiting_image"
    );
  });

  if (!source) {
    return null;
  }

  const stage = source.data?.stage as StaffImageWorkflowView["stage"];
  const itemId =
    safeId(source.selectedMenuItemId) ?? safeId(source.data?.itemId);
  const itemName = safeString(source.data?.itemName, 160);

  return {
    active: true,
    type: "menu_item_image",
    stage,
    imageUploaded: source.action === "IMAGE_ASSIGNMENT",
    itemId,
    itemName,
    pendingActionId: safeId(source._id) ?? "unknown",
    createdAt: safeIsoDate(source.createdAt)
  };
};

export const createEmptyStaffOperationalState = (
  role: "owner" | "manager",
  getPermissions: (role: SenderRole) => string[] = getAllowedToolNamesForRole
): StaffOperationalState => ({
  pendingActions: [],
  imageWorkflow: null,
  orders: {
    freshPending: [],
    recentActive: []
  },
  recentReferences: {},
  permissions: getPermissions(role)
});

export const buildStaffOperationalState = async (
  input: {
    restaurant: IRestaurantDocument;
    sender: ResolvedSender;
    quotedMessageId?: string;
  },
  dependencies: StaffOperationalStateDependencies = {}
): Promise<StaffOperationalState> => {
  if (input.sender.role !== "owner" && input.sender.role !== "manager") {
    throw new Error("Staff operational state is available only to staff senders.");
  }

  const restaurantId = String(input.restaurant._id);
  const now = dependencies.now?.() ?? new Date();
  const findPendingActions =
    dependencies.findPendingActions ?? defaultFindPendingActions;
  const findOrders = dependencies.findOrders ?? defaultFindOrders;
  const getPermissions =
    dependencies.getPermissions ?? getAllowedToolNamesForRole;
  const quotedMessageId =
    typeof input.quotedMessageId === "string" && input.quotedMessageId.trim()
      ? input.quotedMessageId
      : undefined;

  const pendingActions = await findPendingActions(
    {
      restaurantId,
      senderPhone: input.sender.normalizedPhone,
      senderRole: input.sender.role,
      status: "pending",
      expiresAt: { $gt: now }
    },
    pendingActionProjection
  )
    .sort({ createdAt: -1 })
    .limit(pendingActionQueryLimit);

  const selectionAction = pendingActions.find(
    (action) => action.action === "OWNER_ORDER_SELECTION"
  );
  const selectionOrderIds = Array.isArray(selectionAction?.data?.orderIds)
    ? selectionAction.data.orderIds
        .map(safeId)
        .filter((value): value is string => Boolean(value))
        .slice(0, staffOperationalStateLimits.orderSelectionCandidates)
    : [];
  const freshnessCutoff = new Date(
    now.getTime() - getPendingOrderExpiryMinutes() * 60_000
  );

  const freshPendingPromise = findOrders(
    {
      restaurantId,
      status: { $in: ["awaiting_restaurant_confirmation", "pending"] },
      $or: [
        { customerConfirmedAt: { $gte: freshnessCutoff } },
        {
          customerConfirmedAt: null,
          createdAt: { $gte: freshnessCutoff }
        }
      ]
    },
    orderProjection
  )
    .sort({ customerConfirmedAt: -1, createdAt: -1 })
    .limit(staffOperationalStateLimits.freshPendingOrders);
  const recentActivePromise = findOrders(
    {
      restaurantId,
      status: { $in: [...activeOrderStatuses] }
    },
    orderProjection
  )
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(staffOperationalStateLimits.recentActiveOrders);
  const selectionOrdersPromise = selectionOrderIds.length
    ? findOrders(
        {
          restaurantId,
          _id: { $in: selectionOrderIds }
        },
        orderProjection
      )
        .sort({ createdAt: 1 })
        .limit(staffOperationalStateLimits.orderSelectionCandidates)
    : Promise.resolve([]);
  const quotedOrderPromise = quotedMessageId
    ? findOrders(
        {
          restaurantId,
          ownerNotificationProviderMessageId: quotedMessageId
        },
        orderProjection
      )
        .sort({ createdAt: -1 })
        .limit(1)
    : Promise.resolve([]);
  const [
    freshPendingOrders,
    recentActiveOrders,
    selectionOrders,
    quotedOrders
  ] =
    await Promise.all([
      freshPendingPromise,
      recentActivePromise,
      selectionOrdersPromise,
      quotedOrderPromise
    ]);

  const imageWorkflow = getImageWorkflow(pendingActions);
  const visiblePendingActions = pendingActions
    .filter((action) => !imageActionTypes.has(action.action))
    .slice(0, staffOperationalStateLimits.pendingActions)
    .map<StaffPendingActionView>((action) => ({
      actionId: safeId(action._id) ?? "unknown",
      type: safeString(action.action, 80) ?? "unknown",
      toolName: safeString(action.toolName, 100),
      summary: safeString(action.summary),
      confirmationMessage: safeString(action.confirmationMessage),
      status: "pending",
      requiresConfirmation:
        action.action === "TOOL_CALL" ||
        [
          "ADD_MENU_ITEM",
          "UPDATE_MENU_PRICE",
          "MARK_ITEM_UNAVAILABLE",
          "MARK_ITEM_AVAILABLE"
        ].includes(action.action),
      createdAt: safeIsoDate(action.createdAt),
      expiresAt: safeIsoDate(action.expiresAt)
    }));
  const selectionOrderMap = new Map(
    selectionOrders.map((order) => [safeId(order._id), order])
  );
  const orderSelection = selectionAction
    ? {
        pendingActionId: safeId(selectionAction._id) ?? "unknown",
        decision:
          selectionAction.data?.decision === "reject"
            ? ("reject" as const)
            : ("accept" as const),
        awaitingReason: selectionAction.data?.awaitingReason === true,
        rejectionReason:
          selectionAction.data?.decision === "reject"
            ? safeString(selectionAction.data?.reason, 500)
            : undefined,
        candidates: selectionOrderIds.flatMap((orderId, index) => {
          const order = selectionOrderMap.get(orderId);
          return order
            ? [{ ...toOrderView(order), position: index + 1 }]
            : [];
        })
      }
    : undefined;
  const menuItemReference = imageWorkflow?.itemId || imageWorkflow?.itemName
    ? {
        id: imageWorkflow.itemId,
        name: imageWorkflow.itemName
      }
    : undefined;
  const campaignApprovalAction = pendingActions.find(
    (action) =>
      action.action === "TOOL_CALL" &&
      action.toolName === "approve_campaign" &&
      safeId(action.data?.campaignId) &&
      Number.isInteger(Number(action.data?.expectedCampaignVersion))
  );
  const campaignReference = campaignApprovalAction
    ? {
        id: safeId(campaignApprovalAction.data?.campaignId) as string,
        campaignVersion: Number(
          campaignApprovalAction.data?.expectedCampaignVersion
        ),
        pendingActionId: safeId(campaignApprovalAction._id) ?? "unknown",
        status: "pending_approval" as const
      }
    : undefined;
  const state: StaffOperationalState = {
    pendingActions: visiblePendingActions,
    imageWorkflow,
    orders: {
      freshPending: freshPendingOrders.map(toOrderView),
      recentActive: recentActiveOrders.map(toOrderView)
    },
    recentReferences: {
      quotedOrder: quotedOrders[0]
        ? toOrderView(quotedOrders[0])
        : undefined,
      orderSelection,
      menuItem: menuItemReference,
      campaign: campaignReference
    },
    permissions: getPermissions(input.sender.role)
  };

  console.info("[staffState] built", {
    restaurantId,
    role: input.sender.role,
    pendingActionCount: state.pendingActions.length,
    imageWorkflowStage: state.imageWorkflow?.stage ?? null,
    freshPendingOrderCount: state.orders.freshPending.length,
    hasQuotedOrder: Boolean(state.recentReferences.quotedOrder)
  });

  return state;
};
