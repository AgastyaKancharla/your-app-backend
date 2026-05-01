const Order = require("../models/Order");
const Ingredient = require("../models/Ingredient");
const Recipe = require("../models/Recipe");
const Customer = require("../models/Customer");
const WastageLog = require("../models/WastageLog");
const { getCompletedRevenueOrders, sumCompletedRevenue, averageCompletedOrderValue } = require("../utils/orderAnalytics");
const {
  normalizeOrderStatus,
  isCompletedOrderStatus
} = require("../utils/accessControl");

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

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

const getDateKey = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const ACTIVE_ORDER_EXCLUSIONS = ["DELIVERED", "DISPATCHED", "COMPLETED", "CANCELLED"];
const DELAY_THRESHOLD_MINUTES = 15;
const KITCHEN_LOAD_CAPACITY = 12;

const getElapsedMinutes = (fromValue, toValue = Date.now()) => {
  const from = new Date(fromValue).getTime();
  const to = new Date(toValue).getTime();

  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return 0;
  }

  return (to - from) / 60000;
};

const resolvePrepCompletedAt = (order = {}) =>
  order.readyAt || order.completedAt || order.delivery?.deliveredAt || null;

const getOrderPrepAgeMinutes = (order, now = Date.now()) =>
  getElapsedMinutes(order?.createdAt || now, now);

const getOrderPrepDurationMinutes = (order) => {
  const completedAt = resolvePrepCompletedAt(order);
  if (!completedAt) {
    return 0;
  }

  return getElapsedMinutes(order?.createdAt, completedAt);
};

const average = (values = []) => {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + toNumber(value), 0) / values.length;
};

const calculateKitchenLoad = ({ activeOrders = 0, delayedOrders = 0, avgPrepTime = 0 } = {}) => {
  const queueScore = Math.min(100, (toNumber(activeOrders) / KITCHEN_LOAD_CAPACITY) * 100);
  const delayedScore = Math.min(36, toNumber(delayedOrders) * 12);
  const prepScore =
    toNumber(avgPrepTime) >= 28
      ? 18
      : toNumber(avgPrepTime) >= 20
        ? 12
        : toNumber(avgPrepTime) >= 14
          ? 6
          : 0;

  return Math.round(Math.min(100, queueScore * 0.65 + delayedScore + prepScore));
};

const formatKitchenLoadLabel = (percentage = 0) => {
  const normalized = toNumber(percentage);

  if (normalized >= 85) {
    return "Critical";
  }
  if (normalized >= 65) {
    return "High";
  }
  if (normalized >= 40) {
    return "Moderate";
  }
  return "Stable";
};

const buildOperationalAlerts = ({
  delayedOrders = 0,
  lowStockCount = 0,
  kitchenLoad = 0
} = {}) => {
  const alerts = [];

  if (toNumber(delayedOrders) > 0) {
    alerts.push({
      type: "danger",
      message: `${delayedOrders} delayed order${delayedOrders === 1 ? "" : "s"} need attention`
    });
  }

  if (toNumber(lowStockCount) > 0) {
    alerts.push({
      type: "warning",
      message: `${lowStockCount} stock item${lowStockCount === 1 ? "" : "s"} are below safe levels`
    });
  }

  if (toNumber(kitchenLoad) >= 85) {
    alerts.push({
      type: "warning",
      message: "Kitchen load is nearing capacity"
    });
  }

  return alerts;
};

const formatHourWindow = (hour) => {
  const start = new Date();
  start.setHours(hour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(hour + 1, 0, 0, 0);

  return `${start.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit"
  })} - ${end.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit"
  })}`;
};

const createSeriesSkeleton = ({ startDate, endDate }) => {
  const series = [];
  const cursor = getStartOfDay(startDate);
  const safeEndDate = getEndOfDay(endDate);

  while (cursor <= safeEndDate) {
    const key = getDateKey(cursor);
    series.push({
      date: key,
      label: cursor.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short"
      }),
      revenue: 0,
      orders: 0,
      wastageCost: 0,
      wastageCount: 0
    });

    cursor.setDate(cursor.getDate() + 1);
  }

  return series;
};

const resolveDashboardRange = ({ range = "today", from, to, now = new Date() } = {}) => {
  const normalizedRange = String(range || "today").trim().toLowerCase();
  const endDate = getEndOfDay(now);

  if ((normalizedRange === "custom" || from || to) && from && to) {
    const startDate = getStartOfDay(from);
    const customEndDate = getEndOfDay(to);

    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(customEndDate.getTime()) ||
      startDate > customEndDate
    ) {
      const error = new Error("Invalid date range");
      error.status = 400;
      throw error;
    }

    return {
      key: "custom",
      label: `${getDateKey(startDate)} to ${getDateKey(customEndDate)}`,
      startDate,
      endDate: customEndDate
    };
  }

  const presetDays = {
    today: 1,
    "1": 1,
    "1d": 1,
    "7": 7,
    "7d": 7,
    "30": 30,
    "30d": 30,
    "90": 90,
    "90d": 90
  };

  const days = presetDays[normalizedRange] || 1;
  const startDate = getStartOfDay(endDate);
  startDate.setDate(startDate.getDate() - days + 1);

  return {
    key: days === 1 ? "today" : `${days}d`,
    label: days === 1 ? "Today" : `Last ${days} Days`,
    startDate,
    endDate
  };
};

const buildOrderFilter = (restaurantId, range) => ({
  restaurantId,
  createdAt: {
    $gte: range.startDate,
    $lte: range.endDate
  }
});

const buildWastageFilter = (restaurantId, range) => ({
  restaurantId,
  createdAt: {
    $gte: range.startDate,
    $lte: range.endDate
  }
});

const getDashboardMetrics = async ({ restaurantId, range }) => {
  const todayRange = resolveDashboardRange({ range: "today" });
  const [orders, todayOrders, activeOrders, wastageLogs, lowStockCount] = await Promise.all([
    Order.find(buildOrderFilter(restaurantId, range)).lean(),
    Order.find(buildOrderFilter(restaurantId, todayRange)).lean(),
    Order.find({
      restaurantId,
      status: { $nin: ACTIVE_ORDER_EXCLUSIONS }
    }).lean(),
    WastageLog.find(buildWastageFilter(restaurantId, range)).lean(),
    Ingredient.countDocuments({ restaurantId, lowStockAlert: true })
  ]);

  const todayRevenue = sumCompletedRevenue(todayOrders);
  const foodWastage = wastageLogs.reduce(
    (sum, log) => sum + toNumber(log.estimatedCost),
    0
  );
  const activeOrderPrepTimes = activeOrders
    .map((order) => getOrderPrepAgeMinutes(order))
    .filter((value) => value > 0);
  const completedPrepSamples = orders
    .map((order) => ({
      status: normalizeOrderStatus(order.status, ""),
      durationMinutes: getOrderPrepDurationMinutes(order)
    }))
    .filter(
      (sample) => ["READY", "DELIVERED", "DISPATCHED"].includes(sample.status) && sample.durationMinutes > 0
    )
    .map((sample) => sample.durationMinutes);
  const delayedOrders = activeOrderPrepTimes.filter(
    (minutes) => minutes >= DELAY_THRESHOLD_MINUTES
  ).length;
  const avgPrepTimeMinutes = Number(
    average(completedPrepSamples.length ? completedPrepSamples : activeOrderPrepTimes).toFixed(1)
  );
  const rejectedOrders = orders.filter(
    (order) => normalizeOrderStatus(order.status, "") === "CANCELLED"
  ).length;
  const kitchenLoad = calculateKitchenLoad({
    activeOrders: activeOrders.length,
    delayedOrders,
    avgPrepTime: avgPrepTimeMinutes
  });

  return {
    range: {
      key: range.key,
      label: range.label,
      from: range.startDate.toISOString(),
      to: range.endDate.toISOString()
    },
    todayRevenue: Number(todayRevenue.toFixed(2)),
    totalOrders: orders.length,
    avgOrderValue: Number(averageCompletedOrderValue(orders).toFixed(2)),
    foodWastage: Number(foodWastage.toFixed(2)),
    liveOrders: activeOrders.length,
    activeOrders: activeOrders.length,
    delayedOrders,
    avgPrepTimeMinutes,
    kitchenLoad,
    kitchenLoadLabel: formatKitchenLoadLabel(kitchenLoad),
    lowStockCount,
    rejectedOrders,
    delayThresholdMinutes: DELAY_THRESHOLD_MINUTES,
    operationalAlerts: buildOperationalAlerts({
      delayedOrders,
      lowStockCount,
      kitchenLoad
    }),
    totalRevenue: Number(sumCompletedRevenue(orders).toFixed(2))
  };
};

const getSalesSeries = async ({ restaurantId, range }) => {
  const orders = await Order.find(buildOrderFilter(restaurantId, range))
    .sort({ createdAt: 1 })
    .lean();
  const skeleton = createSeriesSkeleton(range);
  const byDate = skeleton.reduce((acc, entry) => {
    acc[entry.date] = entry;
    return acc;
  }, {});

  orders.forEach((order) => {
    const key = getDateKey(order.createdAt);
    if (!byDate[key]) {
      return;
    }

    byDate[key].orders += 1;
    if (isCompletedOrderStatus(order.status)) {
      byDate[key].revenue += toNumber(order.grandTotal || order.totalAmount);
    }
  });

  return {
    range: {
      key: range.key,
      label: range.label
    },
    series: skeleton.map((entry) => ({
      ...entry,
      revenue: Number(entry.revenue.toFixed(2))
    }))
  };
};

const getWastageSeries = async ({ restaurantId, range }) => {
  const logs = await WastageLog.find(buildWastageFilter(restaurantId, range))
    .sort({ createdAt: 1 })
    .lean();
  const skeleton = createSeriesSkeleton(range);
  const byDate = skeleton.reduce((acc, entry) => {
    acc[entry.date] = entry;
    return acc;
  }, {});

  logs.forEach((log) => {
    const key = getDateKey(log.createdAt);
    if (!byDate[key]) {
      return;
    }

    byDate[key].wastageCost += toNumber(log.estimatedCost);
    byDate[key].wastageCount += 1;
  });

  return {
    range: {
      key: range.key,
      label: range.label
    },
    totalCost: Number(
      skeleton.reduce((sum, entry) => sum + toNumber(entry.wastageCost), 0).toFixed(2)
    ),
    series: skeleton.map((entry) => ({
      date: entry.date,
      label: entry.label,
      cost: Number(entry.wastageCost.toFixed(2)),
      count: entry.wastageCount
    }))
  };
};

const getTopItems = async ({ restaurantId, range, limit = 8 }) => {
  const orders = await Order.find(buildOrderFilter(restaurantId, range)).lean();
  const completedOrders = getCompletedRevenueOrders(orders);

  const counts = completedOrders.reduce((acc, order) => {
    (order.items || []).forEach((item) => {
      const name = String(item?.displayName || item?.name || "").trim();
      if (!name) {
        return;
      }

      if (!acc[name]) {
        acc[name] = {
          name,
          orders: 0,
          revenue: 0
        };
      }

      const quantity = toNumber(item.quantity);
      acc[name].orders += quantity;
      acc[name].revenue += quantity * toNumber(item.price);
    });

    return acc;
  }, {});

  return Object.values(counts)
    .sort((a, b) => {
      if (b.orders !== a.orders) {
        return b.orders - a.orders;
      }

      return b.revenue - a.revenue;
    })
    .slice(0, limit)
    .map((item) => ({
      name: item.name,
      orders: item.orders,
      revenue: Number(item.revenue.toFixed(2))
    }));
};

const getActiveOrders = async ({ restaurantId, limit = 12 }) => {
  const now = Date.now();
  const orders = await Order.find({
    restaurantId,
    status: { $nin: ACTIVE_ORDER_EXCLUSIONS }
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return orders.map((order) => ({
    _id: order._id,
    invoiceNumber: order.invoiceNumber || "",
    customerName: order.customerName || "Walk-in",
    status: normalizeOrderStatus(order.status),
    totalAmount: toNumber(order.grandTotal || order.totalAmount),
    prepTimeMinutes: Math.max(
      0,
      Math.round((now - new Date(order.createdAt || now).getTime()) / 60000)
    ),
    itemCount: (order.items || []).reduce(
      (sum, item) => sum + toNumber(item.quantity),
      0
    ),
    createdAt: order.createdAt,
    items: (order.items || []).map((item) => ({
      name: item.displayName || item.name,
      quantity: toNumber(item.quantity)
    }))
  }));
};

const getOperationalInsights = async ({ restaurantId }) => {
  const now = new Date();
  const last7Days = resolveDashboardRange({ range: "7d", now });
  const previous7Days = {
    key: "previous-7d",
    label: "Previous 7 Days",
    startDate: getStartOfDay(new Date(last7Days.startDate.getTime() - 7 * 24 * 60 * 60 * 1000)),
    endDate: getEndOfDay(new Date(last7Days.startDate.getTime() - 1))
  };
  const last30Days = resolveDashboardRange({ range: "30d", now });

  const [lowStockItems, currentOrders, previousOrders, recentOrders, customers, recipes] =
    await Promise.all([
      Ingredient.find({ restaurantId, lowStockAlert: true }).sort({ quantity: 1 }).limit(3).lean(),
      Order.find(buildOrderFilter(restaurantId, last7Days)).lean(),
      Order.find(buildOrderFilter(restaurantId, previous7Days)).lean(),
      Order.find(buildOrderFilter(restaurantId, last30Days)).lean(),
      Customer.find({ restaurantId }).select("name lastOrderAt").lean(),
      Recipe.find({ restaurantId }).select("menuItem ingredients").lean()
    ]);

  const insights = [];

  if (lowStockItems.length) {
    const criticalItem = lowStockItems[0];
    insights.push({
      type: "warning",
      message: `${criticalItem.name} is below minimum stock with ${toNumber(
        criticalItem.quantity
      )} ${criticalItem.unit || "units"} remaining`
    });
  }

  const currentRevenue = sumCompletedRevenue(currentOrders);
  const previousRevenue = sumCompletedRevenue(previousOrders);
  if (previousRevenue > 0 && currentRevenue < previousRevenue * 0.8) {
    const dropPercent = Math.round(((previousRevenue - currentRevenue) / previousRevenue) * 100);
    insights.push({
      type: "danger",
      message: `Demand is down ${dropPercent}% compared with the previous 7 days`
    });
  }

  const hourCounts = recentOrders.reduce((acc, order) => {
    const createdAt = new Date(order.createdAt);
    const hour = Number.isNaN(createdAt.getTime()) ? -1 : createdAt.getHours();
    if (hour < 0) {
      return acc;
    }

    acc[hour] = Number(acc[hour] || 0) + 1;
    return acc;
  }, {});
  const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
  if (peakHour) {
    insights.push({
      type: "info",
      message: `Peak order window is trending around ${formatHourWindow(Number(peakHour[0]))}`
    });
  }

  const inactiveCustomers = customers.filter((customer) => {
    if (!customer.lastOrderAt) {
      return true;
    }

    return new Date(customer.lastOrderAt) < new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  });
  if (inactiveCustomers.length) {
    insights.push({
      type: "info",
      message: `${inactiveCustomers.length} customers have been inactive for more than 30 days`
    });
  }

  if (!insights.length && recipes.length) {
    insights.push({
      type: "success",
      message: "Cloud kitchen operations look healthy across orders, stock, and recipes"
    });
  }

  return insights.slice(0, 4);
};

module.exports = {
  resolveDashboardRange,
  getDashboardMetrics,
  getSalesSeries,
  getWastageSeries,
  getTopItems,
  getActiveOrders,
  getOperationalInsights,
  formatHourWindow,
  calculateKitchenLoad,
  formatKitchenLoadLabel
};
