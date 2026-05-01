const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const User = require("../models/User");
const Restaurant = require("../models/Restaurant");
const Subscription = require("../models/Subscription");
const auditActivity = require("../middleware/auditActivity");
const requirePermission = require("../middleware/requirePermission");
const {
  STAFF_ROLES,
  normalizeRole
} = require("../utils/accessControl");
const { hasPermission } = require("../utils/permissionEngine");
const {
  normalizeBusinessType,
  resolveWorkspaceAccess
} = require("../services/workspaceAccess");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");

const router = express.Router();

const isDbConnected = () => mongoose.connection.readyState === 1;

const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();
const normalizeText = (value = "") => String(value || "").trim();
const normalizeBoolean = (value) => Boolean(value);
const MAX_MEDIA_LENGTH = 1_200_000;
const createIntegrationKey = () => crypto.randomBytes(24).toString("hex");

const normalizeMediaValue = (value = "") => {
  const normalized = String(value || "").trim();
  if (normalized.length > MAX_MEDIA_LENGTH) {
    const error = new Error("Uploaded image is too large. Please use a smaller image.");
    error.status = 400;
    throw error;
  }

  return normalized;
};

const normalizePartnerIntegration = (value = {}) => ({
  enabled: normalizeBoolean(value?.enabled),
  storeId: normalizeText(value?.storeId),
  locationLabel: normalizeText(value?.locationLabel),
  notes: normalizeText(value?.notes)
});

const normalizeOrderIntegrations = (value = {}) => ({
  swiggy: normalizePartnerIntegration(value?.swiggy),
  zomato: normalizePartnerIntegration(value?.zomato),
  magicpin: normalizePartnerIntegration(value?.magicpin),
  otherApps: normalizePartnerIntegration(value?.otherApps),
  website: {
    enabled: normalizeBoolean(value?.website?.enabled),
    notes: normalizeText(value?.website?.notes)
  }
});

const sanitizeUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone || "",
  avatarUrl: user.avatarUrl || "",
  role: user.role,
  isActive: user.isActive !== false,
  createdAt: user.createdAt
});

const sanitizeRestaurant = (restaurant, subscription = null, { includeSecrets = false } = {}) => {
  const workspaceAccess = resolveWorkspaceAccess({
    restaurant,
    subscription
  });

  const response = {
    id: restaurant._id,
    name: restaurant.name || "",
    ownerName: restaurant.ownerName || "",
    email: restaurant.email || "",
    phone: restaurant.phone || "",
    businessType: workspaceAccess.businessType,
    gstNumber: restaurant.gstNumber || "",
    address: restaurant.address || "",
    logoUrl: restaurant.logoUrl || "",
    websiteUrl: restaurant.websiteUrl || "",
    orderIntegrations: normalizeOrderIntegrations(restaurant.orderIntegrations),
    subscriptionPlan: workspaceAccess.plan,
    subscriptionExpiry: workspaceAccess.expiryDate || null,
    subscriptionStatus: workspaceAccess.status,
    trialEndsAt: workspaceAccess.trialEndsAt || null,
    accessMode: workspaceAccess.accessMode,
    isReadOnly: workspaceAccess.isReadOnly,
    workspaceAccess: {
      businessType: workspaceAccess.businessType,
      businessTypeLabel: workspaceAccess.businessTypeLabel,
      plan: workspaceAccess.plan,
      status: workspaceAccess.status,
      accessMode: workspaceAccess.accessMode,
      enabledPages: workspaceAccess.enabledPages,
      lockedPages: workspaceAccess.lockedPages,
      modules: workspaceAccess.modules,
      features: workspaceAccess.features
    },
    status: restaurant.status || "ACTIVE"
  };

  if (includeSecrets) {
    response.integrationApiKey = restaurant.integrationApiKey || "";
  }

  return response;
};

const ensureRestaurantIntegrationKey = async (restaurant) => {
  if (!restaurant || String(restaurant.integrationApiKey || "").trim()) {
    return restaurant;
  }

  restaurant.integrationApiKey = undefined;
  await restaurant.save();
  return restaurant;
};

const ALLOWED_STAFF_ROLES = STAFF_ROLES;

router.use((req, res, next) => {
  if (!isDbConnected()) {
    return res.status(503).json({
      message: "Database connection is not ready. Please retry in a moment."
    });
  }

  return next();
});

router.get("/", async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ message: "Tenant context missing" });
    }

    const [currentUser, restaurantDoc, subscription] = await Promise.all([
      User.findById(req.user?.userId).lean(),
      Restaurant.findById(restaurantId),
      Subscription.findOne({ restaurantId }).lean()
    ]);

    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!restaurantDoc) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    const restaurant = await ensureRestaurantIntegrationKey(restaurantDoc);

    let users = [];
    const canManageStaff = hasPermission(req.user, "staff.view");
    if (canManageStaff) {
      users = await User.find(withTenantFilter(req)).sort({ createdAt: -1 }).lean();
    }

    return res.json({
      profile: sanitizeUser(currentUser),
      restaurant: sanitizeRestaurant(restaurant, subscription, {
        includeSecrets: hasPermission(req.user, "settings.manage")
      }),
      users: users.map(sanitizeUser)
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
});

router.put("/me", async (req, res) => {
  try {
    const updates = {};

    if (req.body?.name !== undefined) {
      const name = normalizeText(req.body.name);
      if (!name) {
        return res.status(400).json({ message: "Name cannot be empty" });
      }
      updates.name = name;
    }

    if (req.body?.phone !== undefined) {
      updates.phone = normalizeText(req.body.phone);
    }

    if (req.body?.businessType !== undefined) {
      const businessType = normalizeBusinessType(req.body.businessType, "");
      if (!businessType) {
        return res.status(400).json({
          message: "Business type must be Cloud Kitchen or Restaurant"
        });
      }
      updates.businessType = businessType;
    }

    if (req.body?.avatarUrl !== undefined) {
      updates.avatarUrl = normalizeMediaValue(req.body.avatarUrl);
    }

    const updated = await User.findByIdAndUpdate(req.user?.userId, updates, {
      new: true
    });

    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      message: "Profile updated successfully",
      profile: sanitizeUser(updated)
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.put(
  "/restaurant",
  requirePermission("settings.manage"),
  auditActivity({ action: "Settings updated", module: "Settings" }),
  async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ message: "Tenant context missing" });
    }

    const updates = {};

    if (req.body?.name !== undefined) {
      const name = normalizeText(req.body.name);
      if (!name) {
        return res.status(400).json({ message: "Restaurant name cannot be empty" });
      }
      updates.name = name;
    }

    if (req.body?.ownerName !== undefined) {
      updates.ownerName = normalizeText(req.body.ownerName);
    }

    if (req.body?.email !== undefined) {
      updates.email = normalizeEmail(req.body.email);
    }

    if (req.body?.phone !== undefined) {
      updates.phone = normalizeText(req.body.phone);
    }

    if (req.body?.gstNumber !== undefined) {
      updates.gstNumber = normalizeText(req.body.gstNumber);
    }

    if (req.body?.address !== undefined) {
      updates.address = normalizeText(req.body.address);
    }

    if (req.body?.logoUrl !== undefined) {
      updates.logoUrl = normalizeMediaValue(req.body.logoUrl);
    }

    if (req.body?.websiteUrl !== undefined) {
      updates.websiteUrl = normalizeText(req.body.websiteUrl);
    }

    if (req.body?.orderIntegrations !== undefined) {
      updates.orderIntegrations = normalizeOrderIntegrations(req.body.orderIntegrations);
    }

    if (req.body?.rotateIntegrationApiKey) {
      updates.integrationApiKey = createIntegrationKey();
    }

    const updated = await Restaurant.findByIdAndUpdate(restaurantId, updates, {
      new: true,
      runValidators: true
    });

    if (!updated) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    const subscription = await Subscription.findOne({ restaurantId }).lean();

    return res.json({
      message: "Restaurant profile updated successfully",
      restaurant: sanitizeRestaurant(updated, subscription, { includeSecrets: true })
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
  }
);

router.post(
  "/users",
  requirePermission("staff.create"),
  auditActivity({ action: "User added", module: "Staff" }),
  async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ message: "Tenant context missing" });
    }

    const name = normalizeText(req.body?.name);
    const email = normalizeEmail(req.body?.email);
    const phone = normalizeText(req.body?.phone);
    const password = String(req.body?.password || "");
    const role = normalizeRole(req.body?.role);

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "name, email, password and role are required" });
    }

    if (!ALLOWED_STAFF_ROLES.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const created = await User.create({
      restaurantId,
      name,
      email,
      phone,
      role,
      passwordHash,
      provider: "local",
      emailVerified: true,
      isActive: true
    });

    return res.status(201).json({
      message: "User created successfully",
      user: sanitizeUser(created)
    });
  } catch (err) {
    return res.serverError(err);
  }
  }
);

router.put(
  "/users/:id/access",
  requirePermission("staff.update"),
  auditActivity({ action: "Role changed", module: "Staff" }),
  async (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    if (!targetId) {
      return res.status(400).json({ message: "User id is required" });
    }

    const updates = {};

    if (req.body?.role !== undefined) {
      const nextRole = normalizeRole(req.body.role);
      if (!ALLOWED_STAFF_ROLES.includes(nextRole)) {
        return res.status(400).json({ message: "Invalid role" });
      }
      updates.role = nextRole;
    }

    if (req.body?.isActive !== undefined) {
      updates.isActive = Boolean(req.body.isActive);
    }

    if (req.body?.password !== undefined) {
      const password = String(req.body.password || "");
      if (password && password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }

      if (password) {
        updates.passwordHash = await bcrypt.hash(password, 10);
      }
    }

    const updated = await User.findOneAndUpdate(
      withTenantDocFilter(req, targetId, { role: { $ne: "OWNER" } }),
      updates,
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      message: "User access updated successfully",
      user: sanitizeUser(updated)
    });
  } catch (err) {
    return res.serverError(err);
  }
  }
);

router.get("/users", requirePermission("staff.view"), async (req, res) => {
  try {
    const users = await User.find(withTenantFilter(req)).sort({ createdAt: -1 });
    return res.json(users.map(sanitizeUser));
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
