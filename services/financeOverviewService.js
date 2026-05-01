const mongoose = require("mongoose");

const Expense = require("../models/Expense");
const MenuItem = require("../models/MenuItem");
const Order = require("../models/Order");

const REPORT_TIMEZONE = "Asia/Kolkata";
const EXPENSE_BUCKETS = [
  "Raw Materials",
  "Packaging",
  "Staff",
  "Rent",
  "Utilities",
  "Others"
];
const CHANNEL_KEYS = ["DIRECT", "SWIGGY", "ZOMATO"];
const EXCLUDED_STATUSES = ["CANCELLED"];

const RANGE_PRESETS = {
  today: { label: "Today", days: 1 },
  "7d": { label: "Last 7 Days", days: 7 },
  "30d": { label: "Last 30 Days", days: 30 },
  "90d": { label: "Last 90 Days", days: 90 }
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundMetric = (value, digits = 2) => Number(toNumber(value).toFixed(digits));

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

const getInclusiveDayDiff = (from, to) => {
  const start = getStartOfDay(from);
  const end = getStartOfDay(to);
  const diffMs = end.getTime() - start.getTime();
  return Math.max(1, Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1);
};

const getDateKey = (value) => new Date(value).toISOString().slice(0, 10);

const resolveRange = ({ range, from, to } = {}) => {
  const normalizedRange = String(range || "today").trim().toLowerCase();
  const now = new Date();

  if (normalizedRange === "custom") {
    const customFrom = getStartOfDay(from);
    const customTo = getEndOfDay(to);

    if (Number.isNaN(customFrom.getTime()) || Number.isNaN(customTo.getTime()) || customFrom > customTo) {
      const error = new Error("Invalid custom date range");
      error.status = 400;
      throw error;
    }

    return {
      key: "custom",
      label: "Custom Range",
      startDate: customFrom,
      endDate: customTo,
      days: getInclusiveDayDiff(customFrom, customTo)
    };
  }

  const preset = RANGE_PRESETS[normalizedRange] || RANGE_PRESETS.today;
  const endDate = getEndOfDay(now);
  const startDate = getStartOfDay(endDate);
  startDate.setDate(startDate.getDate() - preset.days + 1);

  return {
    key: normalizedRange in RANGE_PRESETS ? normalizedRange : "today",
    label: preset.label,
    startDate,
    endDate,
    days: preset.days
  };
};

const getPreviousRange = ({ startDate, days }) => {
  const previousEnd = new Date(startDate.getTime() - 1);
  const previousStart = getStartOfDay(previousEnd);
  previousStart.setDate(previousStart.getDate() - Math.max(1, days) + 1);

  return {
    startDate: previousStart,
    endDate: getEndOfDay(previousEnd)
  };
};

const buildOrderAmountExpr = () => ({
  $ifNull: ["$totalAmount", { $ifNull: ["$grandTotal", 0] }]
});

const buildOrderMatch = ({ restaurantId, startDate, endDate }) => ({
  restaurantId,
  createdAt: {
    $gte: startDate,
    $lte: endDate
  },
  status: {
    $nin: EXCLUDED_STATUSES
  }
});

const buildExpenseMatch = ({ restaurantId, startDate, endDate }) => ({
  restaurantId,
  createdAt: {
    $gte: startDate,
    $lte: endDate
  }
});

const buildChannelExpr = () => ({
  $switch: {
    branches: [
      {
        case: {
          $or: [
            { $eq: ["$orderChannel", "SWIGGY"] },
            { $eq: ["$paymentMode", "SWIGGY"] },
            { $eq: ["$platform", "SWIGGY"] }
          ]
        },
        then: "SWIGGY"
      },
      {
        case: {
          $or: [
            { $eq: ["$orderChannel", "ZOMATO"] },
            { $eq: ["$paymentMode", "ZOMATO"] },
            { $eq: ["$platform", "ZOMATO"] }
          ]
        },
        then: "ZOMATO"
      }
    ],
    default: "DIRECT"
  }
});

const computeTrend = (current, previous) => {
  const currentValue = toNumber(current);
  const previousValue = toNumber(previous);
  const delta = currentValue - previousValue;
  const percent = previousValue > 0
    ? (delta / previousValue) * 100
    : currentValue > 0
      ? 100
      : 0;

  return {
    delta: roundMetric(delta),
    percent: roundMetric(percent, 1),
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat"
  };
};

const buildInsightTone = (direction) => {
  if (direction === "up") {
    return "success";
  }
  if (direction === "down") {
    return "danger";
  }
  return "neutral";
};

const buildInsights = ({ trends, channels, topItems }) => {
  const topItem = topItems[0];
  const marginAlerts = channels
    .filter((channel) => toNumber(channel.margin) < 20)
    .sort((a, b) => toNumber(a.margin) - toNumber(b.margin));
  const weakestChannel = marginAlerts[0];

  return [
    {
      id: "profit_trend",
      title:
        trends.netProfit.direction === "down"
          ? "Profit declined in selected range"
          : trends.netProfit.direction === "up"
            ? "Profit increased in selected range"
            : "Profit held steady",
      description: `Net profit moved ${trends.netProfit.percent}% compared to previous range.`,
      tone: buildInsightTone(trends.netProfit.direction)
    },
    {
      id: "expense_trend",
      title:
        trends.expenses.direction === "up"
          ? "Expenses increased"
          : trends.expenses.direction === "down"
            ? "Expenses reduced"
            : "Expenses were stable",
      description: `Total operating spend changed by ${trends.expenses.percent}% period-over-period.`,
      tone: trends.expenses.direction === "up" ? "warning" : "success"
    },
    {
      id: "top_item",
      title: topItem ? `Top item: ${topItem.name}` : "Top item data unavailable",
      description: topItem
        ? `${topItem.orders} orders generated ₹${Math.round(topItem.profit)} profit in this range.`
        : "Place more orders to unlock item-level profitability insights.",
      tone: "success"
    },
    {
      id: "channel_margin",
      title: weakestChannel
        ? `${weakestChannel.channel} margin needs attention`
        : "Healthy channel margin mix",
      description: weakestChannel
        ? `${weakestChannel.channel} margin is ${weakestChannel.margin}% vs blended target of 20%+.`
        : "All major channels are above the baseline profitability threshold.",
      tone: weakestChannel ? "danger" : "neutral"
    }
  ];
};

const buildTransactions = ({ orders, expenses }) => {
  const orderRows = (orders || []).map((order) => {
    const channel = String(order.orderChannel || order.paymentMode || "DIRECT").toUpperCase();
    const id = String(order.invoiceNumber || order._id || "").trim();

    return {
      id: `order-${order._id}`,
      date: order.createdAt,
      description: id ? `Order ${id}` : `Order #${String(order._id).slice(-6).toUpperCase()}`,
      type: "Revenue",
      amount: roundMetric(order.totalAmount),
      channel
    };
  });

  const expenseRows = (expenses || []).map((expense) => ({
    id: `expense-${expense._id}`,
    date: expense.createdAt,
    description: expense.description || `${expense.category || "General"} expense`,
    type: "Expense",
    amount: roundMetric(expense.amount),
    category: expense.category || "Others"
  }));

  return [...orderRows, ...expenseRows]
    .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())
    .slice(0, 12)
    .map((entry) => ({
      ...entry,
      date: new Date(entry.date).toISOString()
    }));
};

const getRangeTotals = async ({ restaurantId, startDate, endDate }) => {
  const orderMatch = buildOrderMatch({ restaurantId, startDate, endDate });
  const expenseMatch = buildExpenseMatch({ restaurantId, startDate, endDate });

  const [orderAgg = {}, expenseAgg = {}] = await Promise.all([
    Order.aggregate([
      { $match: orderMatch },
      {
        $group: {
          _id: null,
          revenue: { $sum: buildOrderAmountExpr() },
          totalOrders: { $sum: 1 }
        }
      }
    ]).then((rows) => rows[0] || {}),
    Expense.aggregate([
      { $match: expenseMatch },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: "$amount" }
        }
      }
    ]).then((rows) => rows[0] || {})
  ]);

  const revenue = toNumber(orderAgg.revenue);
  const totalOrders = toNumber(orderAgg.totalOrders);
  const expenses = toNumber(expenseAgg.totalExpenses);
  const netProfit = revenue - expenses;

  return {
    revenue,
    totalOrders,
    expenses,
    netProfit,
    avgOrderValue: totalOrders ? revenue / totalOrders : 0,
    avgOrderProfit: totalOrders ? netProfit / totalOrders : 0,
    margin: revenue ? (netProfit / revenue) * 100 : 0
  };
};

const buildChannelRows = ({ rows, revenue, totalCost }) => {
  const source = (rows || []).reduce((acc, row) => {
    const key = CHANNEL_KEYS.includes(String(row._id || "").toUpperCase())
      ? String(row._id).toUpperCase()
      : "DIRECT";
    if (!acc[key]) {
      acc[key] = { revenue: 0, orders: 0 };
    }
    acc[key].revenue += toNumber(row.revenue);
    acc[key].orders += toNumber(row.orders);
    return acc;
  }, {});

  return CHANNEL_KEYS.map((channel) => {
    const channelRevenue = toNumber(source[channel]?.revenue);
    const channelOrders = toNumber(source[channel]?.orders);
    const share = revenue > 0 ? channelRevenue / revenue : 0;
    const channelCost = share * totalCost;
    const channelProfit = channelRevenue - channelCost;
    const channelMargin = channelRevenue > 0 ? (channelProfit / channelRevenue) * 100 : 0;

    return {
      channel,
      revenue: roundMetric(channelRevenue),
      orders: channelOrders,
      profit: roundMetric(channelProfit),
      margin: roundMetric(channelMargin, 1),
      share: roundMetric(share * 100, 1)
    };
  });
};

const getTopItems = async ({ restaurantId, startDate, endDate }) => {
  const orderMatch = buildOrderMatch({ restaurantId, startDate, endDate });
  const rows = await Order.aggregate([
    { $match: orderMatch },
    { $unwind: "$items" },
    {
      $project: {
        menuItemId: { $ifNull: ["$items.menuItemId", "$items.menuId"] },
        name: { $ifNull: ["$items.name", "Unnamed Item"] },
        image: { $ifNull: ["$items.image", ""] },
        quantity: { $ifNull: ["$items.quantity", 0] },
        lineRevenue: {
          $multiply: [
            { $ifNull: ["$items.quantity", 0] },
            { $ifNull: ["$items.price", 0] }
          ]
        }
      }
    },
    {
      $group: {
        _id: {
          menuItemId: "$menuItemId",
          nameLower: { $toLower: "$name" }
        },
        name: { $first: "$name" },
        image: { $first: "$image" },
        orders: { $sum: 1 },
        quantity: { $sum: "$quantity" },
        revenue: { $sum: "$lineRevenue" }
      }
    },
    { $sort: { revenue: -1 } }
  ]);

  const menuIds = rows
    .map((row) => row?._id?.menuItemId)
    .filter((value) => mongoose.Types.ObjectId.isValid(value))
    .map((value) => new mongoose.Types.ObjectId(value));

  const menuItems = menuIds.length
    ? await MenuItem.find({
        restaurantId,
        _id: { $in: menuIds }
      }).select("_id name costPrice cost image")
    : [];

  const costById = menuItems.reduce((acc, item) => {
    acc[String(item._id)] = toNumber(item.costPrice || item.cost);
    return acc;
  }, {});

  const costByName = menuItems.reduce((acc, item) => {
    const key = String(item.name || "").trim().toLowerCase();
    if (key && !acc[key]) {
      acc[key] = toNumber(item.costPrice || item.cost);
    }
    return acc;
  }, {});

  const imageById = menuItems.reduce((acc, item) => {
    acc[String(item._id)] = String(item.image || "");
    return acc;
  }, {});

  const normalizedRows = rows.map((row) => {
    const menuItemId = row?._id?.menuItemId ? String(row._id.menuItemId) : "";
    const nameLower = String(row?._id?.nameLower || "").trim();
    const units = toNumber(row.quantity);
    const revenue = toNumber(row.revenue);
    const unitCost = menuItemId && costById[menuItemId] !== undefined
      ? toNumber(costById[menuItemId])
      : toNumber(costByName[nameLower]);
    const cost = unitCost * units;
    const profit = revenue - cost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    return {
      id: menuItemId || nameLower || String(row.name || "item").toLowerCase().replace(/\s+/g, "-"),
      menuItemId,
      name: row.name || "Unnamed Item",
      image: row.image || imageById[menuItemId] || "",
      orders: Math.max(0, Math.round(toNumber(row.orders))),
      quantity: roundMetric(units, 1),
      revenue: roundMetric(revenue),
      cost: roundMetric(cost),
      profit: roundMetric(profit),
      margin: roundMetric(margin, 1)
    };
  });

  const totalCogs = normalizedRows.reduce((sum, item) => sum + toNumber(item.cost), 0);

  return {
    totalCogs: roundMetric(totalCogs),
    topItems: [...normalizedRows].sort((left, right) => right.profit - left.profit).slice(0, 5)
  };
};

const buildChartSeries = ({ range, orderRows, expenseRows }) => {
  const orderMap = (orderRows || []).reduce((acc, row) => {
    const key = String(row._id || "");
    acc[key] = toNumber(row.revenue);
    return acc;
  }, {});

  const expenseMap = (expenseRows || []).reduce((acc, row) => {
    const key = String(row._id || "");
    acc[key] = toNumber(row.expenses);
    return acc;
  }, {});

  const rows = [];
  const cursor = getStartOfDay(range.startDate);
  const endDate = getEndOfDay(range.endDate);

  while (cursor <= endDate) {
    const key = getDateKey(cursor);
    const revenue = toNumber(orderMap[key]);
    const expenses = toNumber(expenseMap[key]);

    rows.push({
      date: key,
      label: cursor.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: range.days <= 7 ? "short" : "numeric",
        timeZone: REPORT_TIMEZONE
      }),
      revenue: roundMetric(revenue),
      expenses: roundMetric(expenses),
      profit: roundMetric(revenue - expenses)
    });

    cursor.setDate(cursor.getDate() + 1);
  }

  return rows;
};

const buildExpenseRows = (rows = [], totalExpenses = 0) => {
  const byBucket = rows.reduce((acc, row) => {
    const key = EXPENSE_BUCKETS.includes(String(row._id || ""))
      ? String(row._id)
      : "Others";
    acc[key] = toNumber(acc[key]) + toNumber(row.amount);
    return acc;
  }, {});

  return EXPENSE_BUCKETS.map((category) => {
    const amount = toNumber(byBucket[category]);
    const share = totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0;

    return {
      category,
      value: roundMetric(amount),
      share: roundMetric(share, 1)
    };
  });
};

async function getFinanceOverviewData({
  restaurantId,
  range,
  from,
  to
}) {
  const scopedRestaurantId = mongoose.Types.ObjectId.isValid(restaurantId)
    ? new mongoose.Types.ObjectId(String(restaurantId))
    : null;

  if (!scopedRestaurantId) {
    const error = new Error("Valid restaurant context is required");
    error.status = 400;
    throw error;
  }

  const resolvedRange = resolveRange({ range, from, to });
  const previousRange = getPreviousRange(resolvedRange);

  const [currentTotals, previousTotals] = await Promise.all([
    getRangeTotals({
      restaurantId: scopedRestaurantId,
      startDate: resolvedRange.startDate,
      endDate: resolvedRange.endDate
    }),
    getRangeTotals({
      restaurantId: scopedRestaurantId,
      startDate: previousRange.startDate,
      endDate: previousRange.endDate
    })
  ]);

  const orderMatch = buildOrderMatch({
    restaurantId: scopedRestaurantId,
    startDate: resolvedRange.startDate,
    endDate: resolvedRange.endDate
  });
  const expenseMatch = buildExpenseMatch({
    restaurantId: scopedRestaurantId,
    startDate: resolvedRange.startDate,
    endDate: resolvedRange.endDate
  });

  const [
    orderChartRows,
    expenseChartRows,
    channelRows,
    expenseRows,
    topItemPayload,
    latestOrders,
    latestExpenses
  ] = await Promise.all([
    Order.aggregate([
      { $match: orderMatch },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: REPORT_TIMEZONE
            }
          },
          revenue: { $sum: buildOrderAmountExpr() }
        }
      }
    ]),
    Expense.aggregate([
      { $match: expenseMatch },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: REPORT_TIMEZONE
            }
          },
          expenses: { $sum: "$amount" }
        }
      }
    ]),
    Order.aggregate([
      { $match: orderMatch },
      {
        $group: {
          _id: buildChannelExpr(),
          revenue: { $sum: buildOrderAmountExpr() },
          orders: { $sum: 1 }
        }
      }
    ]),
    Expense.aggregate([
      { $match: expenseMatch },
      {
        $project: {
          amount: { $ifNull: ["$amount", 0] },
          categoryLower: { $toLower: { $ifNull: ["$category", ""] } }
        }
      },
      {
        $addFields: {
          bucket: {
            $switch: {
              branches: [
                {
                  case: {
                    $regexMatch: {
                      input: "$categoryLower",
                      regex: "raw|ingredient|material|supply"
                    }
                  },
                  then: "Raw Materials"
                },
                {
                  case: {
                    $regexMatch: {
                      input: "$categoryLower",
                      regex: "pack|box|container"
                    }
                  },
                  then: "Packaging"
                },
                {
                  case: {
                    $regexMatch: {
                      input: "$categoryLower",
                      regex: "staff|salary|wage|payroll"
                    }
                  },
                  then: "Staff"
                },
                {
                  case: {
                    $regexMatch: {
                      input: "$categoryLower",
                      regex: "rent|lease"
                    }
                  },
                  then: "Rent"
                },
                {
                  case: {
                    $regexMatch: {
                      input: "$categoryLower",
                      regex: "utility|electric|water|gas|internet"
                    }
                  },
                  then: "Utilities"
                }
              ],
              default: "Others"
            }
          }
        }
      },
      {
        $group: {
          _id: "$bucket",
          amount: { $sum: "$amount" }
        }
      }
    ]),
    getTopItems({
      restaurantId: scopedRestaurantId,
      startDate: resolvedRange.startDate,
      endDate: resolvedRange.endDate
    }),
    Order.find(orderMatch)
      .sort({ createdAt: -1 })
      .limit(14)
      .select("_id invoiceNumber totalAmount grandTotal createdAt orderChannel paymentMode"),
    Expense.find(expenseMatch)
      .sort({ createdAt: -1 })
      .limit(14)
      .select("_id category amount description createdAt")
  ]);

  const cogs = toNumber(topItemPayload.totalCogs);
  const operatingExpenses = toNumber(currentTotals.expenses);
  const totalCost = cogs + operatingExpenses;
  const netProfit = currentTotals.revenue - currentTotals.expenses;
  const margin = currentTotals.revenue > 0 ? (netProfit / currentTotals.revenue) * 100 : 0;
  const avgOrderProfit = currentTotals.totalOrders > 0 ? netProfit / currentTotals.totalOrders : 0;

  const trends = {
    revenue: computeTrend(currentTotals.revenue, previousTotals.revenue),
    expenses: computeTrend(currentTotals.expenses, previousTotals.expenses),
    netProfit: computeTrend(netProfit, previousTotals.netProfit),
    profitMargin: computeTrend(margin, previousTotals.margin),
    avgOrderProfit: computeTrend(avgOrderProfit, previousTotals.avgOrderProfit),
    totalOrders: computeTrend(currentTotals.totalOrders, previousTotals.totalOrders),
    avgOrderValue: computeTrend(currentTotals.avgOrderValue, previousTotals.avgOrderValue),
    cogs: computeTrend(cogs, 0),
    operatingExpenses: computeTrend(operatingExpenses, previousTotals.expenses)
  };

  const channels = buildChannelRows({
    rows: channelRows,
    revenue: currentTotals.revenue,
    totalCost
  });

  const expenses = buildExpenseRows(expenseRows, operatingExpenses);
  const chart = buildChartSeries({
    range: resolvedRange,
    orderRows: orderChartRows,
    expenseRows: expenseChartRows
  });
  const transactions = buildTransactions({
    orders: latestOrders.map((order) => ({
      _id: order._id,
      invoiceNumber: order.invoiceNumber,
      totalAmount: toNumber(order.totalAmount || order.grandTotal),
      createdAt: order.createdAt,
      orderChannel: order.orderChannel,
      paymentMode: order.paymentMode
    })),
    expenses: latestExpenses.map((expense) => ({
      _id: expense._id,
      amount: toNumber(expense.amount),
      category: expense.category,
      description: expense.description,
      createdAt: expense.createdAt
    }))
  });
  const insights = buildInsights({
    trends,
    channels,
    topItems: topItemPayload.topItems
  });

  return {
    meta: {
      rangeKey: resolvedRange.key,
      label: resolvedRange.label,
      startDate: resolvedRange.startDate.toISOString(),
      endDate: resolvedRange.endDate.toISOString(),
      days: resolvedRange.days
    },
    kpis: {
      revenue: roundMetric(currentTotals.revenue),
      expenses: roundMetric(currentTotals.expenses),
      netProfit: roundMetric(netProfit),
      profitMargin: roundMetric(margin, 1),
      avgOrderProfit: roundMetric(avgOrderProfit),
      totalOrders: Math.max(0, Math.round(currentTotals.totalOrders)),
      avgOrderValue: roundMetric(currentTotals.avgOrderValue),
      cogs: roundMetric(cogs),
      operatingExpenses: roundMetric(operatingExpenses),
      trends
    },
    chart,
    channels,
    expenses,
    topItems: topItemPayload.topItems,
    transactions,
    insights
  };
}

module.exports = {
  getFinanceOverviewData
};
