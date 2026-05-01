const { rolesWithPermission } = require("./permissionEngine");

const USER_ROLES = {
  OWNER: "OWNER",
  MANAGER: "MANAGER",
  CASHIER: "CASHIER",
  KITCHEN: "KITCHEN",
  INVENTORY_MANAGER: "INVENTORY_MANAGER",
  DELIVERY_MANAGER: "DELIVERY_MANAGER",
  DELIVERY_PARTNER: "DELIVERY_PARTNER",
  MARKETING_MANAGER: "MARKETING_MANAGER",
  ACCOUNTANT: "ACCOUNTANT",
  WAITER: "WAITER",
  SUPER_ADMIN: "SUPER_ADMIN"
};

const ROLE_ALIASES = {
  OWNER: USER_ROLES.OWNER,
  ADMIN: USER_ROLES.OWNER,
  MANAGER: USER_ROLES.MANAGER,
  ADMIN_MANAGER: USER_ROLES.MANAGER,
  CASHIER: USER_ROLES.CASHIER,
  POS_OPERATOR: USER_ROLES.CASHIER,
  POS: USER_ROLES.CASHIER,
  KITCHEN: USER_ROLES.KITCHEN,
  CHEF: USER_ROLES.KITCHEN,
  KITCHEN_STAFF: USER_ROLES.KITCHEN,
  INVENTORY_MANAGER: USER_ROLES.INVENTORY_MANAGER,
  DELIVERY_MANAGER: USER_ROLES.DELIVERY_MANAGER,
  DELIVERY_PARTNER: USER_ROLES.DELIVERY_PARTNER,
  MARKETING_MANAGER: USER_ROLES.MARKETING_MANAGER,
  ACCOUNTANT: USER_ROLES.ACCOUNTANT,
  WAITER: USER_ROLES.WAITER,
  SERVICE_STAFF: USER_ROLES.WAITER,
  SUPER_ADMIN: USER_ROLES.SUPER_ADMIN
};

const ALL_USER_ROLES = Object.values(USER_ROLES);

const STAFF_ROLES = [
  USER_ROLES.MANAGER,
  USER_ROLES.CASHIER,
  USER_ROLES.KITCHEN,
  USER_ROLES.INVENTORY_MANAGER,
  USER_ROLES.DELIVERY_MANAGER,
  USER_ROLES.DELIVERY_PARTNER,
  USER_ROLES.MARKETING_MANAGER,
  USER_ROLES.ACCOUNTANT,
  USER_ROLES.WAITER
];

const OWNER_ONLY_ROLES = rolesWithPermission("settings.manage");
const REPORT_VIEW_ROLES = rolesWithPermission("finance.view");
const DOCUMENT_VIEW_ROLES = rolesWithPermission("documents.view");
const CUSTOMER_VIEW_ROLES = rolesWithPermission("crm.view");
const MARKETING_ROLES = Array.from(
  new Set([...rolesWithPermission("marketing.view"), ...rolesWithPermission("marketing.create")])
);
const DELIVERY_MANAGEMENT_ROLES = rolesWithPermission("dispatch.view");
const TABLE_MANAGEMENT_ROLES = rolesWithPermission("tables.view");
const RESERVATION_MANAGEMENT_ROLES = TABLE_MANAGEMENT_ROLES;
const SUPPLIER_MANAGEMENT_ROLES = rolesWithPermission("inventory.update");
const PURCHASE_ORDER_ROLES = rolesWithPermission("inventory.update");
const EXPENSE_ROLES = rolesWithPermission("expenses.view");
const INVENTORY_VIEW_ROLES = rolesWithPermission("inventory.view");
const INVENTORY_MANAGEMENT_ROLES = rolesWithPermission("inventory.update");
const MENU_VIEW_ROLES = rolesWithPermission("pos.view");
const MENU_MANAGEMENT_ROLES = rolesWithPermission("menu.manage");
const ORDER_CREATION_ROLES = rolesWithPermission("pos.create");
const ORDER_VIEW_ROLES = rolesWithPermission("orders.view");
const ORDER_STATUS_UPDATE_ROLES = rolesWithPermission("orders.update");
const RECIPE_MANAGEMENT_ROLES = rolesWithPermission("inventory.update");

const ORDER_STATUSES = ["NEW", "PREPARING", "READY", "DELIVERED"];
const CLOUD_KITCHEN_ORDER_STATUSES = ["NEW", "PREPARING", "READY", "DISPATCHED"];
const CANONICAL_ORDER_STATUSES = Array.from(
  new Set([...ORDER_STATUSES, ...CLOUD_KITCHEN_ORDER_STATUSES])
);
const EXTRA_ORDER_STATUSES = ["CANCELLED"];

const LEGACY_ORDER_STATUS_ALIASES = {
  PENDING: "NEW",
  NEW_ORDER: "NEW",
  ACCEPTED: "PREPARING",
  OUT_FOR_DELIVERY: "READY",
  COMPLETED: "DELIVERED",
  DONE: "DELIVERED"
};

const ORDER_STATUS_LEGACY_VALUES_BY_CANONICAL = Object.entries(LEGACY_ORDER_STATUS_ALIASES).reduce(
  (acc, [legacyValue, canonicalValue]) => {
    acc[canonicalValue] = [...(acc[canonicalValue] || []), legacyValue];
    return acc;
  },
  {}
);

const ALL_ORDER_STATUS_VALUES = [
  ...CANONICAL_ORDER_STATUSES,
  ...EXTRA_ORDER_STATUSES,
  ...Object.keys(LEGACY_ORDER_STATUS_ALIASES)
];

const normalizeRole = (value = "") => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\/\s-]+/g, "_")
    .replace(/_+/g, "_");

  return ROLE_ALIASES[normalized] || normalized;
};

const normalizeOrderStatus = (value, fallback = ORDER_STATUSES[0]) => {
  const normalized = String(value || "").trim().toUpperCase();

  if (!normalized) {
    return fallback;
  }

  if (LEGACY_ORDER_STATUS_ALIASES[normalized]) {
    return LEGACY_ORDER_STATUS_ALIASES[normalized];
  }

  if (normalized === "CANCELLED") {
    return "CANCELLED";
  }

  if (CANONICAL_ORDER_STATUSES.includes(normalized)) {
    return normalized;
  }

  return fallback;
};

const isKnownOrderStatusValue = (value) =>
  ALL_ORDER_STATUS_VALUES.includes(String(value || "").trim().toUpperCase());

const resolveOrderStatusFlow = (flow) => {
  if (Array.isArray(flow) && flow.length) {
    return flow;
  }

  const normalized = String(flow || "").trim().toUpperCase();
  if (normalized === "CLOUD_KITCHEN" || normalized === "CLOUD") {
    return CLOUD_KITCHEN_ORDER_STATUSES;
  }

  return ORDER_STATUSES;
};

const getOrderStatusIndex = (value, flow = ORDER_STATUSES) =>
  resolveOrderStatusFlow(flow).indexOf(normalizeOrderStatus(value, ""));

const canTransitionOrderStatus = (currentStatus, nextStatus, flow = ORDER_STATUSES) => {
  const statusFlow = resolveOrderStatusFlow(flow);
  const normalizedNext = normalizeOrderStatus(nextStatus, "");
  const normalizedCurrent = normalizeOrderStatus(currentStatus, "");
  const finalStatus = statusFlow[statusFlow.length - 1];

  if (normalizedNext === "CANCELLED") {
    return !isCompletedOrderStatus(normalizedCurrent) && normalizedCurrent !== "CANCELLED";
  }

  if (normalizedCurrent === "CANCELLED" || normalizedCurrent === finalStatus) {
    return false;
  }

  const currentIndex = getOrderStatusIndex(normalizedCurrent, statusFlow);
  const nextIndex = getOrderStatusIndex(normalizedNext, statusFlow);

  if (currentIndex === -1 || nextIndex === -1) {
    return false;
  }

  if (nextIndex === currentIndex) {
    return true;
  }

  return nextIndex === currentIndex + 1;
};

const buildOrderStatusFilter = (status) => {
  const normalized = String(status || "").trim().toUpperCase();

  if (!normalized || normalized === "ALL") {
    return null;
  }

  if (normalized === "PENDING") {
    return { $nin: ["DELIVERED", "DISPATCHED", "COMPLETED", "DONE", "CANCELLED"] };
  }

  const mapped = normalizeOrderStatus(normalized, "");
  if (!mapped) {
    return null;
  }

  if (mapped === ORDER_STATUSES[0]) {
    return { $in: [ORDER_STATUSES[0], ...(ORDER_STATUS_LEGACY_VALUES_BY_CANONICAL.NEW || [])] };
  }

  if (mapped === "PREPARING") {
    return { $in: ["PREPARING", ...(ORDER_STATUS_LEGACY_VALUES_BY_CANONICAL.PREPARING || [])] };
  }

  if (mapped === "ALMOST_READY") {
    return { $in: ["ALMOST_READY"] };
  }

  if (mapped === "READY") {
    return { $in: ["READY", ...(ORDER_STATUS_LEGACY_VALUES_BY_CANONICAL.READY || [])] };
  }

  if (mapped === "DELIVERED") {
    return {
      $in: ["DELIVERED", "DISPATCHED", ...(ORDER_STATUS_LEGACY_VALUES_BY_CANONICAL.DELIVERED || [])]
    };
  }

  if (mapped === "DISPATCHED") {
    return { $in: ["DISPATCHED"] };
  }

  return mapped;
};

const isCompletedOrderStatus = (status) => {
  const normalized = normalizeOrderStatus(status, "");
  return normalized === "DELIVERED" || normalized === "DISPATCHED";
};
const isCancelledOrderStatus = (status) => normalizeOrderStatus(status) === "CANCELLED";

const isActiveOrderStatus = (status) =>
  !isCompletedOrderStatus(status) && !isCancelledOrderStatus(status);

module.exports = {
  USER_ROLES,
  ALL_USER_ROLES,
  STAFF_ROLES,
  OWNER_ONLY_ROLES,
  REPORT_VIEW_ROLES,
  DOCUMENT_VIEW_ROLES,
  CUSTOMER_VIEW_ROLES,
  MARKETING_ROLES,
  DELIVERY_MANAGEMENT_ROLES,
  TABLE_MANAGEMENT_ROLES,
  RESERVATION_MANAGEMENT_ROLES,
  SUPPLIER_MANAGEMENT_ROLES,
  PURCHASE_ORDER_ROLES,
  EXPENSE_ROLES,
  INVENTORY_VIEW_ROLES,
  INVENTORY_MANAGEMENT_ROLES,
  MENU_VIEW_ROLES,
  MENU_MANAGEMENT_ROLES,
  ORDER_CREATION_ROLES,
  ORDER_VIEW_ROLES,
  ORDER_STATUS_UPDATE_ROLES,
  RECIPE_MANAGEMENT_ROLES,
  ORDER_STATUSES,
  CLOUD_KITCHEN_ORDER_STATUSES,
  ALL_ORDER_STATUS_VALUES,
  normalizeRole,
  normalizeOrderStatus,
  isKnownOrderStatusValue,
  resolveOrderStatusFlow,
  getOrderStatusIndex,
  canTransitionOrderStatus,
  buildOrderStatusFilter,
  isCompletedOrderStatus,
  isCancelledOrderStatus,
  isActiveOrderStatus
};
