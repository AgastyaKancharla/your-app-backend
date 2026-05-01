const express = require("express");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const Ingredient = require("../models/Ingredient");
const Expense = require("../models/Expense");
const MenuItem = require("../models/MenuItem");
const User = require("../models/User");
const requirePermission = require("../middleware/requirePermission");
const { withTenantFilter } = require("../utils/tenantScope");
const { deriveOrderChannel } = require("../services/orderCreationService");
const {
  getOrderAmount,
  getCompletedRevenueOrders,
  sumCompletedRevenue,
  averageCompletedOrderValue,
  aggregateCompletedItems
} = require("../utils/orderAnalytics");
const {
  normalizeOrderStatus,
  buildOrderStatusFilter,
  isCompletedOrderStatus,
  isActiveOrderStatus
} = require("../utils/accessControl");
const {
  requirePlanFeature,
  requireReportRangeWithinPlan
} = require("../middleware/planLimitMiddleware");
const { assertCloudKitchenWorkspace } = require("../utils/cloudKitchenWorkspace");
const {
  resolveDashboardRange,
  getSalesSeries,
  getWastageSeries,
  getTopItems
} = require("../services/cloudKitchenDashboardService");

const router = express.Router();
router.use(requirePermission("finance.view"));
router.use(requireReportRangeWithinPlan);

const getStartDateByType = (type) => {
  const now = new Date();

  if (type === "daily") {
    now.setHours(0, 0, 0, 0);
  } else if (type === "weekly") {
    now.setDate(now.getDate() - 7);
  } else if (type === "monthly") {
    now.setMonth(now.getMonth() - 1);
  } else {
    now.setDate(now.getDate() - 30);
  }

  return now;
};

const normalizeStatus = (value) => {
  if (!value) return "ALL";

  const status = String(value).toUpperCase();
  if (status === "ALL") {
    return "ALL";
  }

  return normalizeOrderStatus(status, "ALL");
};

const getSafePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
};

const isValidDate = (value) => {
  return value instanceof Date && !Number.isNaN(value.getTime());
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

const getInclusiveDayDiff = (startDate, endDate) => {
  const start = getStartOfDay(startDate);
  const end = getStartOfDay(endDate);
  const diffMs = end.getTime() - start.getTime();
  return Math.max(1, Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1);
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sumRevenue = (orders = []) =>
  orders.reduce((sum, order) => sum + toNumber(order.grandTotal || order.totalAmount), 0);

const buildTrend = (current, previous) => {
  const diff = toNumber(current) - toNumber(previous);
  const percent = previous
    ? Math.round((diff / previous) * 100)
    : current
      ? 100
      : 0;
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  return { direction, percent };
};

const buildOrderFilter = ({ req, startDate, endDate, status }) => {
  const filter = withTenantFilter(req);

  if (startDate || endDate) {
    filter.createdAt = {};

    if (startDate) {
      filter.createdAt.$gte = startDate;
    }

    if (endDate) {
      filter.createdAt.$lte = endDate;
    }
  }

  const statusFilter = buildOrderStatusFilter(status);
  if (statusFilter) {
    filter.status = statusFilter;
  }

  return filter;
};

const aggregateItems = (orders) => {
  const itemMap = {};

  orders.forEach((order) => {
    order.items.forEach((item) => {
      if (!itemMap[item.name]) {
        itemMap[item.name] = {
          quantity: 0,
          revenue: 0
        };
      }

      itemMap[item.name].quantity += item.quantity;
      itemMap[item.name].revenue += item.quantity * item.price;
    });
  });

  return itemMap;
};

router.get("/summary/:type", async (req, res) => {
  try {
    const { type } = req.params;
    const status = normalizeStatus(req.query.status || "COMPLETED");
    const startDate = getStartDateByType(type);

    const orders = await Order.find(
      buildOrderFilter({
        req,
        startDate,
        status
      })
    );

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => sum + o.totalAmount, 0);

    res.json({
      type,
      status,
      totalOrders,
      totalRevenue
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.get("/sales", async (req, res) => {
  try {
    const workspace = await assertCloudKitchenWorkspace(req);
    const range = resolveDashboardRange({
      range: req.query?.range || req.query?.days,
      from: req.query?.from,
      to: req.query?.to
    });

    return res.json(
      await getSalesSeries({
        restaurantId: workspace._id,
        range
      })
    );
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
});

router.get("/wastage", async (req, res) => {
  try {
    const workspace = await assertCloudKitchenWorkspace(req);
    const range = resolveDashboardRange({
      range: req.query?.range || req.query?.days || "7d",
      from: req.query?.from,
      to: req.query?.to
    });

    return res.json(
      await getWastageSeries({
        restaurantId: workspace._id,
        range
      })
    );
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
});

router.get("/top-items", async (req, res) => {
  try {
    const workspace = await assertCloudKitchenWorkspace(req);
    const range = resolveDashboardRange({
      range: req.query?.range || req.query?.days || "30d",
      from: req.query?.from,
      to: req.query?.to
    });

    const items = await getTopItems({
      restaurantId: workspace._id,
      range
    });

    return res.json(items);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
});

router.get("/items", async (req, res) => {
  try {
    const days = Number(req.query.days || 30);
    const status = normalizeStatus(req.query.status || "COMPLETED");

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Math.max(1, days));

    const orders = await Order.find(
      buildOrderFilter({
        req,
        startDate,
        status
      })
    );

    const itemMap = aggregateItems(orders);

    res.json(itemMap);
  } catch (err) {
    return res.serverError(err);
  }
});

router.get("/range", async (req, res) => {
  try {
    const { from, to } = req.query;
    const status = normalizeStatus(req.query.status || "COMPLETED");

    if (!from || !to) {
      return res.status(400).json({ message: "From and To dates required" });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const orders = await Order.find(
      buildOrderFilter({
        req,
        startDate: fromDate,
        endDate: toDate,
        status
      })
    );

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => sum + o.totalAmount, 0);

    res.json({
      from,
      to,
      status,
      totalOrders,
      totalRevenue,
      items: aggregateItems(orders)
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.get("/dashboard", async (req, res) => {
  try {
    const days = getSafePositiveInt(req.query.days, 30);
    const status = normalizeStatus(req.query.status || "ALL");
    const from = req.query.from;
    const to = req.query.to;

    let startDate;
    let endDate;
    let isCustomRange = false;

    if (from || to) {
      if (!from || !to) {
        return res.status(400).json({ message: "Both from and to dates are required" });
      }

      startDate = getStartOfDay(from);
      endDate = getEndOfDay(to);
      isCustomRange = true;

      if (!isValidDate(startDate) || !isValidDate(endDate)) {
        return res.status(400).json({ message: "Invalid date range" });
      }

      if (startDate > endDate) {
        return res.status(400).json({ message: "From date must be before To date" });
      }
    } else {
      endDate = new Date();
      startDate = getStartOfDay(endDate);
      startDate.setDate(startDate.getDate() - days + 1);
    }

    const selectedRangeDays = getInclusiveDayDiff(startDate, endDate);
    const chartDays = Math.min(
      selectedRangeDays,
      getSafePositiveInt(req.query.chartDays, Math.min(7, selectedRangeDays))
    );

    const orders = await Order.find(
      buildOrderFilter({
        req,
        startDate,
        endDate,
        status
      })
    ).sort({ createdAt: 1 });

    const completedRevenueOrders = getCompletedRevenueOrders(orders);
    const totalOrders = orders.length;
    const totalRevenue = sumCompletedRevenue(orders);
    const completedOrders = completedRevenueOrders.length;
    const activeOrders = orders.filter((order) => isActiveOrderStatus(order.status)).length;
    const avgOrderValue = averageCompletedOrderValue(orders);

    const now = new Date();
    const todayStart = getStartOfDay(now);
    const todayEnd = getEndOfDay(now);
    const yesterdayAnchor = new Date(todayStart);
    yesterdayAnchor.setDate(yesterdayAnchor.getDate() - 1);
    const yesterdayStart = getStartOfDay(yesterdayAnchor);
    const yesterdayEnd = getEndOfDay(yesterdayAnchor);

    const [ordersToday, ordersYesterday] = await Promise.all([
      Order.find(
        buildOrderFilter({
          req,
          startDate: todayStart,
          endDate: todayEnd,
          status: "ALL"
        })
      ),
      Order.find(
        buildOrderFilter({
          req,
          startDate: yesterdayStart,
          endDate: yesterdayEnd,
          status: "ALL"
        })
      )
    ]);

    const completedTodayOrders = getCompletedRevenueOrders(ordersToday);
    const completedYesterdayOrders = getCompletedRevenueOrders(ordersYesterday);
    const revenueToday = sumCompletedRevenue(ordersToday);
    const revenueYesterday = sumCompletedRevenue(ordersYesterday);
    const ordersTodayCount = ordersToday.length;
    const ordersYesterdayCount = ordersYesterday.length;
    const avgOrderValueToday = averageCompletedOrderValue(ordersToday);
    const avgOrderValueYesterday = averageCompletedOrderValue(ordersYesterday);
    const activeOrdersToday = ordersToday.filter((order) =>
      isActiveOrderStatus(order.status)
    ).length;
    const activeOrdersYesterday = ordersYesterday.filter((order) =>
      isActiveOrderStatus(order.status)
    ).length;
    const cancelledOrdersToday = ordersToday.filter(
      (order) => normalizeOrderStatus(order.status) === "CANCELLED"
    ).length;
    const cancelledOrdersYesterday = ordersYesterday.filter(
      (order) => normalizeOrderStatus(order.status) === "CANCELLED"
    ).length;

    const kpiStrip = {
      todayRevenue: {
        value: revenueToday,
        trend: buildTrend(revenueToday, revenueYesterday)
      },
      ordersToday: {
        value: ordersTodayCount,
        trend: buildTrend(ordersTodayCount, ordersYesterdayCount)
      },
      avgOrderValue: {
        value: avgOrderValueToday,
        trend: buildTrend(avgOrderValueToday, avgOrderValueYesterday)
      },
      activeOrders: {
        value: activeOrdersToday,
        trend: buildTrend(activeOrdersToday, activeOrdersYesterday)
      },
      cancelledOrders: {
        value: cancelledOrdersToday,
        trend: buildTrend(cancelledOrdersToday, cancelledOrdersYesterday)
      }
    };

    const chartEndDate = getEndOfDay(endDate);
    const chartStartDate = getStartOfDay(chartEndDate);
    chartStartDate.setDate(chartStartDate.getDate() - chartDays + 1);

    if (chartStartDate < startDate) {
      chartStartDate.setTime(startDate.getTime());
      chartStartDate.setHours(0, 0, 0, 0);
    }

    const seriesLabelFormat =
      chartDays <= 7
        ? { weekday: "short" }
        : { day: "2-digit", month: "short" };
    const seriesMap = {};

    for (
      let d = new Date(chartStartDate);
      d <= chartEndDate;
      d.setDate(d.getDate() + 1)
    ) {
      const key = d.toISOString().slice(0, 10);

      seriesMap[key] = {
        label: d.toLocaleDateString("en-IN", seriesLabelFormat),
        orders: 0,
        revenue: 0,
        customers: 0,
        date: key,
        _customers: new Set()
      };
    }

    orders.forEach((order) => {
      const key = new Date(order.createdAt).toISOString().slice(0, 10);

      if (!seriesMap[key]) {
        return;
      }

      seriesMap[key].orders += 1;
      if (isCompletedOrderStatus(order.status)) {
        seriesMap[key].revenue += getOrderAmount(order);
      }
      const customerKey =
        order.customerId || order.customerPhone || order.customerName || order._id;
      if (customerKey) {
        seriesMap[key]._customers.add(String(customerKey));
      }
    });

    const series = Object.values(seriesMap).map((entry) => {
      const customers = entry._customers ? entry._customers.size : 0;
      const { _customers, ...rest } = entry;
      return { ...rest, customers };
    });

    const items = aggregateCompletedItems(orders);
    const topItems = Object.entries(items)
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 8);

    const lowStockFilter = withTenantFilter(req, {
      $expr: { $lte: ["$quantity", "$minStock"] }
    });
    const [lowStockCount, lowStockItems] = await Promise.all([
      Ingredient.countDocuments(lowStockFilter),
      Ingredient.find(lowStockFilter).sort({ quantity: 1 }).limit(6)
    ]);

    const inventoryAlerts = lowStockItems.map((item) => {
      const quantity = toNumber(item.quantity);
      const minStock = Math.max(0, toNumber(item.minStock));
      const criticalThreshold = minStock > 0 ? minStock * 0.5 : 0;
      const level = minStock > 0 && quantity <= criticalThreshold ? "CRITICAL" : "LOW";
      return {
        name: item.name,
        quantity,
        unit: item.unit || item.minStockUnit || "unit",
        level
      };
    });

    const inventoryAlertCounts = inventoryAlerts.reduce(
      (acc, item) => {
        if (item.level === "CRITICAL") acc.critical += 1;
        if (item.level === "LOW") acc.low += 1;
        return acc;
      },
      { low: 0, critical: 0 }
    );

    const customersToday = await Customer.find(
      withTenantFilter(req, {
        lastOrderAt: { $gte: todayStart, $lte: todayEnd }
      })
    ).select("name lifetimeValue firstOrderAt lastOrderAt");
    const newCustomers = customersToday.filter(
      (customer) =>
        customer.firstOrderAt &&
        customer.firstOrderAt >= todayStart &&
        customer.firstOrderAt <= todayEnd
    ).length;
    const returningCustomers = Math.max(0, customersToday.length - newCustomers);
    const topCustomer = await Customer.findOne(withTenantFilter(req))
      .sort({ lifetimeValue: -1 })
      .select("name lifetimeValue");

    const staffUsers = await User.find(
      withTenantFilter(req, {
        role: { $in: ["CASHIER", "KITCHEN", "DELIVERY_MANAGER", "DELIVERY_PARTNER"] }
      })
    ).select("_id role");
    const roleById = staffUsers.reduce((acc, user) => {
      acc[String(user._id)] = user.role;
      return acc;
    }, {});

    const cashierOrders = ordersToday.filter(
      (order) => roleById[String(order.createdBy)] === "CASHIER"
    ).length;
    const chefDishes = ordersToday
      .filter((order) => isCompletedOrderStatus(order.status))
      .reduce(
        (sum, order) =>
          sum +
          (order.items || []).reduce((itemSum, item) => itemSum + toNumber(item.quantity), 0),
        0
      );
    const deliveryCompleted = ordersToday.filter(
      (order) =>
        isCompletedOrderStatus(order.status) &&
        String(order.serviceType || "").toUpperCase() === "DELIVERY"
    ).length;

    const staffActivity = [
      { role: "Cashier", metric: "Orders processed", value: cashierOrders },
      { role: "Chef", metric: "Dishes prepared", value: chefDishes },
      { role: "Delivery", metric: "Deliveries completed", value: deliveryCompleted }
    ];

    const newOrderWindowMs = 10 * 60 * 1000;
    let kitchenNew = 0;
    let kitchenPreparing = 0;
    let kitchenReady = 0;
    let kitchenDelivered = 0;
    let kitchenCancelled = 0;

    ordersToday.forEach((order) => {
      const normalized = normalizeOrderStatus(order.status);
      const createdAt = new Date(order.createdAt || now).getTime();
      if (normalized === "NEW") {
        kitchenNew += 1;
        return;
      }
      if (normalized === "PREPARING") {
        kitchenPreparing += 1;
        return;
      }
      if (normalized === "READY") {
        kitchenReady += 1;
        return;
      }
      if (normalized === "DELIVERED") {
        kitchenDelivered += 1;
        return;
      }
      if (normalized === "CANCELLED") {
        kitchenCancelled += 1;
      }
    });

    const prepDurations = ordersToday
      .map((order) => {
        const endTimestamp =
          order.readyAt ||
          order.completedAt ||
          order.delivery?.deliveredAt ||
          null;
        if (!endTimestamp) {
          return null;
        }
        const startTimestamp = new Date(order.createdAt || now).getTime();
        const endTime = new Date(endTimestamp).getTime();
        return Math.max(0, endTime - startTimestamp);
      })
      .filter((value) => Number.isFinite(value));

    const avgPrepMinutes = prepDurations.length
      ? Math.round(prepDurations.reduce((sum, value) => sum + value, 0) / prepDurations.length / 60000)
      : 0;

    const longestWaitMinutes = ordersToday.reduce((maxWait, order) => {
      if (!isActiveOrderStatus(order.status)) {
        return maxWait;
      }
      const waitMs = now.getTime() - new Date(order.createdAt || now).getTime();
      return Math.max(maxWait, waitMs);
    }, 0);

    const delayedOrders = ordersToday.filter((order) => {
      if (!isActiveOrderStatus(order.status)) {
        return false;
      }
      const ageMs = now.getTime() - new Date(order.createdAt || now).getTime();
      return ageMs > 30 * 60 * 1000;
    }).length;

    const deliveryDelays = ordersToday.filter((order) => {
      if (normalizeOrderStatus(order.status) !== "READY") {
        return false;
      }
      const ageMs = now.getTime() - new Date(order.createdAt || now).getTime();
      return ageMs > 45 * 60 * 1000;
    }).length;

    const alertsPanel = [
      {
        type: "Order delayed",
        count: delayedOrders,
        severity: delayedOrders > 0 ? "high" : "low",
        detail: "Orders exceeding prep SLA"
      },
      {
        type: "Low inventory",
        count: lowStockCount,
        severity: lowStockCount > 0 ? "medium" : "low",
        detail: "Items below min stock"
      },
      {
        type: "Customer complaints",
        count: 0,
        severity: "low",
        detail: "No new complaints"
      },
      {
        type: "Delivery delays",
        count: deliveryDelays,
        severity: deliveryDelays > 0 ? "high" : "low",
        detail: "Late deliveries in progress"
      }
    ];

    const channelCounts = {
      WEBSITE: 0,
      SWIGGY: 0,
      ZOMATO: 0,
      MAGICPIN: 0,
      OTHER_APP: 0,
      DIRECT: 0,
      WALK_IN: 0
    };

    orders.forEach((order) => {
      const channel = deriveOrderChannel({
        paymentMode: order.paymentMode,
        serviceType: order.serviceType,
        orderChannel: order.orderChannel
      });

      channelCounts[channel] = Number(channelCounts[channel] || 0) + 1;
    });

    const orderChannels = [
      { channel: "Website", orders: channelCounts.WEBSITE },
      { channel: "Swiggy", orders: channelCounts.SWIGGY },
      { channel: "Zomato", orders: channelCounts.ZOMATO },
      { channel: "Magicpin", orders: channelCounts.MAGICPIN },
      { channel: "Other apps", orders: channelCounts.OTHER_APP },
      { channel: "Direct orders", orders: channelCounts.DIRECT },
      { channel: "Walk-in", orders: channelCounts.WALK_IN }
    ];

    const menuIdSet = new Set();
    completedRevenueOrders.forEach((order) => {
      (order.items || []).forEach((item) => {
        if (item.menuId) {
          menuIdSet.add(String(item.menuId));
        }
      });
    });

    const menuItems = menuIdSet.size
      ? await MenuItem.find(
          withTenantFilter(req, {
            _id: { $in: Array.from(menuIdSet) }
          })
        ).select("_id costPrice")
      : [];

    const costByMenuId = menuItems.reduce((acc, item) => {
      acc[String(item._id)] = toNumber(item.costPrice);
      return acc;
    }, {});

    const ingredientCost = completedRevenueOrders.reduce((sum, order) => {
      const orderCost = (order.items || []).reduce((itemSum, item) => {
        const cost = costByMenuId[String(item.menuId)] || 0;
        return itemSum + cost * toNumber(item.quantity);
      }, 0);
      return sum + orderCost;
    }, 0);

    const staffExpenseFilter = withTenantFilter(req, {
      category: { $regex: /staff|salary/i }
    });
    if (startDate || endDate) {
      staffExpenseFilter.createdAt = {};
      if (startDate) {
        staffExpenseFilter.createdAt.$gte = startDate;
      }
      if (endDate) {
        staffExpenseFilter.createdAt.$lte = endDate;
      }
    }

    const staffExpenses = await Expense.find(staffExpenseFilter);
    const staffCost = staffExpenses.reduce((sum, expense) => sum + toNumber(expense.amount), 0);
    const profitSnapshot = {
      revenue: totalRevenue,
      ingredientCost,
      staffCost,
      profit: totalRevenue - ingredientCost - staffCost
    };

    res.json({
      range: {
        days: selectedRangeDays,
        from: startDate,
        to: endDate,
        mode: isCustomRange ? "custom" : "preset"
      },
      chartRange: {
        days: chartDays,
        from: chartStartDate,
        to: chartEndDate
      },
      filters: {
        status,
        chartDays
      },
      cards: {
        totalRevenue,
        totalOrders,
        completedOrders,
        activeOrders,
        cancelledOrders: cancelledOrdersToday,
        pendingOrders: activeOrders,
        avgOrderValue,
        lowStockCount
      },
      salesBreakdown: {
        completed: completedOrders,
        active: activeOrders,
        pending: activeOrders,
        cancelled: cancelledOrdersToday
      },
      series,
      topItems,
      topItemsDetailed: topItems.map((item) => ({
        name: item.name,
        orders: item.quantity,
        revenue: item.revenue
      })),
      kpiStrip,
      kitchenStatus: {
        newOrders: kitchenNew,
        preparing: kitchenPreparing,
        ready: kitchenReady,
        delivered: kitchenDelivered,
        cancelled: kitchenCancelled,
        avgPrepMinutes,
        longestWaitMinutes: Math.round(longestWaitMinutes / 60000)
      },
      inventoryAlerts: {
        items: inventoryAlerts,
        counts: inventoryAlertCounts
      },
      customerInsights: {
        customersToday: customersToday.length,
        newCustomers,
        returningCustomers,
        topCustomer: topCustomer
          ? { name: topCustomer.name, spend: toNumber(topCustomer.lifetimeValue) }
          : null
      },
      staffActivity,
      alertsPanel,
      orderChannels,
      profitSnapshot
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.get(
  "/payment-mode",
  requirePlanFeature("advancedReports", {
    requiredPlan: "PRO",
    message: "Payment mode analytics are available on PRO and above plans."
  }),
  async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    const status = normalizeStatus(req.query.status || "COMPLETED");

    const startDate = from && !Number.isNaN(from.getTime()) ? getStartOfDay(from) : undefined;
    const endDate = to && !Number.isNaN(to.getTime()) ? getEndOfDay(to) : undefined;

    const orders = await Order.find(
      buildOrderFilter({
        req,
        startDate,
        endDate,
        status
      })
    );

    const byMode = orders.reduce((acc, order) => {
      const key = String(order.paymentMode || "OTHER").toUpperCase();
      if (!acc[key]) {
        acc[key] = { orders: 0, revenue: 0 };
      }

      acc[key].orders += 1;
      acc[key].revenue += Number(order.grandTotal || order.totalAmount || 0);
      return acc;
    }, {});

    res.json(byMode);
  } catch (err) {
    return res.serverError(err);
  }
});

router.get(
  "/profit-loss",
  requirePlanFeature("advancedReports", {
    requiredPlan: "PRO",
    message: "Profit and loss reports are available on PRO and above plans."
  }),
  async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const startDate = from && !Number.isNaN(from.getTime()) ? getStartOfDay(from) : undefined;
    const endDate = to && !Number.isNaN(to.getTime()) ? getEndOfDay(to) : undefined;

    const orderFilter = buildOrderFilter({
      req,
      startDate,
      endDate,
      status: "COMPLETED"
    });

    const expenseFilter = withTenantFilter(req);
    if (startDate || endDate) {
      expenseFilter.createdAt = {};
      if (startDate) {
        expenseFilter.createdAt.$gte = startDate;
      }
      if (endDate) {
        expenseFilter.createdAt.$lte = endDate;
      }
    }

    const [orders, expenses] = await Promise.all([
      Order.find(orderFilter),
      Expense.find(expenseFilter)
    ]);

    const salesRevenue = orders.reduce(
      (sum, order) => sum + Number(order.grandTotal || order.totalAmount || 0),
      0
    );
    const grossNetProfit = orders.reduce((sum, order) => sum + Number(order.netProfit || 0), 0);
    const totalExpenses = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    const finalProfit = grossNetProfit - totalExpenses;

    res.json({
      salesRevenue,
      grossNetProfit,
      totalExpenses,
      finalProfit
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.get(
  "/channel-comparison",
  requirePlanFeature("advancedReports", {
    requiredPlan: "PRO",
    message: "Channel comparison reports are available on PRO and above plans."
  }),
  async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const startDate = from && !Number.isNaN(from.getTime()) ? getStartOfDay(from) : undefined;
    const endDate = to && !Number.isNaN(to.getTime()) ? getEndOfDay(to) : undefined;

    const orders = await Order.find(
      buildOrderFilter({
        req,
        startDate,
        endDate,
        status: "COMPLETED"
      })
    );

    const onlineModes = new Set(["ZOMATO", "SWIGGY"]);

    const result = {
      direct: { orders: 0, revenue: 0 },
      online: { orders: 0, revenue: 0 }
    };

    orders.forEach((order) => {
      const revenue = Number(order.grandTotal || order.totalAmount || 0);
      const bucket = onlineModes.has(String(order.paymentMode || "").toUpperCase())
        ? "online"
        : "direct";

      result[bucket].orders += 1;
      result[bucket].revenue += revenue;
    });

    res.json(result);
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
