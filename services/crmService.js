const Customer = require("../models/Customer");
const Campaign = require("../models/Campaign");
const MenuItem = require("../models/MenuItem");
const Message = require("../models/Message");
const Order = require("../models/Order");
const { getTenantRestaurantId, withTenantDocFilter, withTenantFilter } = require("../utils/tenantScope");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_DAYS = 7;
const INACTIVE_WINDOW_DAYS = 30;
const NEW_CUSTOMER_WINDOW_DAYS = 30;
const HIGH_VALUE_THRESHOLD = 3000;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const normalizeText = (value = "") => String(value || "").trim();
const normalizeUpper = (value = "") => normalizeText(value).toUpperCase();
const escapeRegex = (value = "") => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundCurrency = (value) => Number(toNumber(value).toFixed(2));

const normalizePhone = (value = "") => {
  return String(value || "").replace(/[^\d]/g, "").slice(-10);
};

const normalizePlatform = (value = "") => {
  const normalized = normalizeUpper(value);

  if (normalized.includes("SWIGGY")) {
    return "Swiggy";
  }

  if (normalized.includes("ZOMATO")) {
    return "Zomato";
  }

  return "Direct";
};

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const addDays = (value, days) => {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
};

const daysSince = (value) => {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor((Date.now() - new Date(value).getTime()) / DAY_IN_MS);
};

const getAudienceLabel = (audience = "ALL") => {
  const normalized = normalizeUpper(audience);
  if (normalized === "HIGH_VALUE") return "High Value";
  if (normalized === "FREQUENT") return "Frequent";
  if (normalized === "AT_RISK") return "At Risk";
  if (normalized === "LOST") return "Lost";
  if (normalized === "DIRECT") return "Direct";
  if (normalized === "SWIGGY") return "Swiggy";
  if (normalized === "ZOMATO") return "Zomato";
  return "All Customers";
};

const getInitials = (name = "") => {
  const tokens = normalizeText(name).split(/\s+/).filter(Boolean);
  const first = tokens[0]?.[0] || "C";
  const second = tokens[1]?.[0] || tokens[0]?.[1] || "";
  return `${first}${second}`.toUpperCase();
};

const formatDateKey = (value) => {
  return startOfDay(value).toISOString().slice(0, 10);
};

const formatShortDate = (value) => {
  if (!value) {
    return "";
  }

  return new Date(value).toISOString().slice(0, 10);
};

const getTimeBucket = (value) => {
  const hour = new Date(value).getHours();

  if (hour < 11) return "Breakfast";
  if (hour < 15) return "Lunch";
  if (hour < 19) return "Evening";
  if (hour < 23) return "Dinner";
  return "Late Night";
};

const getSortDirection = (value = "desc") => (normalizeUpper(value) === "ASC" ? 1 : -1);

const buildCustomerSearchFilter = (search = "") => {
  const term = normalizeText(search);
  if (!term) {
    return {};
  }

  const phone = normalizePhone(term);
  const regex = new RegExp(escapeRegex(term), "i");
  const phoneRegex = phone ? new RegExp(`${escapeRegex(phone)}$`) : null;

  return {
    $or: [
      { name: regex },
      { email: regex },
      { phone: regex },
      ...(phoneRegex ? [{ phone: phoneRegex }] : [])
    ]
  };
};

const buildCustomerOrderFilter = (customer = {}, includeHistory = false) => {
  const clauses = [];
  const customerId = customer?._id ? String(customer._id) : "";
  const phone = normalizePhone(customer?.phone);

  if (customerId) {
    clauses.push({ customerId });
  }

  if (phone) {
    clauses.push({
      customerPhone: {
        $regex: new RegExp(`${escapeRegex(phone)}$`)
      }
    });
    clauses.push({
      "customer.phone": {
        $regex: new RegExp(`${escapeRegex(phone)}$`)
      }
    });
  }

  if (!clauses.length) {
    return null;
  }

  const filter = { $or: clauses };
  if (!includeHistory) {
    filter.createdAt = { $gte: addDays(new Date(), -180) };
  }

  return filter;
};

const buildCustomerOrderMaps = (customers = [], orders = []) => {
  const byId = new Map();
  const byPhone = new Map();

  orders.forEach((order) => {
    const orderId = String(order?._id || "");
    const customerId = String(order?.customerId || "");
    const phone = normalizePhone(order?.customerPhone || order?.customer?.phone);

    if (customerId) {
      if (!byId.has(customerId)) {
        byId.set(customerId, new Map());
      }
      byId.get(customerId).set(orderId, order);
    }

    if (phone) {
      if (!byPhone.has(phone)) {
        byPhone.set(phone, new Map());
      }
      byPhone.get(phone).set(orderId, order);
    }
  });

  return customers.reduce((acc, customer) => {
    const customerId = String(customer?._id || "");
    const phone = normalizePhone(customer?.phone);
    const combined = new Map();

    (byId.get(customerId) || new Map()).forEach((value, key) => combined.set(key, value));
    (byPhone.get(phone) || new Map()).forEach((value, key) => combined.set(key, value));

    acc.set(customerId, Array.from(combined.values()).sort(
      (left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()
    ));
    return acc;
  }, new Map());
};

const buildCategoryLookup = async (req, orders = []) => {
  const menuIds = Array.from(
    new Set(
      orders.flatMap((order) =>
        (order.items || [])
          .map((item) => String(item?.menuItemId || item?.menuId || ""))
          .filter(Boolean)
      )
    )
  );

  if (!menuIds.length) {
    return new Map();
  }

  const menuItems = await MenuItem.find(
    withTenantFilter(req, { _id: { $in: menuIds } })
  ).select("_id category").lean();

  return new Map(menuItems.map((item) => [String(item._id), normalizeText(item.category) || "General"]));
};

const getTopItems = (customer = {}, orders = []) => {
  const counts = new Map();

  (customer.favoriteDishes || []).forEach((dish) => {
    const name = normalizeText(dish?.name);
    if (!name) {
      return;
    }
    counts.set(name, Math.max(toNumber(dish?.orderCount), Number(counts.get(name) || 0)));
  });

  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const name = normalizeText(item?.displayName || item?.name);
      const quantity = Math.max(1, toNumber(item?.quantity, 1));
      if (!name) {
        return;
      }

      counts.set(name, Number(counts.get(name) || 0) + quantity);
    });
  });

  return Array.from(counts.entries())
    .map(([name, orderCount]) => ({ name, orderCount }))
    .sort((left, right) => right.orderCount - left.orderCount)
    .slice(0, 5);
};

const getFavoriteCategory = (orders = [], categoryLookup = new Map()) => {
  const counts = new Map();

  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const menuItemId = String(item?.menuItemId || item?.menuId || "");
      const category = categoryLookup.get(menuItemId) || "General";
      const quantity = Math.max(1, toNumber(item?.quantity, 1));
      counts.set(category, Number(counts.get(category) || 0) + quantity);
    });
  });

  const topCategory = Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0];
  return topCategory?.[0] || "Mixed";
};

const getPreferredTime = (orders = []) => {
  const counts = new Map();

  orders.forEach((order) => {
    const bucket = getTimeBucket(order.createdAt || new Date());
    counts.set(bucket, Number(counts.get(bucket) || 0) + 1);
  });

  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || "Dinner";
};

const getRecentTimeline = (orders = []) =>
  orders.slice(0, 6).map((order) => ({
    id: String(order._id),
    orderNumber: normalizeText(order.invoiceNumber) || `#${String(order._id).slice(-6).toUpperCase()}`,
    total: roundCurrency(order.grandTotal),
    platform: normalizePlatform(order.orderChannel || order.paymentMode || order.integrationMeta?.source),
    createdAt: order.createdAt,
    items: (order.items || []).slice(0, 3).map((item) => normalizeText(item?.displayName || item?.name)).filter(Boolean)
  }));

const getOrdersByTime = (orders = []) => {
  const buckets = ["Breakfast", "Lunch", "Evening", "Dinner", "Late Night"];
  const counts = buckets.reduce((acc, bucket) => ({ ...acc, [bucket]: 0 }), {});

  orders.forEach((order) => {
    const bucket = getTimeBucket(order.createdAt || new Date());
    counts[bucket] += 1;
  });

  return buckets.map((bucket) => ({
    name: bucket,
    value: counts[bucket]
  }));
};

const getSpendingTrend = (orders = []) => {
  const points = new Map();

  orders.slice().reverse().forEach((order) => {
    const key = formatDateKey(order.createdAt || new Date());
    const current = points.get(key) || { date: key, total: 0, orders: 0 };
    current.total += roundCurrency(order.grandTotal);
    current.orders += 1;
    points.set(key, current);
  });

  return Array.from(points.values()).slice(-8);
};

const getFrequencyLabel = (totalOrders, firstActivityAt, lastOrderAt) => {
  if (!totalOrders || !firstActivityAt || !lastOrderAt) {
    return "Low";
  }

  const activeDays = Math.max(1, Math.ceil((new Date(lastOrderAt).getTime() - new Date(firstActivityAt).getTime()) / DAY_IN_MS));
  const ordersPerMonth = (totalOrders / activeDays) * 30;

  if (ordersPerMonth >= 6) return "Very High";
  if (ordersPerMonth >= 3) return "High";
  if (ordersPerMonth >= 1.5) return "Medium";
  return "Low";
};

const getStatus = (lastOrderAt) => {
  const gap = daysSince(lastOrderAt);
  if (gap > INACTIVE_WINDOW_DAYS) return "Inactive";
  if (gap > ACTIVE_WINDOW_DAYS) return "At Risk";
  return "Active";
};

const getSegment = ({ totalSpend = 0, totalOrders = 0, lastOrderAt }) => {
  const gap = daysSince(lastOrderAt);

  if (totalSpend >= HIGH_VALUE_THRESHOLD) return "High Value";
  if (gap > INACTIVE_WINDOW_DAYS) return "Lost";
  if (gap > ACTIVE_WINDOW_DAYS) return "At Risk";
  if (totalOrders >= 3) return "Frequent";
  return "Frequent";
};

const getTags = ({ segment, status, totalOrders, totalSpend, repeatRate }) => {
  const nextTags = new Set();

  nextTags.add(segment);

  if (status === "Active") {
    nextTags.add("Regular");
  }

  if (status === "At Risk" || status === "Inactive") {
    nextTags.add("Needs Attention");
  }

  if (totalSpend >= HIGH_VALUE_THRESHOLD) {
    nextTags.add("VIP");
  }

  if (totalOrders >= 5 || repeatRate >= 60) {
    nextTags.add("Repeat Buyer");
  }

  return Array.from(nextTags).slice(0, 4);
};

const getChurnRisk = (status, repeatRate) => {
  if (status === "Inactive") return "High";
  if (status === "At Risk") return "Medium";
  if (repeatRate >= 50) return "Low";
  return "Medium";
};

const getNextBestAction = (segment, status) => {
  if (status === "Inactive") {
    return "Send a comeback offer with a strong expiry window.";
  }

  if (status === "At Risk") {
    return "Trigger a reminder campaign at the customer's preferred ordering hour.";
  }

  if (segment === "High Value") {
    return "Offer a premium upsell bundle and loyalty reward.";
  }

  return "Recommend a repeat-order bundle based on recent favorites.";
};

const getPersonalizedOffers = (snapshot) => {
  const offers = [];

  if (snapshot.segment === "High Value") {
    offers.push("Priority delivery perk");
  }
  if (snapshot.status === "At Risk" || snapshot.status === "Inactive") {
    offers.push("Limited-time win-back discount");
  }
  if (snapshot.platform === "Direct") {
    offers.push("Direct order cashback");
  } else {
    offers.push("Platform-exclusive combo");
  }

  offers.push("Favorite item add-on upgrade");
  return offers.slice(0, 3);
};

const buildCustomerSnapshot = ({ customer, orders, categoryLookup, messages }) => {
  const fallbackOrderHistory = Array.isArray(customer.orderHistory) ? customer.orderHistory : [];
  const fallbackTotalOrders = Math.max(
    toNumber(customer.totalOrders),
    toNumber(customer.orderCount),
    fallbackOrderHistory.length
  );
  const fallbackTotalSpend = Math.max(
    toNumber(customer.totalSpend),
    toNumber(customer.lifetimeValue),
    fallbackOrderHistory.reduce((sum, item) => sum + toNumber(item?.totalAmount), 0)
  );
  const recentOrderRevenue = orders.reduce((sum, order) => sum + toNumber(order.grandTotal), 0);
  const totalOrders = Math.max(fallbackTotalOrders, orders.length);
  const totalSpend = Math.max(fallbackTotalSpend, recentOrderRevenue);
  const avgOrderValue = totalOrders ? roundCurrency(totalSpend / totalOrders) : 0;
  const lastOrderAt = customer.lastOrderAt || orders[0]?.createdAt || null;
  const firstActivityAt =
    customer.firstOrderAt ||
    customer.createdAt ||
    orders[orders.length - 1]?.createdAt ||
    fallbackOrderHistory[fallbackOrderHistory.length - 1]?.orderedAt ||
    null;
  const repeatOrders = Math.max(0, totalOrders - 1);
  const repeatRate = totalOrders ? Number(((repeatOrders / totalOrders) * 100).toFixed(1)) : 0;
  const segment =
    normalizeText(customer.segment) ||
    getSegment({ totalSpend, totalOrders, lastOrderAt });
  const status = normalizeText(customer.status) || getStatus(lastOrderAt);
  const platform =
    normalizeText(customer.platform) ||
    normalizePlatform(
      orders[0]?.orderChannel || orders[0]?.paymentMode || orders[0]?.integrationMeta?.source
    );
  const favoriteItems = getTopItems(customer, orders);
  const preferredTime = getPreferredTime(orders);
  const favoriteCategory = getFavoriteCategory(orders, categoryLookup);
  const outboundMessages = messages.filter((message) => normalizeText(message.from) === "business");
  const inboundMessages = messages.filter((message) => normalizeText(message.from) === "customer");
  const responseRate = outboundMessages.length
    ? Number(((inboundMessages.length / outboundMessages.length) * 100).toFixed(1))
    : 0;

  const snapshot = {
    id: String(customer._id),
    customerCode: `CUST-${String(customer._id).slice(-6).toUpperCase()}`,
    name: normalizeText(customer.name) || "Guest Customer",
    avatar: getInitials(customer.name),
    phone: normalizeText(customer.phone),
    email: normalizeText(customer.email),
    segment,
    totalOrders,
    totalSpend: roundCurrency(totalSpend),
    avgOrderValue,
    lastOrderAt,
    platform,
    status,
    tags: Array.isArray(customer.tags) && customer.tags.length
      ? customer.tags.filter(Boolean).slice(0, 4)
      : getTags({ segment, status, totalOrders, totalSpend, repeatRate }),
    joinedAt: customer.createdAt || firstActivityAt || null,
    repeatRate,
    orderFrequency: getFrequencyLabel(totalOrders, firstActivityAt, lastOrderAt),
    preferredTime,
    favoriteCategory,
    favoriteItems,
    addresses: [normalizeText(customer.address)].filter(Boolean),
    notes: normalizeText(customer.notes),
    spendingTrend: getSpendingTrend(orders),
    ordersByTime: getOrdersByTime(orders),
    orderTimeline: getRecentTimeline(orders),
    orderHistory: orders.map((order) => ({
      id: String(order._id),
      invoiceNumber: normalizeText(order.invoiceNumber) || `#${String(order._id).slice(-6).toUpperCase()}`,
      createdAt: order.createdAt,
      total: roundCurrency(order.grandTotal),
      status: normalizeText(order.status) || "Delivered",
      platform: normalizePlatform(order.orderChannel || order.paymentMode || order.integrationMeta?.source),
      items: (order.items || []).map((item) => ({
        name: normalizeText(item?.displayName || item?.name),
        quantity: toNumber(item?.quantity, 1),
        price: roundCurrency(item?.price)
      }))
    })),
    engagement: {
      messagesSent: outboundMessages.length,
      offersRedeemed: orders.filter((order) => normalizeText(order.couponCode)).length,
      responseRate,
      lastMessageAt: messages[0]?.createdAt || null
    }
  };

  snapshot.insights = {
    nextBestAction: getNextBestAction(snapshot.segment, snapshot.status),
    orderPrediction:
      snapshot.status === "Active"
        ? `Likely to place another ${snapshot.preferredTime.toLowerCase()} order within 5 days.`
        : "Requires a reactivation nudge before the next expected order.",
    churnRisk: getChurnRisk(snapshot.status, snapshot.repeatRate),
    recommendedItems: snapshot.favoriteItems.map((item) => item.name).slice(0, 3),
    personalizedOffers: getPersonalizedOffers(snapshot)
  };

  return snapshot;
};

const loadMessagesByCustomer = async (req, customers = []) => {
  const filters = customers
    .map((customer) => {
      const phone = normalizePhone(customer?.phone);
      const customerId = String(customer?._id || "");

      if (!phone && !customerId) {
        return null;
      }

      const clauses = [];
      if (customerId) {
        clauses.push({ customerId });
      }
      if (phone) {
        clauses.push({
          phone: {
            $regex: new RegExp(`${escapeRegex(phone)}$`)
          }
        });
      }

      return clauses.length ? { $or: clauses } : null;
    })
    .filter(Boolean);

  if (!filters.length) {
    return new Map();
  }

  const messages = await Message.find(
    withTenantFilter(req, { $or: filters })
  )
    .sort({ createdAt: -1 })
    .lean();

  const messageMap = new Map(customers.map((customer) => [String(customer._id), []]));

  messages.forEach((message) => {
    const messageCustomerId = String(message.customerId || "");
    const phone = normalizePhone(message.phone);

    customers.forEach((customer) => {
      const customerId = String(customer._id || "");
      if (messageCustomerId && messageCustomerId === customerId) {
        messageMap.get(customerId)?.push(message);
        return;
      }

      if (phone && phone === normalizePhone(customer.phone)) {
        messageMap.get(customerId)?.push(message);
      }
    });
  });

  return messageMap;
};

const loadRecentOrdersForCustomers = async (req, customers = [], includeHistory = false) => {
  const customerFilters = customers
    .map((customer) => buildCustomerOrderFilter(customer, includeHistory))
    .filter(Boolean);

  if (!customerFilters.length) {
    return [];
  }

  return Order.find(
    withTenantFilter(req, { $or: customerFilters })
  )
    .select(
      "_id invoiceNumber createdAt grandTotal orderChannel paymentMode integrationMeta customerId customerPhone customer items couponCode status"
    )
    .sort({ createdAt: -1 })
    .lean();
};

const buildCustomerSnapshots = async (req, customers = [], options = {}) => {
  if (!customers.length) {
    return [];
  }

  const [orders, messageMap] = await Promise.all([
    loadRecentOrdersForCustomers(req, customers, Boolean(options.includeHistory)),
    options.includeMessages ? loadMessagesByCustomer(req, customers) : Promise.resolve(new Map())
  ]);
  const orderMap = buildCustomerOrderMaps(customers, orders);
  const categoryLookup = await buildCategoryLookup(req, orders);

  return customers.map((customer) =>
    buildCustomerSnapshot({
      customer,
      orders: orderMap.get(String(customer._id)) || [],
      categoryLookup,
      messages: messageMap.get(String(customer._id)) || []
    })
  );
};

const filterCustomerSnapshots = (items = [], filters = {}) => {
  const segment = normalizeText(filters.segment);
  const status = normalizeText(filters.status);
  const platform = normalizeText(filters.platform);
  const lastOrder = normalizeUpper(filters.lastOrder);

  return items.filter((item) => {
    if (segment && item.segment !== segment) {
      return false;
    }

    if (status && item.status !== status) {
      return false;
    }

    if (platform && item.platform !== platform) {
      return false;
    }

    if (lastOrder === "7D" && daysSince(item.lastOrderAt) > 7) {
      return false;
    }

    if (lastOrder === "30D" && daysSince(item.lastOrderAt) > 30) {
      return false;
    }

    if (lastOrder === "90D" && daysSince(item.lastOrderAt) > 90) {
      return false;
    }

    return true;
  });
};

const sortCustomerSnapshots = (items = [], sortBy = "lastOrderAt", sortDir = "desc") => {
  const direction = getSortDirection(sortDir);
  const valueMap = {
    customer: (item) => normalizeUpper(item.name),
    totalSpend: (item) => item.totalSpend,
    avgOrderValue: (item) => item.avgOrderValue,
    totalOrders: (item) => item.totalOrders,
    lastOrderAt: (item) => new Date(item.lastOrderAt || 0).getTime(),
    platform: (item) => normalizeUpper(item.platform),
    segment: (item) => normalizeUpper(item.segment),
    status: (item) => normalizeUpper(item.status)
  };

  const getter = valueMap[sortBy] || valueMap.lastOrderAt;

  return items.slice().sort((left, right) => {
    const leftValue = getter(left);
    const rightValue = getter(right);

    if (leftValue < rightValue) return -1 * direction;
    if (leftValue > rightValue) return 1 * direction;
    return 0;
  });
};

const paginate = (items = [], page = DEFAULT_PAGE, pageSize = DEFAULT_PAGE_SIZE) => {
  const safePage = Math.max(DEFAULT_PAGE, toNumber(page, DEFAULT_PAGE));
  const safePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, toNumber(pageSize, DEFAULT_PAGE_SIZE)));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const currentPage = Math.min(safePage, totalPages);
  const startIndex = (currentPage - 1) * safePageSize;

  return {
    items: items.slice(startIndex, startIndex + safePageSize),
    pagination: {
      page: currentPage,
      pageSize: safePageSize,
      totalItems,
      totalPages
    }
  };
};

const buildAudienceFilter = (audience = "ALL") => {
  const normalized = normalizeUpper(audience);

  return (customer) => {
    if (normalized === "HIGH_VALUE") return customer.segment === "High Value";
    if (normalized === "FREQUENT") return customer.segment === "Frequent";
    if (normalized === "AT_RISK") return customer.status === "At Risk";
    if (normalized === "LOST") return customer.status === "Inactive" || customer.segment === "Lost";
    if (normalized === "DIRECT") return customer.platform === "Direct";
    if (normalized === "SWIGGY") return customer.platform === "Swiggy";
    if (normalized === "ZOMATO") return customer.platform === "Zomato";
    return true;
  };
};

const buildCustomerTrend = (customers = [], days = 14) => {
  const start = startOfDay(addDays(new Date(), -(days - 1)));
  const points = Array.from({ length: days }, (_, index) => {
    const date = addDays(start, index);
    return {
      date: formatDateKey(date),
      customers: 0
    };
  });
  const pointMap = new Map(points.map((item) => [item.date, item]));

  customers.forEach((customer) => {
    const key = formatDateKey(customer.joinedAt || customer.createdAt || new Date());
    const point = pointMap.get(key);
    if (point) {
      point.customers += 1;
    }
  });

  return points;
};

const buildOrdersTrend = (orders = [], days = 14) => {
  const start = startOfDay(addDays(new Date(), -(days - 1)));
  const points = Array.from({ length: days }, (_, index) => {
    const date = addDays(start, index);
    return {
      date: formatDateKey(date),
      orders: 0,
      customers: 0
    };
  });
  const pointMap = new Map(points.map((item) => [item.date, item]));

  orders.forEach((order) => {
    const key = formatDateKey(order.createdAt || new Date());
    const point = pointMap.get(key);
    if (point) {
      point.orders += 1;
    }
  });

  return points;
};

const buildCustomerGrowth = (customers = []) => {
  const dailyCounts = buildCustomerTrend(customers, 14);
  let runningTotal = 0;

  return dailyCounts.map((point) => {
    runningTotal += point.customers;
    return {
      date: point.date,
      total: runningTotal
    };
  });
};

const getBestSendTime = (orders = []) => {
  return getPreferredTime(orders);
};

const formatCampaignRecord = (campaign = {}) => ({
  id: String(campaign._id),
  name: campaign.name,
  type: normalizeText(campaign.type) || "Promo",
  channel: normalizeText(campaign.channel) || "WHATSAPP",
  audience: getAudienceLabel(campaign.audience),
  sent: toNumber(campaign.metrics?.sent),
  delivered: toNumber(campaign.metrics?.delivered),
  openRate: toNumber(campaign.metrics?.delivered)
    ? Number(
        ((toNumber(campaign.metrics?.opened) / toNumber(campaign.metrics?.delivered)) * 100).toFixed(1)
      )
    : 0,
  ctr: toNumber(campaign.metrics?.opened)
    ? Number(((toNumber(campaign.metrics?.clicked) / toNumber(campaign.metrics?.opened)) * 100).toFixed(1))
    : 0,
  orders: toNumber(campaign.metrics?.orders),
  revenue: roundCurrency(campaign.metrics?.revenue),
  status: normalizeText(campaign.status) || "Sent",
  scheduledFor: campaign.scheduledFor || null,
  createdAt: campaign.createdAt
});

const createCampaignMetrics = ({ audienceCount, channel, avgOrderValue, scheduleAt }) => {
  const isScheduled = scheduleAt && new Date(scheduleAt).getTime() > Date.now();
  if (isScheduled) {
    return {
      status: "SCHEDULED",
      metrics: {
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        orders: 0,
        revenue: 0
      }
    };
  }

  const safeAudience = Math.max(0, audienceCount);
  const deliveredRate = channel === "WHATSAPP" ? 0.96 : 0.91;
  const openRate = channel === "WHATSAPP" ? 0.44 : 0.28;
  const clickRate = channel === "WHATSAPP" ? 0.18 : 0.12;
  const orderRate = channel === "WHATSAPP" ? 0.22 : 0.15;
  const delivered = Math.round(safeAudience * deliveredRate);
  const opened = Math.round(delivered * openRate);
  const clicked = Math.round(opened * clickRate);
  const orders = Math.round(clicked * orderRate);

  return {
    status: "SENT",
    metrics: {
      sent: safeAudience,
      delivered,
      opened,
      clicked,
      orders,
      revenue: roundCurrency(orders * Math.max(1, avgOrderValue))
    }
  };
};

const listCustomers = async (req, query = {}) => {
  const customers = await Customer.find(
    withTenantFilter(req, buildCustomerSearchFilter(query.search))
  )
    .sort({ createdAt: -1 })
    .lean();

  const snapshots = await buildCustomerSnapshots(req, customers);
  const filtered = filterCustomerSnapshots(snapshots, query);
  const sorted = sortCustomerSnapshots(filtered, query.sortBy, query.sortDir);
  const paginated = paginate(sorted, query.page, query.pageSize);

  return {
    items: paginated.items,
    pagination: paginated.pagination,
    filters: {
      segments: ["High Value", "Frequent", "At Risk", "Lost"],
      statuses: ["Active", "At Risk", "Inactive"],
      platforms: ["Direct", "Swiggy", "Zomato"]
    }
  };
};

const getCustomerProfile = async (req, customerId) => {
  const customer = await Customer.findOne(withTenantDocFilter(req, customerId)).lean();

  if (!customer) {
    const error = new Error("Customer not found");
    error.status = 404;
    throw error;
  }

  const [snapshot] = await buildCustomerSnapshots(req, [customer], {
    includeHistory: true,
    includeMessages: true
  });

  return snapshot;
};

const createCustomer = async (req, payload = {}) => {
  const restaurantId = getTenantRestaurantId(req);
  const name = normalizeText(payload.name);
  const phone = normalizeText(payload.phone);

  if (!restaurantId) {
    const error = new Error("Tenant restaurant is required");
    error.status = 400;
    throw error;
  }

  if (!name || !phone) {
    const error = new Error("Customer name and phone are required");
    error.status = 400;
    throw error;
  }

  const created = await Customer.create({
    restaurantId,
    name,
    phone,
    email: normalizeText(payload.email),
    segment: normalizeText(payload.segment),
    platform: normalizeText(payload.platform),
    status: normalizeText(payload.status),
    tags: Array.isArray(payload.tags)
      ? payload.tags.map((tag) => normalizeText(tag)).filter(Boolean).slice(0, 6)
      : [],
    address: normalizeText(payload.address),
    notes: normalizeText(payload.notes),
    source: "crm"
  });

  return getCustomerProfile(req, created._id);
};

const updateCustomer = async (req, customerId, payload = {}) => {
  const updates = {
    name: normalizeText(payload.name),
    phone: normalizeText(payload.phone),
    email: normalizeText(payload.email),
    segment: normalizeText(payload.segment),
    platform: normalizeText(payload.platform),
    status: normalizeText(payload.status),
    tags: Array.isArray(payload.tags)
      ? payload.tags.map((tag) => normalizeText(tag)).filter(Boolean).slice(0, 6)
      : undefined,
    address: normalizeText(payload.address),
    notes: normalizeText(payload.notes)
  };

  Object.keys(updates).forEach((key) => {
    if (updates[key] === "" || updates[key] === undefined) {
      delete updates[key];
    }
  });

  const updated = await Customer.findOneAndUpdate(
    withTenantDocFilter(req, customerId),
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  if (!updated) {
    const error = new Error("Customer not found");
    error.status = 404;
    throw error;
  }

  return getCustomerProfile(req, customerId);
};

const getAnalytics = async (req) => {
  const [customers, orders, campaigns] = await Promise.all([
    Customer.find(withTenantFilter(req)).lean(),
    Order.find(
      withTenantFilter(req, { createdAt: { $gte: addDays(new Date(), -90) } })
    )
      .select("_id createdAt grandTotal orderChannel paymentMode integrationMeta customerId customerPhone customer items couponCode")
      .sort({ createdAt: -1 })
      .lean(),
    Campaign.find(withTenantFilter(req)).sort({ createdAt: -1 }).limit(25).lean()
  ]);

  const customerSnapshots = await buildCustomerSnapshots(req, customers);
  const ordersTrend = buildOrdersTrend(orders, 14);
  const customerTrend = buildCustomerTrend(customerSnapshots, 14);

  ordersTrend.forEach((point, index) => {
    point.customers = customerTrend[index]?.customers || 0;
  });

  const totalRevenue = customerSnapshots.reduce((sum, item) => sum + item.totalSpend, 0);
  const totalOrders = customerSnapshots.reduce((sum, item) => sum + item.totalOrders, 0);
  const totalRepeatOrders = customerSnapshots.reduce(
    (sum, item) => sum + Math.max(0, item.totalOrders - 1),
    0
  );
  const activeCustomers = customerSnapshots.filter((item) => item.status === "Active").length;
  const newCustomers = customerSnapshots.filter(
    (item) => daysSince(item.joinedAt) <= NEW_CUSTOMER_WINDOW_DAYS
  ).length;
  const repeatRate = totalOrders ? Number(((totalRepeatOrders / totalOrders) * 100).toFixed(1)) : 0;
  const avgOrderValue = totalOrders ? roundCurrency(totalRevenue / totalOrders) : 0;
  const customerLtv = customerSnapshots.length ? roundCurrency(totalRevenue / customerSnapshots.length) : 0;

  const revenueBySegment = ["High Value", "Frequent", "At Risk", "Lost"].map((segment) => ({
    name: segment,
    revenue: roundCurrency(
      customerSnapshots
        .filter((item) => item.segment === segment)
        .reduce((sum, item) => sum + item.totalSpend, 0)
    )
  }));

  const platformDistribution = ["Direct", "Swiggy", "Zomato"].map((platform) => ({
    name: platform,
    value: customerSnapshots.filter((item) => item.platform === platform).length
  }));

  const marketingSent = campaigns.reduce((sum, campaign) => sum + toNumber(campaign.metrics?.sent), 0);
  const marketingDelivered = campaigns.reduce(
    (sum, campaign) => sum + toNumber(campaign.metrics?.delivered),
    0
  );
  const marketingOpened = campaigns.reduce(
    (sum, campaign) => sum + toNumber(campaign.metrics?.opened),
    0
  );
  const marketingClicked = campaigns.reduce(
    (sum, campaign) => sum + toNumber(campaign.metrics?.clicked),
    0
  );
  const marketingOrders = campaigns.reduce((sum, campaign) => sum + toNumber(campaign.metrics?.orders), 0);
  const marketingRevenue = campaigns.reduce(
    (sum, campaign) => sum + toNumber(campaign.metrics?.revenue),
    0
  );
  const bestCampaign = campaigns
    .slice()
    .sort((left, right) => toNumber(right.metrics?.revenue) - toNumber(left.metrics?.revenue))[0] || null;

  return {
    customerOverview: {
      metrics: {
        totalCustomers: customerSnapshots.length,
        activeCustomers,
        newCustomers,
        repeatRate,
        avgOrderValue,
        customerLtv
      },
      charts: {
        ordersVsCustomers: ordersTrend,
        customerGrowth: buildCustomerGrowth(customerSnapshots),
        revenueBySegment,
        platformDistribution
      },
      insights: {
        highRepeatPotential: customerSnapshots
          .filter((item) => item.status === "Active" && item.totalOrders >= 2)
          .slice(0, 3)
          .map((item) => item.name),
        atRiskCustomers: customerSnapshots.filter((item) => item.status === "At Risk").length,
        bestTimeToEngage: getBestSendTime(orders),
        revenueOpportunities:
          revenueBySegment.find((item) => item.name === "High Value")?.revenue || 0
      }
    },
    marketingOverview: {
      metrics: {
        campaigns: campaigns.length,
        messagesSent: marketingSent,
        delivered: marketingDelivered,
        openRate: marketingDelivered
          ? Number(((marketingOpened / marketingDelivered) * 100).toFixed(1))
          : 0,
        clickRate: marketingOpened
          ? Number(((marketingClicked / marketingOpened) * 100).toFixed(1))
          : 0,
        conversions: marketingOrders,
        revenue: roundCurrency(marketingRevenue)
      },
      performance: campaigns.slice(0, 6).reverse().map((campaign) => ({
        name: campaign.name,
        sent: toNumber(campaign.metrics?.sent),
        opened: toNumber(campaign.metrics?.opened),
        revenue: roundCurrency(campaign.metrics?.revenue)
      })),
      bestCampaign: bestCampaign
        ? {
            id: String(bestCampaign._id),
            name: bestCampaign.name,
            revenue: roundCurrency(bestCampaign.metrics?.revenue),
            ctr: toNumber(bestCampaign.metrics?.opened)
              ? Number(
                  ((toNumber(bestCampaign.metrics?.clicked) / toNumber(bestCampaign.metrics?.opened)) * 100).toFixed(1)
                )
              : 0
          }
        : null,
      bestSendingTime: getBestSendTime(orders),
      recommendations: [
        "Re-engage at-risk customers with dinner offers.",
        "Push loyalty rewards to high-value repeat buyers.",
        "Cross-sell favorite items through WhatsApp bundles."
      ]
    }
  };
};

const listCampaigns = async (req) => {
  const campaigns = await Campaign.find(withTenantFilter(req))
    .sort({ createdAt: -1 })
    .lean();

  return campaigns.map(formatCampaignRecord);
};

const createCampaign = async (req, payload = {}) => {
  const restaurantId = getTenantRestaurantId(req);
  const name = normalizeText(payload.name);
  const channel = normalizeUpper(payload.channel || "WHATSAPP");
  const type = normalizeUpper(payload.type || "PROMO");
  const audience = normalizeUpper(payload.audience || "ALL");
  const message = normalizeText(payload.message);
  const scheduledFor = payload.scheduledFor ? new Date(payload.scheduledFor) : null;

  if (!name || !message) {
    const error = new Error("Campaign name and message are required");
    error.status = 400;
    throw error;
  }

  if (!["WHATSAPP", "SMS"].includes(channel)) {
    const error = new Error("Channel must be WHATSAPP or SMS");
    error.status = 400;
    throw error;
  }

  const customers = await Customer.find(withTenantFilter(req)).lean();
  const snapshots = await buildCustomerSnapshots(req, customers);
  const audienceCustomers = snapshots.filter(buildAudienceFilter(audience));
  const audienceAov = audienceCustomers.length
    ? audienceCustomers.reduce((sum, customer) => sum + customer.avgOrderValue, 0) / audienceCustomers.length
    : 0;
  const simulation = createCampaignMetrics({
    audienceCount: audienceCustomers.length,
    channel,
    avgOrderValue: audienceAov,
    scheduleAt: scheduledFor
  });

  const created = await Campaign.create({
    restaurantId,
    name,
    type,
    channel,
    audience,
    message,
    scheduledFor,
    status: simulation.status,
    createdBy: req.user?.userId || null,
    metrics: simulation.metrics
  });

  return formatCampaignRecord(created.toObject());
};

module.exports = {
  createCampaign,
  createCustomer,
  getAnalytics,
  getCustomerProfile,
  listCampaigns,
  listCustomers,
  updateCustomer
};
