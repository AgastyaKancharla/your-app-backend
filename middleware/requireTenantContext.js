const mongoose = require("mongoose");
const Membership = require("../models/Membership");
const {
  mapAppRoleToMembershipRole,
  mapMembershipRoleToAppRole
} = require("../utils/membershipRoles");

const normalizeTenantId = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  const tenantId = String(value).trim();
  if (!tenantId) {
    return null;
  }

  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    return null;
  }

  return tenantId;
};

const resolveRequestedTenantId = (req) => {
  return normalizeTenantId(
    req.header("x-tenant-id") ||
      req.query?.tenantId ||
      req.user?.tenantId ||
      req.user?.restaurantId
  );
};

const requireTenantContext = async (req, res, next) => {
  try {
    const userId = String(req.user?.userId || "").trim();
    const tokenRole = String(req.user?.role || "").trim().toUpperCase();

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized user session" });
    }

    if (tokenRole === "SUPER_ADMIN") {
      req.tenant = {
        restaurantId: null,
        membershipRole: "ADMIN"
      };
      return next();
    }

    const requestedTenantId = resolveRequestedTenantId(req);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      const tenantId = requestedTenantId;
      if (!tenantId) {
        return res.status(401).json({ message: "Tenant context missing or invalid" });
      }

      req.tenant = {
        restaurantId: tenantId,
        membershipRole: mapAppRoleToMembershipRole(req.user?.role)
      };
      req.user.restaurantId = tenantId;
      req.user.tenantId = tenantId;
      return next();
    }

    const memberships = await Membership.find({ userId }).lean();
    let effectiveMemberships = memberships;

    if (!effectiveMemberships.length && normalizeTenantId(req.user?.restaurantId)) {
      const fallbackMembership = await Membership.findOneAndUpdate(
        {
          userId,
          tenantId: normalizeTenantId(req.user?.restaurantId)
        },
        {
          $setOnInsert: {
            userId,
            tenantId: normalizeTenantId(req.user?.restaurantId),
            role: mapAppRoleToMembershipRole(req.user?.role)
          }
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true
        }
      ).lean();

      if (fallbackMembership) {
        effectiveMemberships = [fallbackMembership];
      }
    }

    if (!effectiveMemberships.length) {
      return res.status(403).json({ message: "No tenant membership found for this account" });
    }

    const membership =
      effectiveMemberships.find(
        (entry) => String(entry.tenantId) === String(requestedTenantId || "")
      ) || effectiveMemberships[0];

    const tenantId = normalizeTenantId(membership?.tenantId);
    if (!tenantId) {
      return res.status(401).json({ message: "Tenant context missing or invalid" });
    }

    const membershipRole = String(membership?.role || "STAFF").toUpperCase();
    req.tenant = {
      restaurantId: tenantId,
      membershipRole
    };
    req.user.restaurantId = tenantId;
    req.user.tenantId = tenantId;
    req.user.membershipRole = membershipRole;
    req.user.role = mapMembershipRoleToAppRole(membershipRole);

    return next();
  } catch {
    return res.status(500).json({ message: "Unable to resolve tenant context" });
  }
};

module.exports = requireTenantContext;
