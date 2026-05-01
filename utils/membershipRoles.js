const { USER_ROLES } = require("./accessControl");

const MEMBERSHIP_ROLES = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  STAFF: "STAFF"
};

const ALL_MEMBERSHIP_ROLES = Object.values(MEMBERSHIP_ROLES);

const normalizeMembershipRole = (value = "", fallback = MEMBERSHIP_ROLES.STAFF) => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^\w]+/g, "_")
    .replace(/_+/g, "_");

  if (ALL_MEMBERSHIP_ROLES.includes(normalized)) {
    return normalized;
  }

  if (normalized === "MANAGER") {
    return MEMBERSHIP_ROLES.ADMIN;
  }

  if (normalized === "OWNER") {
    return MEMBERSHIP_ROLES.OWNER;
  }

  return fallback;
};

const mapMembershipRoleToAppRole = (membershipRole = MEMBERSHIP_ROLES.STAFF) => {
  const role = normalizeMembershipRole(membershipRole, MEMBERSHIP_ROLES.STAFF);

  if (role === MEMBERSHIP_ROLES.OWNER) {
    return USER_ROLES.OWNER;
  }

  if (role === MEMBERSHIP_ROLES.ADMIN) {
    return USER_ROLES.MANAGER;
  }

  return USER_ROLES.CASHIER;
};

const mapAppRoleToMembershipRole = (role = "") => {
  const normalizedRole = String(role || "").trim().toUpperCase();

  if (normalizedRole === USER_ROLES.OWNER) {
    return MEMBERSHIP_ROLES.OWNER;
  }

  if ([USER_ROLES.MANAGER, USER_ROLES.SUPER_ADMIN].includes(normalizedRole)) {
    return MEMBERSHIP_ROLES.ADMIN;
  }

  return MEMBERSHIP_ROLES.STAFF;
};

module.exports = {
  MEMBERSHIP_ROLES,
  normalizeMembershipRole,
  mapMembershipRoleToAppRole,
  mapAppRoleToMembershipRole
};
