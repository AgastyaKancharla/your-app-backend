const PLAN_CATALOG = {
  STARTER: {
    code: "STARTER",
    name: "Starter Plan",
    monthlyPriceInr: 499,
    yearlyPriceInr: 4990,
    annualDiscountMonthsFree: 2,
    maxStaffAccounts: 1,
    features: ["orders", "menu", "customers", "basic_analytics"]
  },
  GROWTH: {
    code: "GROWTH",
    name: "Growth Plan",
    monthlyPriceInr: 999,
    yearlyPriceInr: 9990,
    annualDiscountMonthsFree: 2,
    maxStaffAccounts: 3,
    features: [
      "orders",
      "menu",
      "inventory",
      "recipe_costing",
      "expenses",
      "suppliers",
      "purchase_orders",
      "documents",
      "customer_crm",
      "staff_management",
      "marketing_tools",
      "delivery_management",
      "sales_channel_integrations",
      "packaging_tracker",
      "analytics"
    ]
  },
  PRO: {
    code: "PRO",
    name: "Pro Plan",
    monthlyPriceInr: 1999,
    yearlyPriceInr: 19990,
    annualDiscountMonthsFree: 2,
    maxStaffAccounts: -1,
    features: [
      "everything_in_growth",
      "tables_management",
      "reservation_system",
      "unlimited_staff",
      "priority_support"
    ]
  },
  ENTERPRISE: {
    code: "ENTERPRISE",
    name: "Enterprise Plan",
    monthlyPriceInr: 4999,
    yearlyPriceInr: 49990,
    annualDiscountMonthsFree: 2,
    maxStaffAccounts: -1,
    features: [
      "everything_in_pro",
      "ai_demand_prediction",
      "white_label",
      "enterprise_support"
    ]
  }
};

const PLAN_ALIASES = {
  FREE: "STARTER",
  BASIC: "GROWTH"
};

const normalizeSaasPlan = (value = "") => {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return "STARTER";
  }
  return PLAN_ALIASES[normalized] || normalized;
};

const getPlanConfig = (value = "") => {
  const plan = normalizeSaasPlan(value);
  return PLAN_CATALOG[plan] || PLAN_CATALOG.STARTER;
};

const getTrialEndDate = (startDate = new Date()) => {
  const date = new Date(startDate);
  date.setDate(date.getDate() + 14);
  return date;
};

const getPlanExpiryDate = (startDate = new Date(), months = 1) => {
  const date = new Date(startDate);
  date.setMonth(date.getMonth() + Math.max(1, Number(months) || 1));
  return date;
};

module.exports = {
  PLAN_CATALOG,
  normalizeSaasPlan,
  getPlanConfig,
  getTrialEndDate,
  getPlanExpiryDate
};
