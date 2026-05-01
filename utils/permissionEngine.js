const roles = {
  owner: ["*"],
  manager: [
    "dashboard.view",
    "menu.manage",
    "pos.view",
    "pos.create",
    "orders.view",
    "orders.update",
    "kitchen.view",
    "inventory.view",
    "finance.view",
    "crm.view",
    "marketing.view",
    "documents.view",
    "profile.view"
  ],
  staff: ["profile.view", "pos.view", "pos.create", "kitchen.view", "orders.view"],
  delivery: ["profile.view", "dispatch.view"],
  kitchen: ["profile.view", "kitchen.view", "orders.view", "orders.update"],
  inventory_manager: [
    "profile.view",
    "orders.view",
    "inventory.view",
    "inventory.create",
    "inventory.update",
    "inventory.delete"
  ],
  accountant: [
    "profile.view",
    "dashboard.view",
    "orders.view",
    "inventory.view",
    "finance.view",
    "expenses.view",
    "expenses.create",
    "expenses.delete",
    "crm.view",
    "documents.view"
  ],
  marketing_manager: [
    "profile.view",
    "finance.view",
    "crm.view",
    "marketing.view",
    "marketing.create",
    "marketing.update",
    "documents.view"
  ],
  super_admin: ["*"]
};

const ROLE_ALIASES = {
  OWNER: "owner",
  ADMIN: "owner",
  MANAGER: "manager",
  ADMIN_MANAGER: "manager",
  STAFF: "staff",
  CASHIER: "staff",
  POS_OPERATOR: "staff",
  WAITER: "staff",
  KITCHEN: "kitchen",
  CHEF: "kitchen",
  KITCHEN_STAFF: "kitchen",
  DELIVERY: "delivery",
  DELIVERY_MANAGER: "delivery",
  DELIVERY_PARTNER: "delivery",
  INVENTORY_MANAGER: "inventory_manager",
  ACCOUNTANT: "accountant",
  MARKETING_MANAGER: "marketing_manager",
  SUPER_ADMIN: "super_admin"
};

const APP_ROLE_BY_PERMISSION_ROLE = {
  owner: "OWNER",
  manager: "MANAGER",
  staff: "CASHIER",
  delivery: "DELIVERY_PARTNER",
  kitchen: "KITCHEN",
  inventory_manager: "INVENTORY_MANAGER",
  accountant: "ACCOUNTANT",
  marketing_manager: "MARKETING_MANAGER",
  super_admin: "SUPER_ADMIN"
};

const normalizePermissionRole = (value = "") => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[/\s-]+/g, "_")
    .replace(/_+/g, "_");

  return ROLE_ALIASES[normalized] || normalized.toLowerCase();
};

const getUserPermissions = (user = {}) => {
  const roleKey = normalizePermissionRole(user.role);
  const configuredPermissions = roles[roleKey] || [];
  const directPermissions = Array.isArray(user.permissions) ? user.permissions : [];

  return Array.from(new Set([...configuredPermissions, ...directPermissions]));
};

const hasPermission = (user, permission) => {
  if (!permission) {
    return true;
  }

  if (!user || !user.role) {
    return false;
  }

  const roleKey = normalizePermissionRole(user.role);
  if (String(permission).startsWith("admin.") && roleKey !== "super_admin") {
    return false;
  }

  const permissions = getUserPermissions(user);

  if (permissions.includes("*")) {
    return true;
  }

  if (permissions.includes(permission)) {
    return true;
  }

  const [moduleName] = String(permission).split(".");
  return permissions.includes(`${moduleName}.*`);
};

const rolesWithPermission = (permission) =>
  Object.keys(roles)
    .filter((role) => hasPermission({ role }, permission))
    .map((role) => APP_ROLE_BY_PERMISSION_ROLE[role])
    .filter(Boolean);

module.exports = {
  roles,
  hasPermission,
  rolesWithPermission,
  normalizePermissionRole
};
