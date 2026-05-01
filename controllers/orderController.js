const Order = require("../models/Order");
const Customer = require("../models/Customer");
const Ingredient = require("../models/Ingredient");
const Restaurant = require("../models/Restaurant");
const mongoose = require("mongoose");
const { createOrderRecord } = require("../services/orderCreationService");
const { getOperationalMetrics } = require("../services/cloudKitchenOperationsService");
const { BUSINESS_TYPES, normalizeBusinessType } = require("../services/workspaceAccess");
const {
  CLOUD_KITCHEN_ORDER_STATUSES,
  ORDER_STATUSES,
  buildOrderStatusFilter,
  normalizeOrderStatus,
  canTransitionOrderStatus
} = require("../utils/accessControl");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");
const { assertCloudKitchenWorkspace } = require("../utils/cloudKitchenWorkspace");

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizePhone = (value = "") => String(value || "").replace(/[^\d+]/g, "").trim();

const getStartOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const getEndOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

const COMPLETED_STATUSES = ["DELIVERED", "COMPLETED", "DONE", "DISPATCHED"];
const ACTIVE_STATUSES = ["NEW", "PREPARING", "READY"];
const DEFAULT_PREP_TARGET_MINUTES = 15;
const MAX_ORDER_ROWS = 200;

const toUpper = (value = "") => String(value || "").trim().toUpperCase();

const normalizeFilterValue = (value = "", fallback = "ALL") => {
  const normalized = toUpper(value);
  return normalized || fallback;
};

const normalizeRangeKey = (value = "today") => {
  const normalized = String(value || "today").trim().toLowerCase();
  if (["today", "day", "1d", "1"].includes(normalized)) {
    return "today";
  }
  if (["week", "7d", "7"].includes(normalized)) {
    return "week";
  }
  if (["month", "30d", "30"].includes(normalized)) {
    return "month";
  }
  if (["custom"].includes(normalized)) {
    return "custom";
  }
  return "today";
};

const resolveAnalyticsRange = ({ range, from, to, now = new Date() } = {}) => {
  const key = normalizeRangeKey(range);
  const endDate = getEndOfDay(now);

  if (key === "custom") {
    const startDate = getStartOfDay(from);
    const customEndDate = getEndOfDay(to);
    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(customEndDate.getTime()) ||
      startDate > customEndDate
    ) {
      const error = new Error("Invalid custom date range");
      error.status = 400;
      throw error;
    }

    return {
      key: "custom",
      label: "Custom",
      startDate,
      endDate: customEndDate
    };
  }

  const daySpan = key === "week" ? 7 : key === "month" ? 30 : 1;
  const startDate = getStartOfDay(endDate);
  startDate.setDate(startDate.getDate() - daySpan + 1);

  return {
    key,
    label: key === "today" ? "Today" : key === "week" ? "This Week" : "This Month",
    startDate,
    endDate
  };
};

const appendAndClause = (targetFilter, clause) => {
  if (!clause) {
    return targetFilter;
  }

  if (!targetFilter.$and) {
    targetFilter.$and = [];
  }
  targetFilter.$and.push(clause);
  return targetFilter;
};

const buildChannelClause = (channel) => {
  const normalized = normalizeFilterValue(channel);
  if (normalized === "ALL") {
    return null;
  }

  if (normalized === "WALK_IN") {
    return {
      $or: [{ orderChannel: "WALK_IN" }, { serviceType: "DINE_IN" }]
    };
  }

  if (["SWIGGY", "ZOMATO"].includes(normalized)) {
    return {
      $or: [
        { orderChannel: normalized },
        { paymentMode: normalized },
        { platform: normalized }
      ]
    };
  }

  if (normalized === "DIRECT") {
    return {
      $or: [{ orderChannel: "DIRECT" }, { orderChannel: { $exists: false } }]
    };
  }

  return { orderChannel: normalized };
};

const buildOrderTypeClause = (orderType) => {
  const normalized = normalizeFilterValue(orderType);
  if (normalized === "ALL") {
    return null;
  }

  if (normalized === "DINE_IN") {
    return { serviceType: "DINE_IN" };
  }

  if (["DELIVERY", "TAKEAWAY"].includes(normalized)) {
    return {
      $or: [{ orderType: normalized }, { serviceType: normalized }]
    };
  }

  return null;
};

const deriveChannelLabel = (order = {}) => {
  const explicit = toUpper(order.orderChannel);
  if (explicit && explicit !== "DIRECT") {
    return explicit;
  }

  const paymentMode = toUpper(order.paymentMode);
  if (paymentMode === "SWIGGY" || paymentMode === "ZOMATO") {
    return paymentMode;
  }

  const serviceType = toUpper(order.serviceType);
  if (serviceType === "DINE_IN") {
    return "WALK_IN";
  }

  return explicit || "DIRECT";
};

const formatElapsedLabel = (minutes) => {
  const safeMinutes = Math.max(0, Math.round(toNumber(minutes)));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
};

const resolveOrderIdentifier = (order = {}) =>
  String(order.invoiceNumber || order._id || "ORDER")
    .trim()
    .slice(-10)
    .toUpperCase();

const mapPipelineCounts = (rows = []) => {
  const countsByStatus = rows.reduce((acc, row) => {
    const key = toUpper(row?._id);
    if (!key) {
      return acc;
    }
    acc[key] = toNumber(row?.count);
    return acc;
  }, {});

  const count = (key) => toNumber(countsByStatus[key]);
  const preparing = count("PREPARING") + count("ACCEPTED");
  const ready = count("READY");
  const dispatched = count("DISPATCHED") + count("OUT_FOR_DELIVERY");
  const completed = count("DELIVERED") + count("COMPLETED") + count("DONE");

  return {
    received: count("NEW") + count("NEW_ORDER") + count("PENDING"),
    confirmed: preparing + ready + dispatched + completed,
    preparing,
    ready,
    dispatched,
    completed,
    cancelled: count("CANCELLED")
  };
};

const roundMetric = (value, digits = 2) => Number(toNumber(value).toFixed(digits));

const buildSalesTrendSeries = ({ groups = [], range }) => {
  const byDate = (Array.isArray(groups) ? groups : []).reduce((acc, entry) => {
    acc[String(entry?._id || "")] = {
      orders: toNumber(entry?.orders),
      revenue: toNumber(entry?.revenue)
    };
    return acc;
  }, {});

  const points = [];
  const cursor = getStartOfDay(range.startDate);
  const endDate = getEndOfDay(range.endDate);

  while (cursor <= endDate) {
    const key = cursor.toISOString().slice(0, 10);
    const snapshot = byDate[key] || { orders: 0, revenue: 0 };
    points.push({
      date: key,
      label: cursor.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short"
      }),
      orders: snapshot.orders,
      revenue: roundMetric(snapshot.revenue)
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return points;
};

const pickTop = (rows = [], limit = 6) =>
  rows.slice(0, limit).map((item) => ({
    name: item.name,
    quantity: roundMetric(item.quantity, 1),
    revenue: roundMetric(item.revenue)
  }));

const buildOrderInsightsPayload = ({
  kpis,
  pipelineCounts,
  kitchenStats,
  topItems,
  lowItems,
  lowStockItems
}) => {
  const highDemandItems = pickTop(topItems, 3).map(
    (item) => `${item.name} is surging with ${item.quantity} units sold`
  );

  const delayAlerts = [];
  if (kitchenStats.delayed > 0) {
    delayAlerts.push(
      `${kitchenStats.delayed} active order${kitchenStats.delayed === 1 ? "" : "s"} are delayed`
    );
  }
  if (pipelineCounts.ready > 0) {
    delayAlerts.push(`${pipelineCounts.ready} order${pipelineCounts.ready === 1 ? "" : "s"} waiting in Ready`);
  }
  if (!delayAlerts.length) {
    delayAlerts.push("No critical kitchen delays in the selected range");
  }

  const revenueOpportunities = [];
  if (kpis.avgOrderValue > 0 && pickTop(lowItems, 1)[0]) {
    revenueOpportunities.push(
      `Bundle ${pickTop(lowItems, 1)[0].name} to lift average order value above ₹${Math.round(
        kpis.avgOrderValue
      )}`
    );
  }
  if (kpis.cancellationRate > 3) {
    revenueOpportunities.push(
      `Cancellation rate is ${kpis.cancellationRate.toFixed(
        1
      )}% - improve confirmation speed to recover revenue`
    );
  }
  if (!revenueOpportunities.length) {
    revenueOpportunities.push("Revenue trend is healthy - maintain current offer mix");
  }

  const inventoryAlerts = (lowStockItems || []).slice(0, 3).map((item) => {
    const quantity = roundMetric(item.quantity, 1);
    return `${item.name} is low (${quantity} ${item.unit || "units"} left)`;
  });
  if (!inventoryAlerts.length) {
    inventoryAlerts.push("No low inventory alerts");
  }

  const smartSuggestions = [];
  if (kpis.onTimeDelivery < 85) {
    smartSuggestions.push("Prioritize preparing queue to improve on-time delivery");
  }
  if (pipelineCounts.received > pipelineCounts.confirmed) {
    smartSuggestions.push("Add an auto-confirm workflow to reduce received backlog");
  }
  if (!smartSuggestions.length) {
    smartSuggestions.push("Keep promoting high demand items during peak windows");
  }

  return {
    generatedAt: new Date().toISOString(),
    highDemandItems: highDemandItems.length ? highDemandItems : ["No demand spikes detected"],
    delayAlerts,
    revenueOpportunities,
    inventoryAlerts,
    smartSuggestions
  };
};

const buildPaymentModeSummary = (orders) => {
  return orders.reduce((acc, order) => {
    const mode = String(order.paymentMode || "OTHER").toUpperCase();
    if (!acc[mode]) {
      acc[mode] = { orders: 0, revenue: 0 };
    }

    acc[mode].orders += 1;
    acc[mode].revenue += toNumber(order.grandTotal || order.totalAmount);
    return acc;
  }, {});
};

const sortTimelineEntries = (entries = []) => {
  return [...entries].sort(
    (left, right) =>
      new Date(left?.changedAt || 0).getTime() - new Date(right?.changedAt || 0).getTime()
  );
};

const serializeOrder = (order) => {
  const plainOrder =
    order && typeof order.toObject === "function" ? order.toObject() : { ...(order || {}) };
  const normalizedStatus = normalizeOrderStatus(plainOrder.status);
  const timeline = Array.isArray(plainOrder.statusTimeline) ? plainOrder.statusTimeline : [];

  return {
    ...plainOrder,
    status: normalizedStatus,
    statusTimeline: sortTimelineEntries(timeline).map((entry) => ({
      ...entry,
      status: normalizeOrderStatus(entry?.status, normalizedStatus)
    }))
  };
};

const appendStatusTimeline = (order, nextStatus, changedBy = null, note = "") => {
  const normalizedStatus = normalizeOrderStatus(nextStatus);
  const timeline = Array.isArray(order.statusTimeline) ? [...order.statusTimeline] : [];
  const lastEntry = timeline[timeline.length - 1];

  if (normalizeOrderStatus(lastEntry?.status, "") === normalizedStatus) {
    return;
  }

  timeline.push({
    status: normalizedStatus,
    changedAt: new Date(),
    changedBy: changedBy || null,
    note: String(note || "").trim()
  });
  order.statusTimeline = timeline;
};

const emitTenantOrderEvent = (req, eventName, orderPayload) => {
  const ordersIo = req.app.get("ordersIo");
  const restaurantId = getTenantRestaurantId(req);
  if (!ordersIo || !restaurantId) {
    return;
  }

  ordersIo.to(`tenant:${restaurantId}`).emit(eventName, orderPayload);
};

const emitTenantInventoryEvent = (req, payload = {}) => {
  const ordersIo = req.app.get("ordersIo");
  const restaurantId = getTenantRestaurantId(req);
  if (!ordersIo || !restaurantId) {
    return;
  }

  ordersIo.to(`tenant:${restaurantId}`).emit("inventory:update", {
    ...payload,
    restaurantId: String(restaurantId),
    updatedAt: new Date().toISOString()
  });
};

const getWorkspaceBusinessType = async (req, orderDoc = null) => {
  const explicitBusinessType = normalizeBusinessType(orderDoc?.businessType || req.body?.businessType);
  if (explicitBusinessType) {
    return explicitBusinessType;
  }

  const restaurantId = getTenantRestaurantId(req);
  if (!restaurantId) {
    return "";
  }

  const restaurant = await Restaurant.findById(restaurantId).select("businessType").lean();
  return normalizeBusinessType(restaurant?.businessType);
};

const getOrderStatusFlowForRequest = async (req, orderDoc = null) => {
  const businessType = await getWorkspaceBusinessType(req, orderDoc);
  return businessType === BUSINESS_TYPES.CLOUD_KITCHEN
    ? CLOUD_KITCHEN_ORDER_STATUSES
    : ORDER_STATUSES;
};

const emitTenantMetricsEvent = async (req, orderDoc = null) => {
  const ordersIo = req.app.get("ordersIo");
  const restaurantId = getTenantRestaurantId(req);
  if (!ordersIo || !restaurantId) {
    return;
  }

  const businessType = await getWorkspaceBusinessType(req, orderDoc);
  if (businessType !== BUSINESS_TYPES.CLOUD_KITCHEN) {
    return;
  }

  const metrics = await getOperationalMetrics({ restaurantId });
  ordersIo.to(`tenant:${restaurantId}`).emit("metrics:update", metrics);
};

const syncCustomerOrderStatus = async (req, orderDoc, nextStatus) => {
  const orderId = String(orderDoc?._id || "");
  if (!orderId) {
    return;
  }

  let customer = null;
  if (orderDoc?.customerId) {
    customer = await Customer.findOne(withTenantDocFilter(req, orderDoc.customerId));
  }

  if (!customer && orderDoc?.customerPhone) {
    customer = await Customer.findOne(
      withTenantFilter(req, { phone: normalizePhone(orderDoc.customerPhone) })
    );
  }

  if (!customer || !Array.isArray(customer.orderHistory) || !customer.orderHistory.length) {
    return;
  }

  let hasChanges = false;
  customer.orderHistory.forEach((entry) => {
    if (String(entry?.orderId || "") !== orderId) {
      return;
    }

    entry.orderStatus = nextStatus;
    hasChanges = true;
  });

  if (hasChanges) {
    await customer.save();
  }
};

const removeCustomerOrderHistoryEntry = async (req, orderDoc) => {
  const orderId = String(orderDoc?._id || "");
  if (!orderId) {
    return;
  }

  let customer = null;
  if (orderDoc?.customerId) {
    customer = await Customer.findOne(withTenantDocFilter(req, orderDoc.customerId));
  }

  if (!customer && orderDoc?.customerPhone) {
    customer = await Customer.findOne(
      withTenantFilter(req, { phone: normalizePhone(orderDoc.customerPhone) })
    );
  }

  if (!customer || !Array.isArray(customer.orderHistory) || !customer.orderHistory.length) {
    return;
  }

  const nextHistory = customer.orderHistory.filter(
    (entry) => String(entry?.orderId || "") !== orderId
  );

  if (nextHistory.length !== customer.orderHistory.length) {
    customer.orderHistory = nextHistory;
    await customer.save();
  }
};

const createOrder = async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const { order } = await createOrderRecord({
      restaurantId,
      payload: req.body,
      createdBy: req.user?.userId || null
    });

    const payload = serializeOrder(order);
    emitTenantOrderEvent(req, "order:new", payload);
    emitTenantInventoryEvent(req, {
      scope: "raw",
      action: "order-deduction",
      orderId: payload._id
    });
    await emitTenantMetricsEvent(req, order);

    return res.status(201).json(payload);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }

    return res.serverError(error);
  }
};

const listOrders = async (req, res) => {
  try {
    const filter = withTenantFilter(req);
    const activeOnly = String(req.query?.active || "").trim().toLowerCase() === "true";
    const status = String(req.query?.status || "").trim();
    const businessType = normalizeBusinessType(req.query?.businessType || "");

    if (activeOnly) {
      filter.status = { $nin: ["DELIVERED", "DISPATCHED", "COMPLETED", "DONE", "CANCELLED"] };
    } else if (status) {
      const statusFilter = buildOrderStatusFilter(status);
      if (statusFilter) {
        filter.status = statusFilter;
      }
    }

    if (businessType) {
      filter.businessType = businessType;

      if (businessType === BUSINESS_TYPES.CLOUD_KITCHEN) {
        filter.orderType = { $in: ["DELIVERY", "TAKEAWAY"] };
      }
    }

    const orders = await Order.find(filter).sort({ createdAt: -1 });
    return res.json(orders.map(serializeOrder));
  } catch (error) {
    return res.serverError(error);
  }
};

const listActiveOrders = async (req, res) => {
  try {
    await assertCloudKitchenWorkspace(req);

    const activeOrders = await Order.find(
      withTenantFilter(req, {
        status: { $nin: ["DELIVERED", "DISPATCHED", "COMPLETED", "CANCELLED"] }
      })
    )
      .sort({ createdAt: -1 })
      .limit(20);

    const now = Date.now();
    return res.json(
      activeOrders.map((order) => {
        const payload = serializeOrder(order);
        return {
          ...payload,
          prepTimeMinutes: Math.max(
            0,
            Math.round((now - new Date(order.createdAt || now).getTime()) / 60000)
          )
        };
      })
    );
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }

    return res.serverError(error);
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const nextStatus = normalizeOrderStatus(req.body?.status, "");
    if (!nextStatus) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const order = await Order.findOne(withTenantDocFilter(req, req.params.id));
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const statusFlow = await getOrderStatusFlowForRequest(req, order);
    if (!canTransitionOrderStatus(order.status, nextStatus, statusFlow)) {
      return res.status(400).json({
        message: "Invalid order transition. Move the order forward through the workflow."
      });
    }

    const finalStatus = statusFlow[statusFlow.length - 1];
    order.status = nextStatus;
    appendStatusTimeline(order, nextStatus, req.user?.userId || null);

    if (nextStatus === "READY" && !order.readyAt) {
      order.readyAt = new Date();
    }

    if (nextStatus === finalStatus && !order.completedAt) {
      order.completedAt = new Date();
    }

    if (nextStatus === "DISPATCHED") {
      order.dispatchedAt = order.dispatchedAt || new Date();
      if (!order.delivery) {
        order.delivery = {};
      }
      order.delivery.deliveredAt = order.delivery.deliveredAt || order.dispatchedAt;
    }

    await order.save();
    await syncCustomerOrderStatus(req, order, nextStatus);

    const payload = serializeOrder(order);
    emitTenantOrderEvent(req, "order:update", payload);
    await emitTenantMetricsEvent(req, order);

    return res.json(payload);
  } catch (error) {
    return res.serverError(error);
  }
};

const cancelOrder = async (req, res) => {
  try {
    const order = await Order.findOne(withTenantDocFilter(req, req.params.id));
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const currentStatus = normalizeOrderStatus(order.status, "");
    if (["DELIVERED", "DISPATCHED", "CANCELLED"].includes(currentStatus)) {
      return res.status(400).json({ message: "Order cannot be cancelled" });
    }

    order.status = "CANCELLED";
    order.cancelledAt = new Date();
    appendStatusTimeline(order, "CANCELLED", req.user?.userId || null, "Order cancelled");
    await order.save();
    await syncCustomerOrderStatus(req, order, "CANCELLED");

    const payload = serializeOrder(order);
    emitTenantOrderEvent(req, "order:update", payload);
    await emitTenantMetricsEvent(req, order);

    return res.json(payload);
  } catch (error) {
    return res.serverError(error);
  }
};

const deleteOrder = async (req, res) => {
  try {
    const order = await Order.findOne(withTenantDocFilter(req, req.params.id));
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (normalizeOrderStatus(order.status, "") !== "CANCELLED") {
      return res.status(400).json({
        message: "Only cancelled orders can be deleted permanently"
      });
    }

    await removeCustomerOrderHistoryEntry(req, order);
    await Order.deleteOne({ _id: order._id, restaurantId: order.restaurantId });
    await emitTenantMetricsEvent(req, order);

    return res.json({ message: "Order deleted successfully" });
  } catch (error) {
    return res.serverError(error);
  }
};

const buildOrderAnalyticsSummaryPayload = async (req) => {
  const range = resolveAnalyticsRange({
    range: req.query?.range,
    from: req.query?.from,
    to: req.query?.to
  });
  const channelFilter = normalizeFilterValue(req.query?.channel, "ALL");
  const orderTypeFilter = normalizeFilterValue(req.query?.orderType, "ALL");

  const orderFilter = withTenantFilter(req, {
    createdAt: {
      $gte: range.startDate,
      $lte: range.endDate
    }
  });
  const restaurantId = getTenantRestaurantId(req);
  if (mongoose.Types.ObjectId.isValid(restaurantId)) {
    orderFilter.restaurantId = new mongoose.Types.ObjectId(restaurantId);
  }
  appendAndClause(orderFilter, buildChannelClause(channelFilter));
  appendAndClause(orderFilter, buildOrderTypeClause(orderTypeFilter));

  const now = new Date();
  const [facet = {}] = await Order.aggregate([
    { $match: orderFilter },
    {
      $addFields: {
        safeAmount: {
          $let: {
            vars: {
              grandTotal: { $ifNull: ["$grandTotal", 0] },
              totalAmount: { $ifNull: ["$totalAmount", 0] }
            },
            in: {
              $cond: [{ $gt: ["$$grandTotal", 0] }, "$$grandTotal", "$$totalAmount"]
            }
          }
        },
        normalizedStatus: { $toUpper: { $ifNull: ["$status", "NEW"] } },
        expectedPrepTarget: {
          $max: [1, { $ifNull: ["$expectedPrepTimeMinutes", DEFAULT_PREP_TARGET_MINUTES] }]
        },
        prepEndAt: {
          $ifNull: [
            "$readyAt",
            {
              $ifNull: [
                "$completedAt",
                {
                  $ifNull: ["$dispatchedAt", "$delivery.deliveredAt"]
                }
              ]
            }
          ]
        },
        itemCount: {
          $reduce: {
            input: { $ifNull: ["$items", []] },
            initialValue: 0,
            in: {
              $add: [
                "$$value",
                { $ifNull: ["$$this.quantity", { $ifNull: ["$$this.qty", 0] }] }
              ]
            }
          }
        }
      }
    },
    {
      $addFields: {
        isCompleted: { $in: ["$normalizedStatus", COMPLETED_STATUSES] },
        isCancelled: { $eq: ["$normalizedStatus", "CANCELLED"] },
        isActive: { $in: ["$normalizedStatus", ACTIVE_STATUSES] },
        elapsedMinutes: {
          $max: [0, { $divide: [{ $subtract: [now, "$createdAt"] }, 60000] }]
        },
        prepDurationMinutes: {
          $cond: [
            {
              $and: [
                { $ne: ["$prepEndAt", null] },
                { $gt: ["$prepEndAt", "$createdAt"] }
              ]
            },
            { $divide: [{ $subtract: ["$prepEndAt", "$createdAt"] }, 60000] },
            null
          ]
        },
        dateKey: {
          $dateToString: {
            date: "$createdAt",
            format: "%Y-%m-%d"
          }
        }
      }
    },
    {
      $facet: {
        kpis: [
          {
            $group: {
              _id: null,
              totalOrders: { $sum: 1 },
              totalRevenue: {
                $sum: {
                  $cond: ["$isCompleted", "$safeAmount", 0]
                }
              },
              completedOrders: { $sum: { $cond: ["$isCompleted", 1, 0] } },
              cancelledOrders: { $sum: { $cond: ["$isCancelled", 1, 0] } },
              avgPrepTime: {
                $avg: {
                  $cond: [
                    {
                      $and: ["$isCompleted", { $ne: ["$prepDurationMinutes", null] }]
                    },
                    "$prepDurationMinutes",
                    null
                  ]
                }
              },
              onTimeOrders: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        "$isCompleted",
                        { $ne: ["$prepDurationMinutes", null] },
                        { $lte: ["$prepDurationMinutes", "$expectedPrepTarget"] }
                      ]
                    },
                    1,
                    0
                  ]
                }
              },
              onTimeSamples: {
                $sum: {
                  $cond: [
                    {
                      $and: ["$isCompleted", { $ne: ["$prepDurationMinutes", null] }]
                    },
                    1,
                    0
                  ]
                }
              }
            }
          },
          {
            $project: {
              _id: 0,
              totalOrders: 1,
              totalRevenue: 1,
              avgOrderValue: {
                $cond: [
                  { $gt: ["$completedOrders", 0] },
                  { $divide: ["$totalRevenue", "$completedOrders"] },
                  0
                ]
              },
              avgPrepTime: { $ifNull: ["$avgPrepTime", 0] },
              cancellationRate: {
                $cond: [
                  { $gt: ["$totalOrders", 0] },
                  {
                    $multiply: [{ $divide: ["$cancelledOrders", "$totalOrders"] }, 100]
                  },
                  0
                ]
              },
              onTimeDelivery: {
                $cond: [
                  { $gt: ["$onTimeSamples", 0] },
                  { $multiply: [{ $divide: ["$onTimeOrders", "$onTimeSamples"] }, 100] },
                  100
                ]
              }
            }
          }
        ],
        pipeline: [{ $group: { _id: "$normalizedStatus", count: { $sum: 1 } } }],
        salesTrend: [
          {
            $group: {
              _id: "$dateKey",
              orders: { $sum: 1 },
              revenue: {
                $sum: { $cond: ["$isCompleted", "$safeAmount", 0] }
              }
            }
          },
          { $sort: { _id: 1 } }
        ],
        topItems: [
          { $match: { isCompleted: true } },
          { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
          {
            $group: {
              _id: { $ifNull: ["$items.displayName", "$items.name"] },
              quantity: { $sum: { $ifNull: ["$items.quantity", { $ifNull: ["$items.qty", 0] }] } },
              revenue: {
                $sum: {
                  $multiply: [
                    { $ifNull: ["$items.quantity", { $ifNull: ["$items.qty", 0] }] },
                    { $ifNull: ["$items.price", 0] }
                  ]
                }
              }
            }
          },
          { $sort: { quantity: -1, revenue: -1, _id: 1 } },
          { $limit: 8 },
          { $project: { _id: 0, name: "$_id", quantity: 1, revenue: 1 } }
        ],
        lowItems: [
          { $match: { isCompleted: true } },
          { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
          {
            $group: {
              _id: { $ifNull: ["$items.displayName", "$items.name"] },
              quantity: { $sum: { $ifNull: ["$items.quantity", { $ifNull: ["$items.qty", 0] }] } },
              revenue: {
                $sum: {
                  $multiply: [
                    { $ifNull: ["$items.quantity", { $ifNull: ["$items.qty", 0] }] },
                    { $ifNull: ["$items.price", 0] }
                  ]
                }
              }
            }
          },
          { $match: { quantity: { $gt: 0 } } },
          { $sort: { quantity: 1, revenue: 1, _id: 1 } },
          { $limit: 8 },
          { $project: { _id: 0, name: "$_id", quantity: 1, revenue: 1 } }
        ],
        kitchenCounts: [
          { $match: { isActive: true } },
          {
            $group: {
              _id: null,
              new: {
                $sum: { $cond: [{ $eq: ["$normalizedStatus", "NEW"] }, 1, 0] }
              },
              preparing: {
                $sum: { $cond: [{ $eq: ["$normalizedStatus", "PREPARING"] }, 1, 0] }
              },
              ready: {
                $sum: { $cond: [{ $eq: ["$normalizedStatus", "READY"] }, 1, 0] }
              },
              delayed: {
                $sum: {
                  $cond: [{ $gt: ["$elapsedMinutes", "$expectedPrepTarget"] }, 1, 0]
                }
              }
            }
          }
        ],
        liveOrders: [
          { $match: { isActive: true } },
          { $sort: { createdAt: -1 } },
          { $limit: 12 },
          {
            $project: {
              _id: 1,
              invoiceNumber: 1,
              createdAt: 1,
              normalizedStatus: 1,
              elapsedMinutes: 1,
              itemCount: 1,
              expectedPrepTarget: 1,
              items: {
                $map: {
                  input: {
                    $slice: [{ $ifNull: ["$items", []] }, 4]
                  },
                  as: "item",
                  in: {
                    name: { $ifNull: ["$$item.displayName", "$$item.name"] },
                    quantity: { $ifNull: ["$$item.quantity", { $ifNull: ["$$item.qty", 0] }] }
                  }
                }
              }
            }
          }
        ],
        orderList: [
          { $sort: { createdAt: -1 } },
          { $limit: MAX_ORDER_ROWS },
          {
            $project: {
              _id: 1,
              invoiceNumber: 1,
              createdAt: 1,
              customerName: 1,
              customer: 1,
              paymentMode: 1,
              orderChannel: 1,
              orderType: 1,
              serviceType: 1,
              normalizedStatus: 1,
              elapsedMinutes: 1,
              expectedPrepTarget: 1,
              amount: "$safeAmount",
              itemCount: 1,
              items: {
                $map: {
                  input: {
                    $slice: [{ $ifNull: ["$items", []] }, 6]
                  },
                  as: "item",
                  in: {
                    name: { $ifNull: ["$$item.displayName", "$$item.name"] },
                    quantity: { $ifNull: ["$$item.quantity", { $ifNull: ["$$item.qty", 0] }] }
                  }
                }
              },
              statusTimeline: 1
            }
          }
        ]
      }
    }
  ]).allowDiskUse(true);

  const lowStockItems = await Ingredient.find(
    withTenantFilter(req, { lowStockAlert: true })
  )
    .sort({ quantity: 1 })
    .limit(6)
    .select("name quantity unit minStock")
    .lean();

  const kpisRaw = facet.kpis?.[0] || {};
  const pipelineCounts = mapPipelineCounts(facet.pipeline || []);
  const kitchenCount = facet.kitchenCounts?.[0] || {};

  const topItems = (facet.topItems || [])
    .map((item) => ({
      name: String(item?.name || "").trim(),
      quantity: roundMetric(item?.quantity, 1),
      revenue: roundMetric(item?.revenue)
    }))
    .filter((item) => item.name);

  const lowItems = (facet.lowItems || [])
    .map((item) => ({
      name: String(item?.name || "").trim(),
      quantity: roundMetric(item?.quantity, 1),
      revenue: roundMetric(item?.revenue)
    }))
    .filter((item) => item.name);

  const kitchenStats = {
    new: toNumber(kitchenCount.new),
    preparing: toNumber(kitchenCount.preparing),
    ready: toNumber(kitchenCount.ready),
    delayed: toNumber(kitchenCount.delayed),
    liveOrders: (facet.liveOrders || []).map((order) => {
      const items = Array.isArray(order.items) ? order.items : [];
      return {
        id: String(order._id || ""),
        orderId: resolveOrderIdentifier(order),
        items,
        itemsLabel: items
          .map((item) => `${item.name} x${toNumber(item.quantity)}`)
          .join(", "),
        timeElapsed: formatElapsedLabel(order.elapsedMinutes),
        elapsedMinutes: roundMetric(order.elapsedMinutes, 1),
        expectedPrepTimeMinutes: roundMetric(order.expectedPrepTarget, 1),
        status: normalizeOrderStatus(order.normalizedStatus, "NEW")
      };
    })
  };

  const orderList = (facet.orderList || []).map((order) => {
    const items = Array.isArray(order.items) ? order.items : [];
    const itemLabels = items.map((item) => `${item.name} x${toNumber(item.quantity)}`);

    return {
      id: String(order._id || ""),
      orderId: resolveOrderIdentifier(order),
      dateTime: order.createdAt,
      customer: String(order.customerName || order.customer?.name || "Guest"),
      channel: deriveChannelLabel(order),
      orderType: toUpper(order.orderType || order.serviceType || "DELIVERY"),
      items,
      itemsLabel: itemLabels.slice(0, 2).join(", "),
      itemCount: roundMetric(order.itemCount, 1),
      amount: roundMetric(order.amount),
      status: normalizeOrderStatus(order.normalizedStatus, "NEW"),
      time: formatElapsedLabel(order.elapsedMinutes),
      elapsedMinutes: roundMetric(order.elapsedMinutes, 1),
      expectedPrepTimeMinutes: roundMetric(order.expectedPrepTarget, 1),
      statusTimeline: Array.isArray(order.statusTimeline)
        ? order.statusTimeline.map((entry) => ({
            status: normalizeOrderStatus(entry?.status, "NEW"),
            changedAt: entry?.changedAt || null,
            note: String(entry?.note || "")
          }))
        : []
    };
  });

  const kpis = {
    totalOrders: Math.round(toNumber(kpisRaw.totalOrders)),
    totalRevenue: roundMetric(kpisRaw.totalRevenue),
    avgOrderValue: roundMetric(kpisRaw.avgOrderValue),
    avgPrepTime: roundMetric(kpisRaw.avgPrepTime, 1),
    cancellationRate: roundMetric(kpisRaw.cancellationRate, 1),
    onTimeDelivery: roundMetric(kpisRaw.onTimeDelivery, 1)
  };

  const aiInsights = buildOrderInsightsPayload({
    kpis,
    pipelineCounts,
    kitchenStats,
    topItems,
    lowItems,
    lowStockItems
  });

  return {
    range: {
      key: range.key,
      label: range.label,
      from: range.startDate.toISOString(),
      to: range.endDate.toISOString()
    },
    filters: {
      channel: channelFilter,
      orderType: orderTypeFilter
    },
    kpis,
    pipelineCounts,
    kitchenStats,
    salesTrend: buildSalesTrendSeries({
      groups: facet.salesTrend || [],
      range
    }),
    topItems,
    lowItems,
    orderList,
    aiInsights
  };
};

const getOrderInsights = async (req, res) => {
  try {
    const summary = await buildOrderAnalyticsSummaryPayload(req);
    return res.json(summary.aiInsights);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }

    return res.serverError(error);
  }
};

const getOrderAnalyticsSummary = async (req, res) => {
  try {
    const summary = await buildOrderAnalyticsSummaryPayload(req);
    return res.json(summary);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }

    return res.serverError(error);
  }
};

const getDailyReport = async (req, res) => {
  try {
    const start = getStartOfDay(new Date());
    const end = getEndOfDay(new Date());

    const orders = await Order.find(
      withTenantFilter(req, {
        createdAt: { $gte: start, $lte: end }
      })
    ).sort({ createdAt: -1 });

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce(
      (sum, order) => sum + toNumber(order.grandTotal || order.totalAmount),
      0
    );
    const totalProfit = orders.reduce((sum, order) => sum + toNumber(order.netProfit), 0);

    return res.json({
      from: start,
      to: end,
      totalOrders,
      totalRevenue,
      totalProfit,
      byPaymentMode: buildPaymentModeSummary(orders)
    });
  } catch (error) {
    return res.serverError(error);
  }
};

const getMonthlyReport = async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = getEndOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));

    const orders = await Order.find(
      withTenantFilter(req, {
        createdAt: { $gte: start, $lte: end }
      })
    ).sort({ createdAt: -1 });

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce(
      (sum, order) => sum + toNumber(order.grandTotal || order.totalAmount),
      0
    );
    const totalProfit = orders.reduce((sum, order) => sum + toNumber(order.netProfit), 0);

    return res.json({
      from: start,
      to: end,
      totalOrders,
      totalRevenue,
      totalProfit,
      byPaymentMode: buildPaymentModeSummary(orders)
    });
  } catch (error) {
    return res.serverError(error);
  }
};

module.exports = {
  createOrder,
  listOrders,
  listActiveOrders,
  updateOrderStatus,
  cancelOrder,
  deleteOrder,
  getOrderInsights,
  getOrderAnalyticsSummary,
  getDailyReport,
  getMonthlyReport
};
