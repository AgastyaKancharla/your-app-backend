const { resolvePlanDefinition } = require("../config/planLimits");
const {
  APP_CONFIG,
  getDevModeUnlockedFeatures,
  getDevModeUnlockedLimits
} = require("../config/appConfig");
const { getPlanConfig, normalizeSaasPlan } = require("./subscriptionPlans");

const BUSINESS_TYPES = {
  CLOUD_KITCHEN: "CLOUD_KITCHEN",
  RESTAURANT: "RESTAURANT"
};

const BUSINESS_TYPE_LABELS = {
  [BUSINESS_TYPES.CLOUD_KITCHEN]: "Cloud Kitchen",
  [BUSINESS_TYPES.RESTAURANT]: "Restaurant"
};

const PLAN_ORDER = ["STARTER", "GROWTH", "PRO", "ENTERPRISE"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MODULE_DEFINITIONS = [
  {
    key: "MENU_MANAGEMENT",
    label: "Menu Management",
    pageKey: "MENU_MANAGEMENT",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "menuManagement",
    why: "Both workspace types manage dishes, variants, and pricing."
  },
  {
    key: "ORDER_LIST",
    label: "Order List",
    pageKey: "POS",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "orders",
    why: "Both workspace types need one place to create and review orders."
  },
  {
    key: "KITCHEN",
    label: "Kitchen Workflow",
    pageKey: "KITCHEN",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "orders",
    why: "Both workspace types need preparation flow visibility."
  },
  {
    key: "CUSTOMERS",
    label: "Customers",
    pageKey: "CUSTOMERS",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "customerCRM",
    why: "Both workspace types benefit from a customer database."
  },
  {
    key: "MARKETING",
    label: "Marketing",
    pageKey: "MARKETING",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "marketingTools",
    why: "Both workspace types run offers, loyalty, and promotions."
  },
  {
    key: "INVENTORY",
    label: "Inventory",
    pageKey: "INVENTORY",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "inventoryManagement",
    why: "Both workspace types track stock levels."
  },
  {
    key: "RECIPE_COSTING",
    label: "Recipe Costing",
    pageKey: "RECIPE_COSTING",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "recipeCosting",
    why: "Both workspace types need dish-level cost visibility."
  },
  {
    key: "EXPENSES",
    label: "Expenses",
    pageKey: "EXPENSES",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "expenseManagement",
    why: "Both workspace types have operational expenses."
  },
  {
    key: "SUPPLIERS",
    label: "Suppliers",
    pageKey: "SUPPLIERS",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "supplierManagement",
    why: "Both workspace types buy from suppliers."
  },
  {
    key: "PURCHASE_ORDERS",
    label: "Purchase Orders",
    pageKey: "PURCHASE_ORDERS",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "purchaseOrders",
    why: "Both workspace types replenish raw materials."
  },
  {
    key: "DOCUMENTS",
    label: "Documents",
    pageKey: "DOCUMENTS",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "documentVault",
    why: "Both workspace types need a secure document vault."
  },
  {
    key: "ORDER_MANAGEMENT",
    label: "Order Management",
    pageKey: "ORDER_MANAGEMENT",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN],
    feature: "orders",
    why: "Cloud kitchens run the full order dashboard from one workspace page."
  },
  {
    key: "REPORTS",
    label: "Reports",
    pageKey: "REPORTS",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "basicAnalytics",
    why: "Both workspace types rely on business insights."
  },
  {
    key: "STAFF",
    label: "Staff",
    pageKey: "STAFF",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN, BUSINESS_TYPES.RESTAURANT],
    feature: "staffManagement",
    why: "Both workspace types manage teams and roles."
  },
  {
    key: "DELIVERY_TRACKING",
    label: "Delivery Tracking",
    pageKey: "DELIVERY",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN],
    feature: "deliveryManagement",
    why: "Cloud kitchens run as delivery-first operations."
  },
  {
    key: "ONLINE_ORDER_CHANNELS",
    label: "Online Order Channels",
    pageKey: "SALES_CHANNELS",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN],
    feature: "salesChannelIntegrations",
    why: "Cloud kitchens depend on online channels like Swiggy, Zomato, and website orders."
  },
  {
    key: "PACKAGING_TRACKER",
    label: "Packaging Tracker",
    pageKey: "PACKAGING",
    businessTypes: [BUSINESS_TYPES.CLOUD_KITCHEN],
    feature: "packagingTracker",
    why: "Cloud kitchens need to monitor boxes, bags, and containers."
  },
  {
    key: "TABLES_MANAGEMENT",
    label: "Tables Management",
    pageKey: "TABLES",
    businessTypes: [BUSINESS_TYPES.RESTAURANT],
    feature: "tableManagement",
    why: "Restaurants need physical seating management."
  },
  {
    key: "TABLE_WISE_BILLING",
    label: "Table-wise Billing",
    pageKey: "POS",
    businessTypes: [BUSINESS_TYPES.RESTAURANT],
    feature: "tableManagement",
    why: "Restaurants need table-linked billing and dine-in handling."
  },
  {
    key: "WAITER_ROLES",
    label: "Waiter Roles",
    pageKey: "STAFF",
    businessTypes: [BUSINESS_TYPES.RESTAURANT],
    feature: "staffManagement",
    why: "Restaurants need waiter access for service-floor operations."
  },
  {
    key: "RESERVATION_SYSTEM",
    label: "Reservation System",
    pageKey: "RESERVATIONS",
    businessTypes: [BUSINESS_TYPES.RESTAURANT],
    feature: "reservationSystem",
    why: "Restaurants need advance table booking workflows."
  }
];

const normalizeBusinessType = (value = "", fallback = "") => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^\w]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (
    ["CLOUD_KITCHEN", "CLOUD", "KITCHEN", "CLOUDKITCHEN"].includes(normalized)
  ) {
    return BUSINESS_TYPES.CLOUD_KITCHEN;
  }

  if (
    ["RESTAURANT", "DINE_IN", "DINING", "DINER"].includes(normalized)
  ) {
    return BUSINESS_TYPES.RESTAURANT;
  }

  return fallback;
};

const formatBusinessType = (value = "") => {
  const normalized = normalizeBusinessType(value, "");
  return BUSINESS_TYPE_LABELS[normalized] || "Unknown";
};

const isPlanAtLeast = (plan, requiredPlan) => {
  const currentIndex = PLAN_ORDER.indexOf(normalizeSaasPlan(plan));
  const requiredIndex = PLAN_ORDER.indexOf(normalizeSaasPlan(requiredPlan));

  if (requiredIndex === -1) {
    return true;
  }

  if (currentIndex === -1) {
    return false;
  }

  return currentIndex >= requiredIndex;
};

const toDate = (value) => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
};

const diffDaysCeil = (from, to) => {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end) {
    return null;
  }

  return Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY);
};

const resolveWorkspaceAccess = ({
  restaurant = null,
  subscription = null,
  now = new Date()
} = {}) => {
  const normalizedNow = toDate(now) || new Date();
  const plan = normalizeSaasPlan(
    subscription?.plan || restaurant?.subscriptionPlan || "STARTER"
  );
  const businessType = normalizeBusinessType(restaurant?.businessType, "");
  const planDefinition = resolvePlanDefinition(plan);
  const features = APP_CONFIG.DEV_MODE_UNLOCK_ALL
    ? getDevModeUnlockedFeatures()
    : planDefinition.features;
  const limits = APP_CONFIG.DEV_MODE_UNLOCK_ALL
    ? getDevModeUnlockedLimits()
    : planDefinition.limits;
  const pricing = getPlanConfig(plan);

  const startDate =
    toDate(subscription?.startDate) ||
    toDate(restaurant?.createdAt) ||
    normalizedNow;
  const trialEndsAt =
    toDate(subscription?.trialEndsAt) ||
    null;
  const expiryDate =
    toDate(subscription?.expiryDate) ||
    toDate(restaurant?.subscriptionExpiry) ||
    null;

  const rawStatus = String(subscription?.status || "").trim().toUpperCase();
  const billingStatus = String(restaurant?.billingStatus || "").trim().toLowerCase();
  const hasPaidBillingStatus = ["active", "trialing", "past_due"].includes(billingStatus);

  let status = rawStatus;
  if (APP_CONFIG.DEV_MODE_UNLOCK_ALL) {
    status = "ACTIVE";
  } else {
    if (!status) {
      if (hasPaidBillingStatus) {
        status = "ACTIVE";
      } else if (trialEndsAt || expiryDate) {
        status = "TRIAL";
      } else {
        status = "ACTIVE";
      }
    }

    if (!["TRIAL", "ACTIVE", "EXPIRED", "CANCELLED"].includes(status)) {
      status = expiryDate || trialEndsAt ? "TRIAL" : "ACTIVE";
    }
  }

  const effectiveExpiryDate = APP_CONFIG.DEV_MODE_UNLOCK_ALL
    ? expiryDate || trialEndsAt
    : status === "TRIAL"
      ? trialEndsAt || expiryDate
      : expiryDate || trialEndsAt;

  if (
    !APP_CONFIG.DEV_MODE_UNLOCK_ALL &&
    ["TRIAL", "ACTIVE", "CANCELLED"].includes(status) &&
    effectiveExpiryDate &&
    effectiveExpiryDate.getTime() < normalizedNow.getTime()
  ) {
    status = "EXPIRED";
  }

  const isReadOnly = APP_CONFIG.DEV_MODE_UNLOCK_ALL
    ? false
    : status === "EXPIRED" || status === "CANCELLED";
  const daysLeft = effectiveExpiryDate
    ? diffDaysCeil(normalizedNow, effectiveExpiryDate)
    : null;
  const trialDurationDays =
    status === "TRIAL" && startDate && trialEndsAt
      ? Math.max(1, diffDaysCeil(startDate, trialEndsAt))
      : null;
  const trialDay =
    status === "TRIAL" && startDate
      ? Math.max(1, Math.floor((normalizedNow.getTime() - startDate.getTime()) / MS_PER_DAY) + 1)
      : null;

  const modules = MODULE_DEFINITIONS
    .map((module) => {
      const businessMatch = module.businessTypes.includes(businessType);
      const enabled = APP_CONFIG.DEV_MODE_UNLOCK_ALL
        ? businessMatch
        : businessMatch && Boolean(features[module.feature]);

      return {
        key: module.key,
        label: module.label,
        pageKey: module.pageKey,
        why: module.why,
        enabled,
        locked: APP_CONFIG.DEV_MODE_UNLOCK_ALL ? false : businessMatch && !enabled,
        businessTypeMatch: businessMatch
      };
    })
    .filter((module) => module.businessTypeMatch);

  const enabledPages = [
    "HOME",
    "PROFILE",
    "SUBSCRIPTION",
    ...modules.filter((module) => module.enabled && module.pageKey).map((module) => module.pageKey)
  ].filter((value, index, list) => list.indexOf(value) === index);

  const lockedPages = modules
    .filter((module) => module.locked && module.pageKey)
    .map((module) => module.pageKey)
    .filter((value, index, list) => list.indexOf(value) === index);

  return {
    plan,
    planLabel: pricing.name,
    businessType,
    businessTypeLabel: formatBusinessType(businessType),
    status,
    startDate,
    expiryDate: effectiveExpiryDate,
    trialEndsAt,
    daysLeft,
    trialDay,
    trialDurationDays,
    isReadOnly,
    accessMode: isReadOnly ? "READ_ONLY" : "FULL_ACCESS",
    features,
    limits,
    modules,
    enabledPages,
    lockedPages: APP_CONFIG.DEV_MODE_UNLOCK_ALL ? [] : lockedPages,
    canAddData: APP_CONFIG.DEV_MODE_UNLOCK_ALL ? true : !isReadOnly,
    isPlanAtLeast: (requiredPlan) =>
      APP_CONFIG.DEV_MODE_UNLOCK_ALL ? true : isPlanAtLeast(plan, requiredPlan)
  };
};

module.exports = {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  MODULE_DEFINITIONS,
  normalizeBusinessType,
  formatBusinessType,
  isPlanAtLeast,
  resolveWorkspaceAccess
};
