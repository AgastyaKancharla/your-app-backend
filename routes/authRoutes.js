const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const User = require("../models/User");
const Restaurant = require("../models/Restaurant");
const Tenant = require("../models/Tenant");
const Membership = require("../models/Membership");
const Subscription = require("../models/Subscription");
const authMiddleware = require("../middleware/authMiddleware");
const loginRateLimit = require("../middleware/loginRateLimit");
const {
  dispatchVerificationEmailHook,
  dispatchLoginOtpHook,
  dispatchAccountRecoveryOtpHook,
  parseBoolean
} = require("../services/emailVerificationHooks");
const {
  getAuthCookiesFromRequest,
  setAuthCookies,
  clearAuthCookies
} = require("../utils/httpCookies");
const { getTrialEndDate } = require("../services/subscriptionPlans");
const {
  normalizeBusinessType,
  resolveWorkspaceAccess
} = require("../services/workspaceAccess");
const {
  MEMBERSHIP_ROLES,
  normalizeMembershipRole,
  mapMembershipRoleToAppRole,
  mapAppRoleToMembershipRole
} = require("../utils/membershipRoles");

const router = express.Router();

const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const LOCAL_AUTH_STORE_PATH = path.join(__dirname, "..", "data", "auth-store.json");
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || "1h";
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || "7d";
const EMAIL_VERIFICATION_TTL_MINUTES = Math.max(
  5,
  Number(process.env.EMAIL_VERIFICATION_TTL_MINUTES || 60)
);
const REQUIRE_EMAIL_VERIFICATION = parseBoolean(process.env.REQUIRE_EMAIL_VERIFICATION, false);
const INCLUDE_DEV_VERIFICATION_TOKEN =
  !IS_PRODUCTION && parseBoolean(process.env.AUTH_INCLUDE_DEV_VERIFICATION_TOKEN, false);
const LOGIN_OTP_ENABLED = parseBoolean(process.env.LOGIN_OTP_ENABLED, true);
const LOGIN_OTP_TTL_MINUTES = Math.max(1, Number(process.env.LOGIN_OTP_TTL_MINUTES || 10));
const LOGIN_OTP_MAX_ATTEMPTS = Math.max(3, Number(process.env.LOGIN_OTP_MAX_ATTEMPTS || 5));
const INCLUDE_DEV_LOGIN_OTP_CODE =
  !IS_PRODUCTION && parseBoolean(process.env.LOGIN_OTP_INCLUDE_DEV_CODE, false);
const ACCOUNT_RECOVERY_OTP_TTL_MINUTES = Math.max(
  1,
  Number(process.env.ACCOUNT_RECOVERY_OTP_TTL_MINUTES || 10)
);
const ACCOUNT_RECOVERY_OTP_MAX_ATTEMPTS = Math.max(
  3,
  Number(process.env.ACCOUNT_RECOVERY_OTP_MAX_ATTEMPTS || 5)
);
const INCLUDE_DEV_ACCOUNT_RECOVERY_OTP_CODE =
  !IS_PRODUCTION && parseBoolean(process.env.ACCOUNT_RECOVERY_OTP_INCLUDE_DEV_CODE, false);
const RETURN_TOKENS_IN_RESPONSE =
  !IS_PRODUCTION && parseBoolean(process.env.AUTH_RETURN_TOKENS_IN_BODY, false);
const ALLOW_DEV_QUICK_LOGIN =
  !IS_PRODUCTION && parseBoolean(process.env.AUTH_ALLOW_QUICK_LOGIN, false);
const ALLOW_INSECURE_PASSWORD_RESET =
  !IS_PRODUCTION && parseBoolean(process.env.AUTH_ALLOW_INSECURE_PASSWORD_RESET, false);
const ALLOW_DECODED_GOOGLE_LOGIN =
  !IS_PRODUCTION && parseBoolean(process.env.AUTH_ALLOW_DECODED_GOOGLE_LOGIN, false);
const LOCAL_REFRESH_VERSIONS = new Map();
const GENERIC_AUTH_FAILURE_MESSAGE = "Invalid email or password";
const GENERIC_RESEND_VERIFICATION_MESSAGE =
  "If the account exists and still needs verification, a new code will be sent shortly.";
const GENERIC_RECOVERY_IDENTIFIER_ERROR =
  "Enter a correct registered email or phone number.";

const isDbConnected = () => mongoose.connection.readyState === 1;
const allowLocalAuthFallback = () => !IS_PRODUCTION;

const normalizeEmail = (email = "") => email.trim().toLowerCase();
const normalize = (value) => String(value || "").trim();
const normalizePhone = (phone = "") => {
  const raw = String(phone || "").trim();
  if (!raw) return "";

  const hasPlusPrefix = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  return `${hasPlusPrefix ? "+" : ""}${digits}`;
};
const looksLikeEmail = (value = "") => normalize(value).includes("@");
const createHttpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const sendAuthRouteError = (res, err, fallbackMessage = "Internal server error") => {
  const status = Number(err?.status || 0);
  if (status >= 400 && status < 600) {
    return res.status(status).json({
      message: err?.message || fallbackMessage
    });
  }

  if (err?.code === 11000) {
    const duplicateFields = Object.keys(err?.keyPattern || {});

    if (duplicateFields.includes("email")) {
      return res.status(409).json({
        message: "Account already exists. Please login or reset password."
      });
    }

    if (duplicateFields.includes("phone")) {
      return res.status(409).json({
        message: "Phone number is already linked to another account. Use a different number."
      });
    }
  }

  if (err?.name === "ValidationError") {
    const firstMessage = Object.values(err.errors || {})[0]?.message;
    return res.status(400).json({
      message: firstMessage || "Invalid request"
    });
  }

  return res.serverError(err, { fallbackMessage });
};

router.use((req, res, next) => {
  if (!allowLocalAuthFallback() && !isDbConnected()) {
    return res.status(503).json({
      message: "Authentication service is temporarily unavailable. Please retry shortly."
    });
  }

  return next();
});

const getConfiguredSuperAdmin = () => ({
  email: normalizeEmail(process.env.SUPER_ADMIN_EMAIL || ""),
  password: normalize(process.env.SUPER_ADMIN_PASSWORD || ""),
  name: normalize(process.env.SUPER_ADMIN_NAME || "Super Admin")
});

const buildEnvSuperAdminUser = () => {
  const configured = getConfiguredSuperAdmin();

  return {
    _id: "super-admin",
    name: configured.name || "Super Admin",
    email: configured.email || "superadmin@local",
    phone: "",
    role: "SUPER_ADMIN",
    provider: "local",
    avatarUrl: "",
    restaurantId: null,
    emailVerified: true
  };
};

const signToken = (user, authContext = {}) => {
  const activeTenantId =
    authContext?.activeTenantId || user.tenantId || user.restaurantId || null;
  const activeRole = authContext?.activeRole || user.role;
  const activeMembershipRole =
    authContext?.activeMembershipRole || mapAppRoleToMembershipRole(activeRole);

  return jwt.sign(
    {
      userId: user._id,
      restaurantId: activeTenantId,
      tenantId: activeTenantId,
      role: activeRole,
      membershipRole: activeMembershipRole,
      type: "access"
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
};

const getRefreshTokenVersion = (user) => {
  if (user?.refreshTokenVersion !== undefined && user?.refreshTokenVersion !== null) {
    return Number(user.refreshTokenVersion || 0);
  }

  const key = String(user?._id || "");
  return Number(LOCAL_REFRESH_VERSIONS.get(key) || 0);
};

const signRefreshToken = (user, authContext = {}) => {
  const activeTenantId =
    authContext?.activeTenantId || user.tenantId || user.restaurantId || null;
  const activeRole = authContext?.activeRole || user.role;
  const activeMembershipRole =
    authContext?.activeMembershipRole || mapAppRoleToMembershipRole(activeRole);

  return jwt.sign(
    {
      userId: user._id,
      restaurantId: activeTenantId,
      tenantId: activeTenantId,
      role: activeRole,
      membershipRole: activeMembershipRole,
      type: "refresh",
      tokenVersion: getRefreshTokenVersion(user)
    },
    process.env.JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
};

const sanitizeUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
  businessType: normalizeBusinessType(
    user.businessType || user.restaurantId?.businessType,
    ""
  ),
  provider: user.provider,
  avatarUrl: user.avatarUrl,
  restaurantId: user.restaurantId,
  emailVerified: Boolean(user.emailVerified)
});

const serializeWorkspaceAccess = (workspaceAccess = {}) => ({
  businessType: workspaceAccess.businessType,
  businessTypeLabel: workspaceAccess.businessTypeLabel,
  plan: workspaceAccess.plan,
  planLabel: workspaceAccess.planLabel,
  status: workspaceAccess.status,
  accessMode: workspaceAccess.accessMode,
  isReadOnly: workspaceAccess.isReadOnly,
  expiryDate: workspaceAccess.expiryDate || null,
  trialEndsAt: workspaceAccess.trialEndsAt || null,
  daysLeft: workspaceAccess.daysLeft,
  trialDay: workspaceAccess.trialDay,
  enabledPages: workspaceAccess.enabledPages || [],
  lockedPages: workspaceAccess.lockedPages || [],
  modules: workspaceAccess.modules || [],
  features: workspaceAccess.features || {}
});

const buildRestaurantAuthSnapshot = (restaurant, subscription = null) => {
  if (!restaurant) {
    return null;
  }

  const workspaceAccess = resolveWorkspaceAccess({
    restaurant,
    subscription
  });

  return {
    id: restaurant._id,
    name: restaurant.name,
    ownerName: restaurant.ownerName || "",
    logoUrl: restaurant.logoUrl || "",
    websiteUrl: restaurant.websiteUrl || "",
    businessType: workspaceAccess.businessType,
    subscriptionPlan: workspaceAccess.plan,
    subscriptionExpiry: workspaceAccess.expiryDate || null,
    subscriptionStatus: workspaceAccess.status,
    trialEndsAt: workspaceAccess.trialEndsAt || null,
    accessMode: workspaceAccess.accessMode,
    isReadOnly: workspaceAccess.isReadOnly,
    status: restaurant.status || "ACTIVE",
    workspaceAccess: serializeWorkspaceAccess(workspaceAccess)
  };
};

const issueAuthTokens = (user, authContext = {}) => ({
  accessToken: signToken(user, authContext),
  refreshToken: signRefreshToken(user, authContext)
});

const buildTenantSummary = ({ tenant, subscription = null, membershipRole = "STAFF" }) => {
  const snapshot = buildRestaurantAuthSnapshot(tenant, subscription);
  if (!snapshot) {
    return null;
  }

  return {
    ...snapshot,
    tenantId: snapshot.id,
    role: normalizeMembershipRole(membershipRole, MEMBERSHIP_ROLES.STAFF)
  };
};

const buildSingleLocalTenantContext = (user) => {
  const tenantId = user?.restaurantId ? String(user.restaurantId) : "";
  const localRestaurant = tenantId ? findLocalRestaurantById(tenantId) : null;
  const membershipRole = mapAppRoleToMembershipRole(user?.role);
  const tenantSummary = localRestaurant
    ? buildTenantSummary({
        tenant: localRestaurant,
        membershipRole
      })
    : null;
  const activeTenantId = tenantSummary?.tenantId || null;
  const activeRole = mapMembershipRoleToAppRole(membershipRole);
  const activeBusinessType = normalizeBusinessType(
    tenantSummary?.businessType || user?.businessType || "",
    ""
  );

  return {
    tenants: tenantSummary ? [tenantSummary] : [],
    roles: tenantSummary ? [membershipRole] : [],
    activeTenantId,
    activeMembershipRole: membershipRole,
    activeRole,
    activeRestaurant: tenantSummary,
    activeBusinessType
  };
};

const resolveDbTenantContext = async (user, preferredTenantId = "") => {
  const normalizedPreferredTenantId = String(preferredTenantId || "").trim();
  let memberships = await Membership.find({ userId: user._id }).lean();

  if (!memberships.length && user.restaurantId) {
    const fallbackMembership = await Membership.findOneAndUpdate(
      {
        userId: user._id,
        tenantId: user.restaurantId
      },
      {
        $setOnInsert: {
          userId: user._id,
          tenantId: user.restaurantId,
          role: mapAppRoleToMembershipRole(user.role)
        }
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    ).lean();

    if (fallbackMembership) {
      memberships = [fallbackMembership];
    }
  }

  const tenantIds = memberships.map((membership) => membership.tenantId).filter(Boolean);
  const [tenants, subscriptions] = await Promise.all([
    tenantIds.length ? Tenant.find({ _id: { $in: tenantIds } }).lean() : [],
    tenantIds.length ? Subscription.find({ restaurantId: { $in: tenantIds } }).lean() : []
  ]);

  const tenantById = new Map(tenants.map((tenant) => [String(tenant._id), tenant]));
  const subscriptionByTenantId = new Map(
    subscriptions.map((subscription) => [String(subscription.restaurantId), subscription])
  );

  const tenantSummaries = memberships
    .map((membership) => {
      const tenantId = String(membership.tenantId || "");
      const tenant = tenantById.get(tenantId);
      if (!tenant) {
        return null;
      }

      return buildTenantSummary({
        tenant,
        subscription: subscriptionByTenantId.get(tenantId) || null,
        membershipRole: membership.role
      });
    })
    .filter(Boolean);

  const activeTenant =
    tenantSummaries.find((tenant) => tenant.tenantId === normalizedPreferredTenantId) ||
    tenantSummaries[0] ||
    null;
  const activeMembershipRole = normalizeMembershipRole(activeTenant?.role, MEMBERSHIP_ROLES.STAFF);
  const activeRole = mapMembershipRoleToAppRole(activeMembershipRole);
  const activeBusinessType = normalizeBusinessType(activeTenant?.businessType, "");

  return {
    tenants: tenantSummaries,
    roles: tenantSummaries.map((tenant) =>
      normalizeMembershipRole(tenant.role, MEMBERSHIP_ROLES.STAFF)
    ),
    activeTenantId: activeTenant?.tenantId || null,
    activeMembershipRole,
    activeRole,
    activeRestaurant: activeTenant,
    activeBusinessType
  };
};

const resolveAuthTenantContext = async (user, preferredTenantId = "") => {
  if (String(user?.role || "").toUpperCase() === "SUPER_ADMIN") {
    return {
      tenants: [],
      roles: [],
      activeTenantId: null,
      activeMembershipRole: MEMBERSHIP_ROLES.ADMIN,
      activeRole: "SUPER_ADMIN",
      activeRestaurant: null,
      activeBusinessType: ""
    };
  }

  const userId = String(user?._id || "");
  const canUseDbModels = isDbConnected() && mongoose.Types.ObjectId.isValid(userId);

  if (canUseDbModels) {
    return resolveDbTenantContext(user, preferredTenantId);
  }

  return buildSingleLocalTenantContext(user);
};

const buildAuthPayload = (user, authContext, tokens = issueAuthTokens(user, authContext)) => {
  const plainUser =
    user && typeof user.toObject === "function" ? user.toObject() : { ...(user || {}) };
  const activeTenantId = authContext?.activeTenantId || null;
  const activeRole = authContext?.activeRole || plainUser.role;
  const activeBusinessType = normalizeBusinessType(
    authContext?.activeBusinessType || plainUser?.businessType || "",
    ""
  );

  const normalizedUser = {
    ...plainUser,
    role: activeRole,
    restaurantId: activeTenantId,
    tenantId: activeTenantId,
    businessType: activeBusinessType
  };

  return {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    role: activeRole,
    roles: authContext?.roles || [],
    activeRole,
    membershipRole: authContext?.activeMembershipRole || mapAppRoleToMembershipRole(activeRole),
    restaurantId: activeTenantId,
    tenantId: activeTenantId,
    activeTenantId,
    restaurant: authContext?.activeRestaurant || null,
    tenants: authContext?.tenants || [],
    user: sanitizeUser(normalizedUser),
    token: tokens.accessToken,
    ...(RETURN_TOKENS_IN_RESPONSE
      ? {
          refreshToken: tokens.refreshToken
        }
      : {})
  };
};

const sendAuthPayload = async (res, user, options = {}) => {
  const preferredTenantId =
    options?.preferredTenantId ||
    options?.req?.header?.("x-tenant-id") ||
    options?.req?.query?.tenantId ||
    "";
  const authContext = await resolveAuthTenantContext(user, preferredTenantId);
  const tokens = issueAuthTokens(user, authContext);
  setAuthCookies(res, tokens);
  return res.json(buildAuthPayload(user, authContext, tokens));
};

const decodeGoogleCredential = (credential) => {
  if (!credential || typeof credential !== "string") {
    return null;
  }

  const parts = credential.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const readLocalStore = () => {
  try {
    if (!fs.existsSync(LOCAL_AUTH_STORE_PATH)) {
      return { users: [], restaurants: [] };
    }

    const raw = fs.readFileSync(LOCAL_AUTH_STORE_PATH, "utf8");
    if (!raw.trim()) {
      return { users: [], restaurants: [] };
    }

    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      restaurants: Array.isArray(parsed.restaurants) ? parsed.restaurants : []
    };
  } catch {
    return { users: [], restaurants: [] };
  }
};

const writeLocalStore = (store) => {
  const dir = path.dirname(LOCAL_AUTH_STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    LOCAL_AUTH_STORE_PATH,
    JSON.stringify(store, null, 2),
    "utf8"
  );
};

const nowIso = () => new Date().toISOString();
const newId = () => new mongoose.Types.ObjectId().toString();

const createLocalRestaurant = (name, details = {}) => {
  const store = readLocalStore();
  const now = nowIso();
  const trialEndsAt = getTrialEndDate(new Date()).toISOString();

  const restaurant = {
    _id: newId(),
    name,
    restaurantName: name,
    ownerName: String(details.ownerName || "").trim(),
    email: normalizeEmail(details.email || ""),
    phone: normalizePhone(details.phone || ""),
    businessType: normalizeBusinessType(details.businessType),
    gstNumber: "",
    address: "",
    subscriptionPlan: "STARTER",
    subscriptionExpiry: trialEndsAt,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now
  };

  store.restaurants.push(restaurant);
  writeLocalStore(store);
  return restaurant;
};

const saveLocalRestaurant = (nextRestaurant) => {
  const store = readLocalStore();
  const index = store.restaurants.findIndex((restaurant) => restaurant._id === nextRestaurant._id);

  if (index === -1) {
    store.restaurants.push(nextRestaurant);
  } else {
    store.restaurants[index] = nextRestaurant;
  }

  writeLocalStore(store);
  return nextRestaurant;
};

const updateLocalRestaurant = (restaurant, updates) => {
  return saveLocalRestaurant({
    ...restaurant,
    ...updates,
    updatedAt: nowIso()
  });
};

const findLocalRestaurantById = (id) => {
  if (!id) return null;
  const store = readLocalStore();
  return store.restaurants.find((restaurant) => restaurant._id === String(id)) || null;
};

const findLocalUserByEmail = (email, { activeOnly = true } = {}) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const store = readLocalStore();
  return (
    store.users.find((user) => {
      if (user.email !== normalizedEmail) return false;
      if (activeOnly && user.isActive === false) return false;
      return true;
    }) || null
  );
};

const findLocalUsersByPhone = (phone, { activeOnly = true } = {}) => {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return [];

  const store = readLocalStore();
  return store.users.filter((user) => {
    if (normalizePhone(user.phone) !== normalizedPhone) return false;
    if (activeOnly && user.isActive === false) return false;
    return true;
  });
};

const findLocalUserById = (id) => {
  if (!id) return null;
  const store = readLocalStore();
  return store.users.find((user) => user._id === String(id)) || null;
};

const findFirstActiveLocalUser = () => {
  const store = readLocalStore();
  const users = store.users
    .filter((user) => user.isActive !== false)
    .sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return aTime - bTime;
    });

  return users[0] || null;
};

const saveLocalUser = (nextUser) => {
  const store = readLocalStore();
  const index = store.users.findIndex((user) => user._id === nextUser._id);

  if (index === -1) {
    store.users.push(nextUser);
  } else {
    store.users[index] = nextUser;
  }

  writeLocalStore(store);
  return nextUser;
};

const createLocalUser = (payload) => {
  const now = nowIso();

  return saveLocalUser({
    _id: newId(),
    name: payload.name || "User",
    email: normalizeEmail(payload.email),
    phone: normalizePhone(payload.phone || ""),
    passwordHash: payload.passwordHash || "",
    role: payload.role || "OWNER",
    businessType: normalizeBusinessType(payload.businessType, ""),
    provider: payload.provider || "local",
    googleId: payload.googleId || "",
    avatarUrl: payload.avatarUrl || "",
    restaurantId: payload.restaurantId || null,
    emailVerified:
      payload.emailVerified !== undefined
        ? Boolean(payload.emailVerified)
        : payload.provider === "google",
    emailVerificationTokenHash: payload.emailVerificationTokenHash || "",
    emailVerificationExpiresAt: payload.emailVerificationExpiresAt || null,
    loginOtpHash: payload.loginOtpHash || "",
    loginOtpExpiresAt: payload.loginOtpExpiresAt || null,
    loginOtpAttempts: payload.loginOtpAttempts || 0,
    loginOtpChallengeId: payload.loginOtpChallengeId || "",
    loginOtpChannel: payload.loginOtpChannel || "none",
    loginOtpDestination: payload.loginOtpDestination || "",
    accountRecoveryOtpHash: payload.accountRecoveryOtpHash || "",
    accountRecoveryOtpExpiresAt: payload.accountRecoveryOtpExpiresAt || null,
    accountRecoveryOtpAttempts: payload.accountRecoveryOtpAttempts || 0,
    accountRecoveryOtpChallengeId: payload.accountRecoveryOtpChallengeId || "",
    accountRecoveryOtpChannel: payload.accountRecoveryOtpChannel || "none",
    accountRecoveryOtpDestination: payload.accountRecoveryOtpDestination || "",
    accountRecoveryOtpPurpose: payload.accountRecoveryOtpPurpose || "none",
    refreshTokenVersion: payload.refreshTokenVersion || 0,
    isActive: payload.isActive !== undefined ? payload.isActive : true,
    createdAt: now,
    updatedAt: now
  });
};

const updateLocalUser = (user, updates) => {
  const nextUser = {
    ...user,
    ...updates,
    updatedAt: nowIso()
  };

  return saveLocalUser(nextUser);
};

const ensureLocalUserRestaurant = (user, restaurantName = "Demo Restaurant") => {
  if (user.restaurantId) {
    const existingRestaurant = findLocalRestaurantById(user.restaurantId);
    if (existingRestaurant) {
      return { user, restaurant: existingRestaurant };
    }
  }

  const restaurant = createLocalRestaurant(restaurantName);
  const updatedUser = updateLocalUser(user, { restaurantId: restaurant._id });

  return { user: updatedUser, restaurant };
};

const getResolvedBusinessType = ({ user = null, restaurant = null, fallback = "" } = {}) => {
  return normalizeBusinessType(restaurant?.businessType || user?.businessType, fallback);
};

const ensureAuthBusinessType = async ({ user, restaurant = null, local = false } = {}) => {
  let nextUser = user;
  let nextRestaurant = restaurant;
  let businessType = getResolvedBusinessType({ user, restaurant, fallback: "" });

  if (!businessType && local) {
    businessType = "CLOUD_KITCHEN";
  }

  if (local) {
    if (
      nextRestaurant &&
      normalizeBusinessType(nextRestaurant.businessType, "") !== businessType
    ) {
      nextRestaurant = updateLocalRestaurant(nextRestaurant, { businessType });
    }

    return { user: nextUser, restaurant: nextRestaurant, businessType };
  }

  if (
    nextRestaurant &&
    normalizeBusinessType(nextRestaurant.businessType, "") !== businessType
  ) {
    nextRestaurant.businessType = businessType;
    await nextRestaurant.save();
  }

  return { user: nextUser, restaurant: nextRestaurant, businessType };
};

const bumpRefreshTokenVersion = async (userId) => {
  if (!userId) {
    return;
  }

  const key = String(userId);
  if (!mongoose.Types.ObjectId.isValid(key)) {
    return;
  }

  if (isDbConnected()) {
    await User.findByIdAndUpdate(userId, { $inc: { refreshTokenVersion: 1 } });
    return;
  }

  const localUser = findLocalUserById(userId);
  if (!localUser) {
    return;
  }

  const nextVersion = Number(localUser.refreshTokenVersion || 0) + 1;
  LOCAL_REFRESH_VERSIONS.set(key, nextVersion);
  updateLocalUser(localUser, { refreshTokenVersion: nextVersion });
};

const hashVerificationToken = (token) => {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
};

const createVerificationChallenge = () => {
  const token = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000);

  return {
    token,
    tokenHash: hashVerificationToken(token),
    expiresAt
  };
};

const shouldRequireVerificationForProvider = (provider = "local") => {
  return REQUIRE_EMAIL_VERIFICATION && String(provider || "local").toLowerCase() === "local";
};

const isVerificationPending = (user) => {
  if (!user) return false;
  return shouldRequireVerificationForProvider(user.provider) && !Boolean(user.emailVerified);
};

const buildVerificationRequiredPayload = ({
  email,
  token,
  expiresAt,
  hookResult,
  message
}) => {
  const payload = {
    verificationRequired: true,
    email,
    message:
      message ||
      "Account created. Enter the verification code sent to your email to continue.",
    verificationExpiresAt: expiresAt,
    delivery: {
      channel: hookResult?.channel || "email",
      destination: maskEmailAddress(email),
      dispatched: Boolean(hookResult?.dispatched)
    }
  };

  if (INCLUDE_DEV_VERIFICATION_TOKEN) {
    payload.verificationToken = token;
    if (hookResult?.verificationUrl) {
      payload.verificationUrl = hookResult.verificationUrl;
    }
  }

  return payload;
};

const attachVerificationChallengeDb = async (user) => {
  const challenge = createVerificationChallenge();

  user.emailVerificationTokenHash = challenge.tokenHash;
  user.emailVerificationExpiresAt = challenge.expiresAt;
  user.emailVerified = false;
  await user.save();

  return challenge;
};

const attachVerificationChallengeLocal = (user) => {
  const challenge = createVerificationChallenge();
  const updatedUser = updateLocalUser(user, {
    emailVerificationTokenHash: challenge.tokenHash,
    emailVerificationExpiresAt: challenge.expiresAt,
    emailVerified: false
  });

  return {
    user: updatedUser,
    challenge
  };
};

const clearVerificationStateDb = async (user) => {
  user.emailVerified = true;
  user.emailVerificationTokenHash = "";
  user.emailVerificationExpiresAt = null;
  user.isActive = true;
  await user.save();
  return user;
};

const clearVerificationStateLocal = (user) => {
  return updateLocalUser(user, {
    emailVerified: true,
    emailVerificationTokenHash: "",
    emailVerificationExpiresAt: null,
    isActive: true
  });
};

const sendVerificationHook = async ({
  email,
  token,
  name,
  restaurantName,
  expiresAt
}) => {
  return dispatchVerificationEmailHook({
    email,
    token,
    name,
    restaurantName,
    expiresAt
  });
};

const hashLoginOtp = (code) => {
  return crypto.createHash("sha256").update(String(code || "")).digest("hex");
};

const createLoginOtpChallenge = () => {
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + LOGIN_OTP_TTL_MINUTES * 60 * 1000);
  const challengeId = crypto.randomBytes(16).toString("hex");

  return {
    code,
    codeHash: hashLoginOtp(code),
    expiresAt,
    challengeId
  };
};

const maskEmailAddress = (email = "") => {
  const normalized = normalizeEmail(email);
  const [localPart = "", domain = ""] = normalized.split("@");
  if (!localPart || !domain) return normalized;

  if (localPart.length <= 2) {
    return `${localPart[0] || "*"}*@${domain}`;
  }

  return `${localPart[0]}${"*".repeat(Math.max(1, localPart.length - 2))}${localPart.slice(-1)}@${domain}`;
};

const maskPhoneNumber = (phone = "") => {
  const normalized = normalizePhone(phone);
  if (!normalized) return "";
  if (normalized.length <= 4) return `${"*".repeat(normalized.length)}`;
  return `${"*".repeat(normalized.length - 4)}${normalized.slice(-4)}`;
};

const getLoginOtpDestination = (user) => {
  const phone = normalizePhone(user?.phone || "");
  if (phone) {
    return {
      channel: "sms",
      value: phone,
      maskedValue: maskPhoneNumber(phone)
    };
  }

  const email = normalizeEmail(user?.email || "");
  if (email) {
    return {
      channel: "email",
      value: email,
      maskedValue: maskEmailAddress(email)
    };
  }

  return {
    channel: "none",
    value: "",
    maskedValue: ""
  };
};

const buildLoginOtpRequiredPayload = ({
  email,
  challenge,
  destination,
  hookResult
}) => {
  const payload = {
    otpRequired: true,
    email,
    challengeId: challenge.challengeId,
    channel: destination.channel,
    destination: destination.maskedValue,
    otpExpiresAt: challenge.expiresAt,
    message: destination.maskedValue
      ? `Verification code sent to ${destination.maskedValue}`
      : "Verification code generated. Complete OTP verification to login.",
    delivery: {
      dispatched: Boolean(hookResult?.dispatched),
      provider: hookResult?.channel || "none"
    }
  };

  if (INCLUDE_DEV_LOGIN_OTP_CODE) {
    payload.otpCode = challenge.code;
  }

  return payload;
};

const attachLoginOtpChallengeDb = async (user, challenge, destination) => {
  user.loginOtpHash = challenge.codeHash;
  user.loginOtpExpiresAt = challenge.expiresAt;
  user.loginOtpAttempts = 0;
  user.loginOtpChallengeId = challenge.challengeId;
  user.loginOtpChannel = destination.channel;
  user.loginOtpDestination = destination.value;
  await user.save();
  return user;
};

const attachLoginOtpChallengeLocal = (user, challenge, destination) => {
  return updateLocalUser(user, {
    loginOtpHash: challenge.codeHash,
    loginOtpExpiresAt: challenge.expiresAt,
    loginOtpAttempts: 0,
    loginOtpChallengeId: challenge.challengeId,
    loginOtpChannel: destination.channel,
    loginOtpDestination: destination.value
  });
};

const clearLoginOtpStateDb = async (user) => {
  user.loginOtpHash = "";
  user.loginOtpExpiresAt = null;
  user.loginOtpAttempts = 0;
  user.loginOtpChallengeId = "";
  user.loginOtpChannel = "none";
  user.loginOtpDestination = "";
  await user.save();
  return user;
};

const clearLoginOtpStateLocal = (user) => {
  return updateLocalUser(user, {
    loginOtpHash: "",
    loginOtpExpiresAt: null,
    loginOtpAttempts: 0,
    loginOtpChallengeId: "",
    loginOtpChannel: "none",
    loginOtpDestination: ""
  });
};

const incrementLoginOtpAttemptsDb = async (user) => {
  user.loginOtpAttempts = Number(user.loginOtpAttempts || 0) + 1;
  await user.save();
  return user;
};

const incrementLoginOtpAttemptsLocal = (user) => {
  return updateLocalUser(user, {
    loginOtpAttempts: Number(user.loginOtpAttempts || 0) + 1
  });
};

const isLoginOtpExpired = (expiresAt) => {
  if (!expiresAt) return true;
  const expiry = new Date(expiresAt);
  return Number.isNaN(expiry.getTime()) || expiry < new Date();
};

const sendLoginOtpHook = async ({ user, destination, challenge }) => {
  return dispatchLoginOtpHook({
    channel: destination.channel,
    email: normalizeEmail(user?.email || ""),
    phone: destination.channel === "sms" ? destination.value : "",
    otpCode: challenge.code,
    expiresAt: challenge.expiresAt,
    name: user?.name || "User"
  });
};

const issueLoginOtpChallenge = async (user, { local = false } = {}) => {
  const destination = getLoginOtpDestination(user);
  if (destination.channel === "none") {
    throw new Error("No email or phone is configured for OTP delivery");
  }

  const challenge = createLoginOtpChallenge();
  const persistedUser = local
    ? attachLoginOtpChallengeLocal(user, challenge, destination)
    : await attachLoginOtpChallengeDb(user, challenge, destination);
  const hookResult = await sendLoginOtpHook({
    user: persistedUser,
    destination,
    challenge
  });

  if (!hookResult?.dispatched && IS_PRODUCTION) {
    if (local) {
      clearLoginOtpStateLocal(persistedUser);
    } else {
      await clearLoginOtpStateDb(persistedUser);
    }
    throw new Error("Unable to deliver verification code right now");
  }

  return buildLoginOtpRequiredPayload({
    email: normalizeEmail(user?.email || ""),
    challenge,
    destination,
    hookResult
  });
};

const createAccountRecoveryChallenge = () => {
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + ACCOUNT_RECOVERY_OTP_TTL_MINUTES * 60 * 1000);
  const challengeId = crypto.randomBytes(16).toString("hex");

  return {
    code,
    codeHash: hashLoginOtp(code),
    expiresAt,
    challengeId
  };
};

const findDbUsersByPhone = async (phone, { activeOnly = true } = {}) => {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return [];
  }

  const query = {
    phone: normalizedPhone
  };

  if (activeOnly) {
    query.isActive = true;
  }

  return User.find(query).limit(2);
};

const resolveDbUserByIdentifier = async (identifier, { activeOnly = true } = {}) => {
  const normalizedIdentifier = normalize(identifier);
  if (!normalizedIdentifier) {
    throw createHttpError(400, "Email or phone number is required");
  }

  if (looksLikeEmail(normalizedIdentifier)) {
    const user = await User.findOne({
      email: normalizeEmail(normalizedIdentifier),
      ...(activeOnly ? { isActive: true } : {})
    });

    if (!user) {
      throw createHttpError(404, GENERIC_RECOVERY_IDENTIFIER_ERROR);
    }

    return {
      user,
      identifierType: "email",
      normalizedIdentifier: normalizeEmail(normalizedIdentifier)
    };
  }

  const users = await findDbUsersByPhone(normalizedIdentifier, { activeOnly });
  if (!users.length) {
    throw createHttpError(404, GENERIC_RECOVERY_IDENTIFIER_ERROR);
  }

  if (users.length > 1) {
    throw createHttpError(
      409,
      "Multiple accounts match this phone number. Use your registered email instead."
    );
  }

  return {
    user: users[0],
    identifierType: "phone",
    normalizedIdentifier: normalizePhone(normalizedIdentifier)
  };
};

const resolveLocalUserByIdentifier = (identifier, { activeOnly = true } = {}) => {
  const normalizedIdentifier = normalize(identifier);
  if (!normalizedIdentifier) {
    throw createHttpError(400, "Email or phone number is required");
  }

  if (looksLikeEmail(normalizedIdentifier)) {
    const user = findLocalUserByEmail(normalizedIdentifier, { activeOnly });
    if (!user) {
      throw createHttpError(404, GENERIC_RECOVERY_IDENTIFIER_ERROR);
    }

    return {
      user,
      identifierType: "email",
      normalizedIdentifier: normalizeEmail(normalizedIdentifier)
    };
  }

  const users = findLocalUsersByPhone(normalizedIdentifier, { activeOnly });
  if (!users.length) {
    throw createHttpError(404, GENERIC_RECOVERY_IDENTIFIER_ERROR);
  }

  if (users.length > 1) {
    throw createHttpError(
      409,
      "Multiple accounts match this phone number. Use your registered email instead."
    );
  }

  return {
    user: users[0],
    identifierType: "phone",
    normalizedIdentifier: normalizePhone(normalizedIdentifier)
  };
};

const buildRecoveryDestination = (identifierType, identifierValue) => {
  if (identifierType === "phone") {
    const normalizedPhone = normalizePhone(identifierValue);
    return {
      channel: "sms",
      value: normalizedPhone,
      maskedValue: maskPhoneNumber(normalizedPhone)
    };
  }

  const normalizedEmail = normalizeEmail(identifierValue);
  return {
    channel: "email",
    value: normalizedEmail,
    maskedValue: maskEmailAddress(normalizedEmail)
  };
};

const buildAccountRecoveryRequiredPayload = ({
  user,
  challenge,
  destination,
  hookResult,
  purpose
}) => {
  const normalizedPurpose = String(purpose || "password_reset").toLowerCase();
  const actionLabel =
    normalizedPurpose === "username_recovery" ? "username recovery" : "password reset";
  const payload = {
    recoveryRequired: true,
    purpose: normalizedPurpose,
    challengeId: challenge.challengeId,
    channel: destination.channel,
    destination: destination.maskedValue,
    otpExpiresAt: challenge.expiresAt,
    message: destination.maskedValue
      ? `Recovery code sent to ${destination.maskedValue}`
      : `Recovery code generated. Complete ${actionLabel} verification to continue.`,
    delivery: {
      dispatched: Boolean(hookResult?.dispatched),
      provider: hookResult?.channel || "none"
    }
  };

  if (INCLUDE_DEV_ACCOUNT_RECOVERY_OTP_CODE) {
    payload.otpCode = challenge.code;
  }

  if (normalizedPurpose === "username_recovery") {
    payload.loginEmail = normalizeEmail(user?.email || "");
  }

  return payload;
};

const attachAccountRecoveryChallengeDb = async (user, challenge, destination, purpose) => {
  user.accountRecoveryOtpHash = challenge.codeHash;
  user.accountRecoveryOtpExpiresAt = challenge.expiresAt;
  user.accountRecoveryOtpAttempts = 0;
  user.accountRecoveryOtpChallengeId = challenge.challengeId;
  user.accountRecoveryOtpChannel = destination.channel;
  user.accountRecoveryOtpDestination = destination.value;
  user.accountRecoveryOtpPurpose = purpose;
  await user.save();
  return user;
};

const attachAccountRecoveryChallengeLocal = (user, challenge, destination, purpose) => {
  return updateLocalUser(user, {
    accountRecoveryOtpHash: challenge.codeHash,
    accountRecoveryOtpExpiresAt: challenge.expiresAt,
    accountRecoveryOtpAttempts: 0,
    accountRecoveryOtpChallengeId: challenge.challengeId,
    accountRecoveryOtpChannel: destination.channel,
    accountRecoveryOtpDestination: destination.value,
    accountRecoveryOtpPurpose: purpose
  });
};

const clearAccountRecoveryStateDb = async (user) => {
  user.accountRecoveryOtpHash = "";
  user.accountRecoveryOtpExpiresAt = null;
  user.accountRecoveryOtpAttempts = 0;
  user.accountRecoveryOtpChallengeId = "";
  user.accountRecoveryOtpChannel = "none";
  user.accountRecoveryOtpDestination = "";
  user.accountRecoveryOtpPurpose = "none";
  await user.save();
  return user;
};

const clearAccountRecoveryStateLocal = (user) => {
  return updateLocalUser(user, {
    accountRecoveryOtpHash: "",
    accountRecoveryOtpExpiresAt: null,
    accountRecoveryOtpAttempts: 0,
    accountRecoveryOtpChallengeId: "",
    accountRecoveryOtpChannel: "none",
    accountRecoveryOtpDestination: "",
    accountRecoveryOtpPurpose: "none"
  });
};

const incrementAccountRecoveryAttemptsDb = async (user) => {
  user.accountRecoveryOtpAttempts = Number(user.accountRecoveryOtpAttempts || 0) + 1;
  await user.save();
  return user;
};

const incrementAccountRecoveryAttemptsLocal = (user) => {
  return updateLocalUser(user, {
    accountRecoveryOtpAttempts: Number(user.accountRecoveryOtpAttempts || 0) + 1
  });
};

const issueAccountRecoveryChallenge = async (
  user,
  {
    destination,
    purpose,
    local = false
  } = {}
) => {
  if (!destination?.value || destination.channel === "none") {
    throw createHttpError(
      400,
      "A valid email or phone number is required for account recovery."
    );
  }

  const challenge = createAccountRecoveryChallenge();
  const persistedUser = local
    ? attachAccountRecoveryChallengeLocal(user, challenge, destination, purpose)
    : await attachAccountRecoveryChallengeDb(user, challenge, destination, purpose);
  const hookResult = await dispatchAccountRecoveryOtpHook({
    channel: destination.channel,
    email: destination.channel === "email" ? destination.value : "",
    phone: destination.channel === "sms" ? destination.value : "",
    otpCode: challenge.code,
    expiresAt: challenge.expiresAt,
    name: persistedUser?.name || user?.name || "User",
    purpose
  });

  if (!hookResult?.dispatched && IS_PRODUCTION) {
    if (local) {
      clearAccountRecoveryStateLocal(persistedUser);
    } else {
      await clearAccountRecoveryStateDb(persistedUser);
    }

    throw createHttpError(
      503,
      "Recovery code could not be delivered right now. Configure Resend email or Twilio SMS on the server."
    );
  }

  return buildAccountRecoveryRequiredPayload({
    user,
    challenge,
    destination,
    hookResult,
    purpose
  });
};

const verifyAccountRecoveryChallengeDb = async ({
  identifier,
  code,
  challengeId,
  purpose
}) => {
  const { user } = await resolveDbUserByIdentifier(identifier, { activeOnly: true });
  const expectedHash = String(user.accountRecoveryOtpHash || "");

  if (!expectedHash || String(user.accountRecoveryOtpPurpose || "none") !== purpose) {
    throw createHttpError(400, "No pending recovery code was found. Request a new code.");
  }

  if (challengeId && challengeId !== String(user.accountRecoveryOtpChallengeId || "")) {
    throw createHttpError(401, "Enter the correct recovery code.");
  }

  if (isLoginOtpExpired(user.accountRecoveryOtpExpiresAt)) {
    await clearAccountRecoveryStateDb(user);
    throw createHttpError(401, "Recovery code has expired. Request a new code.");
  }

  if (expectedHash !== hashLoginOtp(code)) {
    const updated = await incrementAccountRecoveryAttemptsDb(user);
    if (Number(updated.accountRecoveryOtpAttempts || 0) >= ACCOUNT_RECOVERY_OTP_MAX_ATTEMPTS) {
      await clearAccountRecoveryStateDb(updated);
      throw createHttpError(429, "Too many invalid attempts. Request a new recovery code.");
    }

    throw createHttpError(401, "Enter the correct recovery code.");
  }

  return user;
};

const verifyAccountRecoveryChallengeLocal = ({
  identifier,
  code,
  challengeId,
  purpose
}) => {
  const { user } = resolveLocalUserByIdentifier(identifier, { activeOnly: true });
  const expectedHash = String(user.accountRecoveryOtpHash || "");

  if (!expectedHash || String(user.accountRecoveryOtpPurpose || "none") !== purpose) {
    throw createHttpError(400, "No pending recovery code was found. Request a new code.");
  }

  if (challengeId && challengeId !== String(user.accountRecoveryOtpChallengeId || "")) {
    throw createHttpError(401, "Enter the correct recovery code.");
  }

  if (isLoginOtpExpired(user.accountRecoveryOtpExpiresAt)) {
    clearAccountRecoveryStateLocal(user);
    throw createHttpError(401, "Recovery code has expired. Request a new code.");
  }

  if (expectedHash !== hashLoginOtp(code)) {
    const updated = incrementAccountRecoveryAttemptsLocal(user);
    if (Number(updated.accountRecoveryOtpAttempts || 0) >= ACCOUNT_RECOVERY_OTP_MAX_ATTEMPTS) {
      clearAccountRecoveryStateLocal(updated);
      throw createHttpError(429, "Too many invalid attempts. Request a new recovery code.");
    }

    throw createHttpError(401, "Enter the correct recovery code.");
  }

  return user;
};

const createRestaurantOwnerDbAccount = async ({
  restaurantName,
  ownerName,
  email,
  phone,
  businessType,
  passwordHash,
  emailVerified
}) => {
  const now = new Date();
  const trialEndsAt = getTrialEndDate(now);
  const ownerPayload = {
    name: ownerName,
    email,
    phone,
    passwordHash,
    role: "OWNER",
    businessType: normalizeBusinessType(businessType, ""),
    provider: "local",
    emailVerified: Boolean(emailVerified),
    restaurantId: null
  };

  const restaurantPayload = {
    name: restaurantName,
    restaurantName,
    ownerName,
    email,
    phone,
    ownerId: null,
    businessType: normalizeBusinessType(businessType),
    subscriptionPlan: "STARTER",
    subscriptionExpiry: trialEndsAt,
    status: "ACTIVE"
  };

  let session;

  try {
    session = await mongoose.startSession();
    let createdUser = null;

    await session.withTransaction(async () => {
      const [restaurant] = await Restaurant.create([restaurantPayload], { session });
      ownerPayload.restaurantId = restaurant._id;
      const [user] = await User.create([ownerPayload], { session });
      restaurant.ownerId = user._id;
      await restaurant.save({ session });
      await Membership.create(
        [
          {
            userId: user._id,
            tenantId: restaurant._id,
            role: MEMBERSHIP_ROLES.OWNER
          }
        ],
        { session }
      );
      await Subscription.create(
        [
          {
            restaurantId: restaurant._id,
            plan: "STARTER",
            status: "TRIAL",
            startDate: now,
            expiryDate: trialEndsAt,
            trialEndsAt
          }
        ],
        { session }
      );
      createdUser = user;
    });

    return createdUser;
  } catch (err) {
    const message = String(err?.message || "");
    const transactionUnsupported =
      message.includes("Transaction numbers are only allowed") ||
      message.includes("replica set") ||
      message.includes("sharded cluster");

    if (!transactionUnsupported) {
      throw err;
    }

    const restaurant = await Restaurant.create(restaurantPayload);

    try {
      ownerPayload.restaurantId = restaurant._id;
      const createdUser = await User.create(ownerPayload);
      restaurant.ownerId = createdUser._id;
      await restaurant.save();
      await Membership.findOneAndUpdate(
        {
          userId: createdUser._id,
          tenantId: restaurant._id
        },
        {
          $setOnInsert: {
            userId: createdUser._id,
            tenantId: restaurant._id,
            role: MEMBERSHIP_ROLES.OWNER
          }
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true
        }
      );
      await Subscription.findOneAndUpdate(
        { restaurantId: restaurant._id },
        {
          restaurantId: restaurant._id,
          plan: "STARTER",
          status: "TRIAL",
          startDate: now,
          expiryDate: trialEndsAt,
          trialEndsAt
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true
        }
      );
      return createdUser;
    } catch (createErr) {
      if (ownerPayload.restaurantId) {
        await User.findOneAndDelete({ restaurantId: ownerPayload.restaurantId, email }).catch(() => {});
      }
      await Subscription.deleteOne({ restaurantId: restaurant._id }).catch(() => {});
      await Restaurant.findByIdAndDelete(restaurant._id);
      throw createErr;
    }
  } finally {
    if (session) {
      await session.endSession();
    }
  }
};

/**
 * RESTAURANT SIGNUP (OWNER)
 */
const registerHandler = async (req, res) => {
  try {
    console.log("AUTH SIGNUP BODY:", req.body);
    const { restaurantName, name, email, password, phone } = req.body;
    const normalizedEmail = normalizeEmail(email);
    const trimmedRestaurantName = (restaurantName || "").trim();
    const trimmedName = (name || "").trim();
    const trimmedPhone = normalizePhone(phone);
    const businessType = normalizeBusinessType(req.body?.businessType, "");
    const requireVerification = shouldRequireVerificationForProvider("local");

    const missingFields = [];
    if (!trimmedRestaurantName) missingFields.push("restaurantName");
    if (!trimmedName) missingFields.push("name");
    if (!normalizedEmail) missingFields.push("email");
    if (!password) missingFields.push("password");
    if (!businessType) missingFields.push("businessType");

    if (missingFields.length > 0) {
      return res.status(400).json({
        message: `Missing required fields: ${missingFields.join(", ")}`
      });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters" });
    }

    if (isDbConnected()) {
      const matchingPhoneUsers = await findDbUsersByPhone(trimmedPhone, { activeOnly: false });
      const hasPhoneConflict = matchingPhoneUsers.some(
        (user) => normalizeEmail(user.email) !== normalizedEmail
      );

      if (hasPhoneConflict) {
        return res.status(409).json({
          message: "Phone number is already linked to another account. Use a different number."
        });
      }

      const existing = await User.findOne({ email: normalizedEmail });
      if (existing) {
        if (existing.passwordHash && existing.provider !== "google") {
          return res.status(409).json({
            message: "Account already exists. Please login or reset password."
          });
        }

        if (!existing.restaurantId) {
          const now = new Date();
          const trialEndsAt = getTrialEndDate(now);
          const restaurant = await Restaurant.create({
            name: trimmedRestaurantName,
            restaurantName: trimmedRestaurantName,
            ownerName: trimmedName,
            email: normalizedEmail,
            phone: trimmedPhone,
            businessType,
            subscriptionPlan: "STARTER",
            subscriptionExpiry: trialEndsAt,
            status: "ACTIVE"
          });
          existing.restaurantId = restaurant._id;
          await Membership.findOneAndUpdate(
            {
              userId: existing._id,
              tenantId: restaurant._id
            },
            {
              $setOnInsert: {
                userId: existing._id,
                tenantId: restaurant._id,
                role: MEMBERSHIP_ROLES.OWNER
              }
            },
            {
              upsert: true,
              setDefaultsOnInsert: true,
              new: true
            }
          );

          await Subscription.findOneAndUpdate(
            { restaurantId: restaurant._id },
            {
              restaurantId: restaurant._id,
              plan: "STARTER",
              status: "TRIAL",
              startDate: now,
              expiryDate: trialEndsAt,
              trialEndsAt
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true
            }
          );
        }

        const wasGoogleAccount = existing.provider === "google";
        existing.name = trimmedName;
        existing.phone = trimmedPhone;
        existing.passwordHash = await bcrypt.hash(password, 10);
        existing.provider = "local";
        existing.isActive = true;
        existing.emailVerified = wasGoogleAccount ? true : !requireVerification;

        if (existing.emailVerified) {
          existing.emailVerificationTokenHash = "";
          existing.emailVerificationExpiresAt = null;
        }

        await existing.save();
        await Restaurant.findByIdAndUpdate(existing.restaurantId, {
          ownerId: existing._id,
          ownerName: trimmedName,
          businessType,
          email: normalizedEmail,
          phone: trimmedPhone
        });
        await Membership.findOneAndUpdate(
          {
            userId: existing._id,
            tenantId: existing.restaurantId
          },
          {
            $setOnInsert: {
              userId: existing._id,
              tenantId: existing.restaurantId,
              role: MEMBERSHIP_ROLES.OWNER
            }
          },
          {
            upsert: true,
            setDefaultsOnInsert: true,
            new: true
          }
        );

        if (!existing.emailVerified) {
          const challenge = await attachVerificationChallengeDb(existing);
          const restaurant = existing.restaurantId
            ? await Restaurant.findById(existing.restaurantId).lean()
            : null;
          const hookResult = await sendVerificationHook({
            email: existing.email,
            token: challenge.token,
            name: existing.name,
            restaurantName: restaurant?.name || trimmedRestaurantName,
            expiresAt: challenge.expiresAt
          });

          return res.status(201).json(
            buildVerificationRequiredPayload({
              email: existing.email,
              token: challenge.token,
              expiresAt: challenge.expiresAt,
              hookResult
            })
          );
        }

        return sendAuthPayload(res, existing, { req });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await createRestaurantOwnerDbAccount({
        restaurantName: trimmedRestaurantName,
        ownerName: trimmedName,
        email: normalizedEmail,
        phone: trimmedPhone,
        businessType,
        passwordHash,
        emailVerified: !requireVerification
      });

      if (requireVerification) {
        const challenge = await attachVerificationChallengeDb(user);
        const hookResult = await sendVerificationHook({
          email: user.email,
          token: challenge.token,
          name: user.name,
          restaurantName: trimmedRestaurantName,
          expiresAt: challenge.expiresAt
        });

        return res.status(201).json(
          buildVerificationRequiredPayload({
            email: user.email,
            token: challenge.token,
            expiresAt: challenge.expiresAt,
            hookResult
          })
        );
      }

      return sendAuthPayload(res, user, { req });
    }

    const matchingLocalPhoneUsers = findLocalUsersByPhone(trimmedPhone, { activeOnly: false });
    const hasLocalPhoneConflict = matchingLocalPhoneUsers.some(
      (user) => normalizeEmail(user.email) !== normalizedEmail
    );

    if (hasLocalPhoneConflict) {
      return res.status(409).json({
        message: "Phone number is already linked to another account. Use a different number."
      });
    }

    const existingLocalUser = findLocalUserByEmail(normalizedEmail, {
      activeOnly: false
    });

    if (existingLocalUser) {
      if (existingLocalUser.passwordHash && existingLocalUser.provider !== "google") {
        return res.status(409).json({
          message: "Account already exists. Please login or reset password."
        });
      }

      const wasGoogleAccount = existingLocalUser.provider === "google";
      const passwordHash = await bcrypt.hash(password, 10);
      let updatedUser = updateLocalUser(existingLocalUser, {
        name: trimmedName,
        phone: trimmedPhone,
        passwordHash,
        businessType,
        provider: "local",
        isActive: true,
        emailVerified: wasGoogleAccount ? true : !requireVerification
      });

      if (!updatedUser.restaurantId) {
        const restaurant = createLocalRestaurant(trimmedRestaurantName, {
          ownerName: trimmedName,
          email: normalizedEmail,
          phone: trimmedPhone,
          businessType
        });
        updatedUser = updateLocalUser(updatedUser, { restaurantId: restaurant._id });
      }

      if (!updatedUser.emailVerified) {
        const { user, challenge } = attachVerificationChallengeLocal(updatedUser);
        const localRestaurant = user.restaurantId
          ? findLocalRestaurantById(user.restaurantId)
          : null;
        const hookResult = await sendVerificationHook({
          email: user.email,
          token: challenge.token,
          name: user.name,
          restaurantName: localRestaurant?.name || trimmedRestaurantName,
          expiresAt: challenge.expiresAt
        });

        return res.status(201).json(
          buildVerificationRequiredPayload({
            email: user.email,
            token: challenge.token,
            expiresAt: challenge.expiresAt,
            hookResult
          })
        );
      }

      updatedUser = updateLocalUser(updatedUser, {
        emailVerificationTokenHash: "",
        emailVerificationExpiresAt: null
      });
      return sendAuthPayload(res, updatedUser, { req });
    }

    const localRestaurant = createLocalRestaurant(trimmedRestaurantName, {
      ownerName: trimmedName,
      email: normalizedEmail,
      phone: trimmedPhone,
      businessType
    });
    const localPasswordHash = await bcrypt.hash(password, 10);

    const localUser = createLocalUser({
      name: trimmedName,
      email: normalizedEmail,
      phone: trimmedPhone,
      passwordHash: localPasswordHash,
      role: "OWNER",
      businessType,
      provider: "local",
      restaurantId: localRestaurant._id,
      emailVerified: !requireVerification,
      isActive: true
    });

    if (requireVerification) {
      const { user, challenge } = attachVerificationChallengeLocal(localUser);
      const hookResult = await sendVerificationHook({
        email: user.email,
        token: challenge.token,
        name: user.name,
        restaurantName: localRestaurant.name || trimmedRestaurantName,
        expiresAt: challenge.expiresAt
      });

      return res.status(201).json(
        buildVerificationRequiredPayload({
          email: user.email,
          token: challenge.token,
          expiresAt: challenge.expiresAt,
          hookResult
        })
      );
    }

    return sendAuthPayload(res, localUser, { req });
  } catch (err) {
    console.error("[auth-signup]", err);
    return sendAuthRouteError(res, err);
  }
};

router.post("/signup", loginRateLimit, registerHandler);
router.post("/register", loginRateLimit, registerHandler);

router.post("/super-admin/login", loginRateLimit, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = normalize(req.body?.password);
    const configured = getConfiguredSuperAdmin();

    if (!configured.email || !configured.password) {
      return res.status(503).json({
        message: "Super admin login is not configured"
      });
    }

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    if (email !== configured.email || password !== configured.password) {
      return res.status(401).json({ message: "Invalid super admin credentials" });
    }

    const user = buildEnvSuperAdminUser();
    return sendAuthPayload(res, user, { req });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

router.post("/verify-email", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const rawToken = String(req.body?.code || req.body?.token || "").trim();

    if (!email || !rawToken) {
      return res.status(400).json({ message: "email and code are required" });
    }

    if (isDbConnected()) {
      const user = await User.findOne({ email });
      if (!user) {
        return res.status(400).json({ message: "Invalid or expired verification code" });
      }

      if (user.emailVerified) {
        const authContext = await resolveAuthTenantContext(user);
        return res.json({
          message: "Email is already verified",
          verified: true,
          ...buildAuthPayload(user, authContext)
        });
      }

      const expectedHash = String(user.emailVerificationTokenHash || "");
      const expiresAt = user.emailVerificationExpiresAt
        ? new Date(user.emailVerificationExpiresAt)
        : null;
      const isExpired = !expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt < new Date();

      if (!expectedHash || isExpired || expectedHash !== hashVerificationToken(rawToken)) {
        return res.status(400).json({ message: "Invalid or expired verification code" });
      }

      await clearVerificationStateDb(user);
      const authContext = await resolveAuthTenantContext(user);

      return res.json({
        message: "Email verified successfully",
        verified: true,
        ...buildAuthPayload(user, authContext)
      });
    }

    const localUser = findLocalUserByEmail(email, { activeOnly: false });
    if (!localUser) {
      return res.status(400).json({ message: "Invalid or expired verification code" });
    }

    if (localUser.emailVerified) {
      const authContext = await resolveAuthTenantContext(localUser);
      return res.json({
        message: "Email is already verified",
        verified: true,
        ...buildAuthPayload(localUser, authContext)
      });
    }

    const expectedHash = String(localUser.emailVerificationTokenHash || "");
    const expiresAt = localUser.emailVerificationExpiresAt
      ? new Date(localUser.emailVerificationExpiresAt)
      : null;
    const isExpired = !expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt < new Date();

    if (!expectedHash || isExpired || expectedHash !== hashVerificationToken(rawToken)) {
      return res.status(400).json({ message: "Invalid or expired verification code" });
    }

    const verifiedUser = clearVerificationStateLocal(localUser);
    const authContext = await resolveAuthTenantContext(verifiedUser);
    return res.json({
      message: "Email verified successfully",
      verified: true,
      ...buildAuthPayload(verifiedUser, authContext)
    });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

router.post("/resend-verification", loginRateLimit, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ message: "email is required" });
    }

    if (isDbConnected()) {
      const user = await User.findOne({ email });
      if (!user || user.provider === "google" || user.emailVerified) {
        return res.json({ message: GENERIC_RESEND_VERIFICATION_MESSAGE });
      }

      const challenge = await attachVerificationChallengeDb(user);
      const restaurant = user.restaurantId
        ? await Restaurant.findById(user.restaurantId).lean()
        : null;
      const hookResult = await sendVerificationHook({
        email: user.email,
        token: challenge.token,
        name: user.name,
        restaurantName: restaurant?.name || "Restaurant",
        expiresAt: challenge.expiresAt
      });

      const response = {
        message: "A verification code has been sent to your email.",
        verificationRequired: true,
        email: user.email,
        verificationExpiresAt: challenge.expiresAt,
        delivery: {
          channel: hookResult?.channel || "email",
          destination: maskEmailAddress(user.email),
          dispatched: Boolean(hookResult?.dispatched)
        }
      };

      if (INCLUDE_DEV_VERIFICATION_TOKEN) {
        response.verificationToken = challenge.token;
        if (hookResult?.verificationUrl) {
          response.verificationUrl = hookResult.verificationUrl;
        }
      }

      if (IS_PRODUCTION) {
        return res.json({ message: GENERIC_RESEND_VERIFICATION_MESSAGE });
      }

      response.message = GENERIC_RESEND_VERIFICATION_MESSAGE;

      return res.json(response);
    }

    const localUser = findLocalUserByEmail(email, { activeOnly: false });
    if (!localUser || localUser.provider === "google" || localUser.emailVerified) {
      return res.json({ message: GENERIC_RESEND_VERIFICATION_MESSAGE });
    }

    const { user, challenge } = attachVerificationChallengeLocal(localUser);
    const localRestaurant = user.restaurantId
      ? findLocalRestaurantById(user.restaurantId)
      : null;
    const hookResult = await sendVerificationHook({
      email: user.email,
      token: challenge.token,
      name: user.name,
      restaurantName: localRestaurant?.name || "Restaurant",
      expiresAt: challenge.expiresAt
    });

    const response = {
      message: "A verification code has been sent to your email.",
      verificationRequired: true,
      email: user.email,
      verificationExpiresAt: challenge.expiresAt,
      delivery: {
        channel: hookResult?.channel || "email",
        destination: maskEmailAddress(user.email),
        dispatched: Boolean(hookResult?.dispatched)
      }
    };

    if (INCLUDE_DEV_VERIFICATION_TOKEN) {
      response.verificationToken = challenge.token;
      if (hookResult?.verificationUrl) {
        response.verificationUrl = hookResult.verificationUrl;
      }
    }

    if (IS_PRODUCTION) {
      return res.json({ message: GENERIC_RESEND_VERIFICATION_MESSAGE });
    }

    response.message = GENERIC_RESEND_VERIFICATION_MESSAGE;

    return res.json(response);
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

/**
 * LOGIN (ALL ROLES)
 */
router.post("/login", loginRateLimit, async (req, res) => {
  try {
    console.log("AUTH LOGIN BODY:", req.body);
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    if (isDbConnected()) {
      const user = await User.findOne({ email: normalizedEmail, isActive: true });
      if (!user) {
        return res.status(401).json({ message: GENERIC_AUTH_FAILURE_MESSAGE });
      }

      if (!user.passwordHash) {
        return res.status(401).json({ message: GENERIC_AUTH_FAILURE_MESSAGE });
      }

      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) {
        return res.status(401).json({ message: GENERIC_AUTH_FAILURE_MESSAGE });
      }

      if (isVerificationPending(user)) {
        return res.status(403).json({
          message: "Please verify your email before logging in.",
          verificationRequired: true
        });
      }

      if (LOGIN_OTP_ENABLED) {
        const otpResponse = await issueLoginOtpChallenge(user);
        return res.status(202).json(otpResponse);
      }

      const restaurant = user.restaurantId
        ? await Restaurant.findById(user.restaurantId)
        : null;
      const normalizedAuth = await ensureAuthBusinessType({ user, restaurant });
      console.log("LOGIN USER TYPE:", normalizedAuth.businessType);
      return sendAuthPayload(res, normalizedAuth.user, { req });
    }

    let localUser = findLocalUserByEmail(normalizedEmail, { activeOnly: true });

    if (!localUser) {
      return res.status(401).json({ message: GENERIC_AUTH_FAILURE_MESSAGE });
    }

    if (!localUser.passwordHash) {
      return res.status(401).json({ message: GENERIC_AUTH_FAILURE_MESSAGE });
    }

    const match = await bcrypt.compare(password, localUser.passwordHash);
    if (!match) {
      return res.status(401).json({ message: GENERIC_AUTH_FAILURE_MESSAGE });
    }

    if (isVerificationPending(localUser)) {
      return res.status(403).json({
        message: "Please verify your email before logging in.",
        verificationRequired: true
      });
    }

    if (LOGIN_OTP_ENABLED) {
      const otpResponse = await issueLoginOtpChallenge(localUser, { local: true });
      return res.status(202).json(otpResponse);
    }

    const localRestaurant = localUser.restaurantId
      ? findLocalRestaurantById(localUser.restaurantId)
      : null;
    const normalizedAuth = await ensureAuthBusinessType({
      user: localUser,
      restaurant: localRestaurant,
      local: true
    });
    console.log("LOGIN USER TYPE:", normalizedAuth.businessType);
    return sendAuthPayload(res, normalizedAuth.user, { req });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

router.post("/verify-login-otp", loginRateLimit, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || "").trim();
    const challengeId = String(req.body?.challengeId || "").trim();

    if (!LOGIN_OTP_ENABLED) {
      return res.status(400).json({ message: "Login OTP is disabled" });
    }

    if (!email || !code) {
      return res.status(400).json({ message: "email and code are required" });
    }

    if (isDbConnected()) {
      const user = await User.findOne({ email, isActive: true });
      if (!user) {
        return res.status(401).json({ message: "Invalid or expired verification code" });
      }

      const expectedHash = String(user.loginOtpHash || "");
      if (!expectedHash) {
        return res.status(400).json({ message: "No pending login verification code found" });
      }

      if (challengeId && challengeId !== String(user.loginOtpChallengeId || "")) {
        return res.status(401).json({ message: "Invalid or expired verification code" });
      }

      if (isLoginOtpExpired(user.loginOtpExpiresAt)) {
        await clearLoginOtpStateDb(user);
        return res.status(401).json({ message: "Verification code has expired. Login again." });
      }

      if (expectedHash !== hashLoginOtp(code)) {
        const updated = await incrementLoginOtpAttemptsDb(user);
        if (Number(updated.loginOtpAttempts || 0) >= LOGIN_OTP_MAX_ATTEMPTS) {
          await clearLoginOtpStateDb(updated);
          return res.status(429).json({
            message: "Too many invalid verification attempts. Please login again."
          });
        }

        return res.status(401).json({ message: "Invalid verification code" });
      }

      await clearLoginOtpStateDb(user);
      return sendAuthPayload(res, user, { req });
    }

    const localUser = findLocalUserByEmail(email, { activeOnly: true });
    if (!localUser) {
      return res.status(401).json({ message: "Invalid or expired verification code" });
    }

    const expectedHash = String(localUser.loginOtpHash || "");
    if (!expectedHash) {
      return res.status(400).json({ message: "No pending login verification code found" });
    }

    if (challengeId && challengeId !== String(localUser.loginOtpChallengeId || "")) {
      return res.status(401).json({ message: "Invalid or expired verification code" });
    }

    if (isLoginOtpExpired(localUser.loginOtpExpiresAt)) {
      clearLoginOtpStateLocal(localUser);
      return res.status(401).json({ message: "Verification code has expired. Login again." });
    }

    if (expectedHash !== hashLoginOtp(code)) {
      const updated = incrementLoginOtpAttemptsLocal(localUser);
      if (Number(updated.loginOtpAttempts || 0) >= LOGIN_OTP_MAX_ATTEMPTS) {
        clearLoginOtpStateLocal(updated);
        return res.status(429).json({
          message: "Too many invalid verification attempts. Please login again."
        });
      }

      return res.status(401).json({ message: "Invalid verification code" });
    }

    const verifiedUser = clearLoginOtpStateLocal(localUser);
    return sendAuthPayload(res, verifiedUser, { req });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = String(
      req.body?.refreshToken || getAuthCookiesFromRequest(req).refreshToken || ""
    );
    if (!refreshToken) {
      return res.status(400).json({ message: "refreshToken is required" });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    if (decoded?.type !== "refresh") {
      return res.status(401).json({ message: "Invalid refresh token type" });
    }

    if (String(decoded?.role || "").toUpperCase() === "SUPER_ADMIN") {
      const configured = getConfiguredSuperAdmin();
      if (!configured.email) {
        clearAuthCookies(res);
        return res.status(401).json({ message: "Super admin session is not configured" });
      }

      return sendAuthPayload(res, buildEnvSuperAdminUser(), { req });
    }

    if (isDbConnected()) {
      const user = await User.findById(decoded.userId);
      if (!user || user.isActive === false) {
        return res.status(401).json({ message: "User not found or inactive" });
      }

      const tokenVersion = Number(user.refreshTokenVersion || 0);
      if (tokenVersion !== Number(decoded.tokenVersion || 0)) {
        return res.status(401).json({ message: "Refresh token expired. Please login again." });
      }

      return sendAuthPayload(res, user, { req });
    }

    const localUser = findLocalUserById(decoded.userId);
    if (!localUser || localUser.isActive === false) {
      return res.status(401).json({ message: "User not found or inactive" });
    }

    const tokenVersion = getRefreshTokenVersion(localUser);
    if (tokenVersion !== Number(decoded.tokenVersion || 0)) {
      return res.status(401).json({ message: "Refresh token expired. Please login again." });
    }

    return sendAuthPayload(res, localUser, { req });
  } catch (err) {
    clearAuthCookies(res);
    return res.status(401).json({ message: "Invalid or expired refresh token" });
  }
});

router.post("/logout", authMiddleware, async (req, res) => {
  try {
    await bumpRefreshTokenVersion(req.user?.userId);
    clearAuthCookies(res);
    return res.json({ message: "Logged out successfully" });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

router.post("/forgot-password/request", loginRateLimit, async (req, res) => {
  try {
    const identifier = normalize(req.body?.identifier || req.body?.email || req.body?.phone);
    if (!identifier) {
      return res.status(400).json({ message: "Email or phone number is required" });
    }

    if (isDbConnected()) {
      const resolved = await resolveDbUserByIdentifier(identifier, { activeOnly: true });
      const destination = buildRecoveryDestination(
        resolved.identifierType,
        resolved.normalizedIdentifier
      );
      const response = await issueAccountRecoveryChallenge(resolved.user, {
        destination,
        purpose: "password_reset"
      });

      return res.json(response);
    }

    const resolved = resolveLocalUserByIdentifier(identifier, { activeOnly: true });
    const destination = buildRecoveryDestination(
      resolved.identifierType,
      resolved.normalizedIdentifier
    );
    const response = await issueAccountRecoveryChallenge(resolved.user, {
      destination,
      purpose: "password_reset",
      local: true
    });

    return res.json(response);
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

router.post("/forgot-password/verify", loginRateLimit, async (req, res) => {
  try {
    const identifier = normalize(req.body?.identifier || req.body?.email || req.body?.phone);
    const code = normalize(req.body?.code);
    const challengeId = normalize(req.body?.challengeId);
    const newPassword = String(req.body?.newPassword || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (!identifier || !code || !newPassword || !confirmPassword) {
      return res.status(400).json({
        message: "Email or phone number, code, and new password are required"
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Password and confirm password do not match" });
    }

    if (isDbConnected()) {
      const user = await verifyAccountRecoveryChallengeDb({
        identifier,
        code,
        challengeId,
        purpose: "password_reset"
      });

      user.passwordHash = await bcrypt.hash(newPassword, 10);
      user.provider = "local";
      user.isActive = true;
      user.refreshTokenVersion = Number(user.refreshTokenVersion || 0) + 1;
      user.loginOtpHash = "";
      user.loginOtpExpiresAt = null;
      user.loginOtpAttempts = 0;
      user.loginOtpChallengeId = "";
      user.loginOtpChannel = "none";
      user.loginOtpDestination = "";
      await clearAccountRecoveryStateDb(user);

      return res.json({
        message: "Password reset successful. You can login with your new password.",
        loginEmail: normalizeEmail(user.email || "")
      });
    }

    const localUser = verifyAccountRecoveryChallengeLocal({
      identifier,
      code,
      challengeId,
      purpose: "password_reset"
    });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    updateLocalUser(localUser, {
      passwordHash,
      provider: "local",
      isActive: true,
      refreshTokenVersion: Number(localUser.refreshTokenVersion || 0) + 1,
      loginOtpHash: "",
      loginOtpExpiresAt: null,
      loginOtpAttempts: 0,
      loginOtpChallengeId: "",
      loginOtpChannel: "none",
      loginOtpDestination: "",
      accountRecoveryOtpHash: "",
      accountRecoveryOtpExpiresAt: null,
      accountRecoveryOtpAttempts: 0,
      accountRecoveryOtpChallengeId: "",
      accountRecoveryOtpChannel: "none",
      accountRecoveryOtpDestination: "",
      accountRecoveryOtpPurpose: "none"
    });

    return res.json({
      message: "Password reset successful. You can login with your new password.",
      loginEmail: normalizeEmail(localUser.email || "")
    });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

router.post("/forgot-username/request", loginRateLimit, async (req, res) => {
  try {
    const identifier = normalize(req.body?.identifier || req.body?.email || req.body?.phone);
    if (!identifier) {
      return res.status(400).json({ message: "Email or phone number is required" });
    }

    if (isDbConnected()) {
      const resolved = await resolveDbUserByIdentifier(identifier, { activeOnly: true });
      const destination = buildRecoveryDestination(
        resolved.identifierType,
        resolved.normalizedIdentifier
      );
      const response = await issueAccountRecoveryChallenge(resolved.user, {
        destination,
        purpose: "username_recovery"
      });

      return res.json(response);
    }

    const resolved = resolveLocalUserByIdentifier(identifier, { activeOnly: true });
    const destination = buildRecoveryDestination(
      resolved.identifierType,
      resolved.normalizedIdentifier
    );
    const response = await issueAccountRecoveryChallenge(resolved.user, {
      destination,
      purpose: "username_recovery",
      local: true
    });

    return res.json(response);
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

router.post("/forgot-username/verify", loginRateLimit, async (req, res) => {
  try {
    const identifier = normalize(req.body?.identifier || req.body?.email || req.body?.phone);
    const code = normalize(req.body?.code);
    const challengeId = normalize(req.body?.challengeId);

    if (!identifier || !code) {
      return res.status(400).json({
        message: "Email or phone number and code are required"
      });
    }

    if (isDbConnected()) {
      const user = await verifyAccountRecoveryChallengeDb({
        identifier,
        code,
        challengeId,
        purpose: "username_recovery"
      });

      await clearAccountRecoveryStateDb(user);

      return res.json({
        message: "Username recovered successfully.",
        loginEmail: normalizeEmail(user.email || ""),
        name: user.name || "User"
      });
    }

    const localUser = verifyAccountRecoveryChallengeLocal({
      identifier,
      code,
      challengeId,
      purpose: "username_recovery"
    });
    clearAccountRecoveryStateLocal(localUser);

    return res.json({
      message: "Username recovered successfully.",
      loginEmail: normalizeEmail(localUser.email || ""),
      name: localUser.name || "User"
    });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

/**
 * QUICK LOGIN (NO CREDENTIALS)
 */
router.post("/quick-login", async (req, res) => {
  try {
    if (!ALLOW_DEV_QUICK_LOGIN) {
      return res.status(403).json({ message: "Quick login is disabled" });
    }

    if (isDbConnected()) {
      let user = await User.findOne({ isActive: true }).sort({ createdAt: 1 });

      if (!user) {
        const restaurant = await Restaurant.create({
          name: "Demo Restaurant"
        });

        const email = `demo-${Date.now()}@restaurantcrm.local`;
        const passwordHash = await bcrypt.hash("demo-access", 10);

        user = await User.create({
          name: "Demo Owner",
          email,
          phone: "",
          passwordHash,
          role: "OWNER",
          provider: "local",
          restaurantId: restaurant._id,
          emailVerified: true
        });
      }

      if (!user.restaurantId) {
        const restaurant = await Restaurant.create({
          name: "Demo Restaurant"
        });
        user.restaurantId = restaurant._id;
        await user.save();
      }

      if (!user.emailVerified) {
        user.emailVerified = true;
        user.emailVerificationTokenHash = "";
        user.emailVerificationExpiresAt = null;
        user.loginOtpHash = "";
        user.loginOtpExpiresAt = null;
        user.loginOtpAttempts = 0;
        user.loginOtpChallengeId = "";
        user.loginOtpChannel = "none";
        user.loginOtpDestination = "";
        await user.save();
      }

      return sendAuthPayload(res, user, { req });
    }

    let localUser = findFirstActiveLocalUser();

    if (!localUser) {
      const localRestaurant = createLocalRestaurant("Demo Restaurant");
      const localPasswordHash = await bcrypt.hash("demo-access", 10);

      localUser = createLocalUser({
        name: "Demo Owner",
        email: `demo-${Date.now()}@restaurantcrm.local`,
        phone: "",
        passwordHash: localPasswordHash,
        role: "OWNER",
        provider: "local",
        restaurantId: localRestaurant._id,
        emailVerified: true,
        isActive: true
      });
    }

    const ensured = ensureLocalUserRestaurant(localUser, "Demo Restaurant");
    localUser = ensured.user;

    if (!localUser.emailVerified) {
      localUser = clearVerificationStateLocal(localUser);
    }

    return sendAuthPayload(res, localUser, { req });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

/**
 * RESET PASSWORD (EMAIL + NEW PASSWORD)
 */
router.post("/reset-password", async (req, res) => {
  try {
    if (!ALLOW_INSECURE_PASSWORD_RESET) {
      return res.status(403).json({
        message:
          "Self-service password reset is disabled. Use authenticated change-password or add a secure reset flow."
      });
    }

    const { email, newPassword, confirmPassword } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !newPassword) {
      return res
        .status(400)
        .json({ message: "Email and new password are required" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters" });
    }

    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ message: "Password and confirm password do not match" });
    }

    if (isDbConnected()) {
      const user = await User.findOne({ email: normalizedEmail });

      if (!user) {
        return res.status(404).json({ message: "Account not found" });
      }

      user.passwordHash = await bcrypt.hash(newPassword, 10);
      user.provider = "local";
      user.isActive = true;
      user.refreshTokenVersion = Number(user.refreshTokenVersion || 0) + 1;
      user.loginOtpHash = "";
      user.loginOtpExpiresAt = null;
      user.loginOtpAttempts = 0;
      user.loginOtpChallengeId = "";
      user.loginOtpChannel = "none";
      user.loginOtpDestination = "";
      user.accountRecoveryOtpHash = "";
      user.accountRecoveryOtpExpiresAt = null;
      user.accountRecoveryOtpAttempts = 0;
      user.accountRecoveryOtpChallengeId = "";
      user.accountRecoveryOtpChannel = "none";
      user.accountRecoveryOtpDestination = "";
      user.accountRecoveryOtpPurpose = "none";
      await user.save();

      return res.json({ message: "Password reset successful. Please login." });
    }

    const localUser = findLocalUserByEmail(normalizedEmail, {
      activeOnly: false
    });

    if (!localUser) {
      return res.status(404).json({ message: "Account not found" });
    }

    const nextHash = await bcrypt.hash(newPassword, 10);
    updateLocalUser(localUser, {
      passwordHash: nextHash,
      provider: "local",
      isActive: true,
      refreshTokenVersion: Number(localUser.refreshTokenVersion || 0) + 1,
      loginOtpHash: "",
      loginOtpExpiresAt: null,
      loginOtpAttempts: 0,
      loginOtpChallengeId: "",
      loginOtpChannel: "none",
      loginOtpDestination: "",
      accountRecoveryOtpHash: "",
      accountRecoveryOtpExpiresAt: null,
      accountRecoveryOtpAttempts: 0,
      accountRecoveryOtpChallengeId: "",
      accountRecoveryOtpChannel: "none",
      accountRecoveryOtpDestination: "",
      accountRecoveryOtpPurpose: "none"
    });

    return res.json({ message: "Password reset successful. Please login." });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

/**
 * GOOGLE LOGIN/SIGNUP
 * NOTE: For production, verify token signature using Google's public keys.
 */
router.post("/google", async (req, res) => {
  try {
    if (!ALLOW_DECODED_GOOGLE_LOGIN) {
      return res.status(403).json({
        message: "Google login is disabled until signed Google token verification is implemented."
      });
    }

    const { credential } = req.body;

    const payload = decodeGoogleCredential(credential);
    if (!payload || !payload.email) {
      return res.status(400).json({ message: "Invalid Google credential" });
    }

    if (payload.email_verified === false) {
      return res.status(401).json({ message: "Google email not verified" });
    }

    if (isDbConnected()) {
      let user = await User.findOne({ email: payload.email.toLowerCase() });

      if (!user) {
        const restaurant = await Restaurant.create({
          name: `${payload.name || "Restaurant"}'s Restaurant`
        });

        user = await User.create({
          name: payload.name || "Google User",
          email: payload.email.toLowerCase(),
          provider: "google",
          googleId: payload.sub || "",
          avatarUrl: payload.picture || "",
          role: "OWNER",
          restaurantId: restaurant._id,
          emailVerified: true
        });
      } else {
        user.provider = user.provider || "google";
        user.googleId = user.googleId || payload.sub || "";
        user.avatarUrl = payload.picture || user.avatarUrl;
        user.name = payload.name || user.name;
        user.isActive = true;
        user.emailVerified = true;
        user.emailVerificationTokenHash = "";
        user.emailVerificationExpiresAt = null;
        await user.save();
      }

      return sendAuthPayload(res, user, { req });
    }

    const normalizedEmail = normalizeEmail(payload.email);
    let localUser = findLocalUserByEmail(normalizedEmail, { activeOnly: false });

    if (!localUser) {
      const localRestaurant = createLocalRestaurant(
        `${payload.name || "Restaurant"}'s Restaurant`,
        {
          ownerName: payload.name || "Google User",
          email: normalizedEmail,
          phone: ""
        }
      );

      localUser = createLocalUser({
        name: payload.name || "Google User",
        email: normalizedEmail,
        provider: "google",
        googleId: payload.sub || "",
        avatarUrl: payload.picture || "",
        role: "OWNER",
        restaurantId: localRestaurant._id,
        emailVerified: true,
        isActive: true
      });
    } else {
      localUser = updateLocalUser(localUser, {
        provider: localUser.provider || "google",
        googleId: localUser.googleId || payload.sub || "",
        avatarUrl: payload.picture || localUser.avatarUrl,
        name: payload.name || localUser.name,
        emailVerified: true,
        emailVerificationTokenHash: "",
        emailVerificationExpiresAt: null,
        loginOtpHash: "",
        loginOtpExpiresAt: null,
        loginOtpAttempts: 0,
        loginOtpChallengeId: "",
        loginOtpChannel: "none",
        loginOtpDestination: "",
        isActive: true
      });

      if (!localUser.restaurantId) {
        localUser = ensureLocalUserRestaurant(
          localUser,
          `${payload.name || "Restaurant"}'s Restaurant`
        ).user;
      }
    }

    return sendAuthPayload(res, localUser, { req });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

/**
 * GET current user
 */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    if (String(req.user?.role || "").toUpperCase() === "SUPER_ADMIN") {
      const superAdminUser = buildEnvSuperAdminUser();
      return res.json({
        user: sanitizeUser(superAdminUser),
        restaurant: null,
        tenants: [],
        roles: [],
        activeTenantId: null,
        activeRole: "SUPER_ADMIN"
      });
    }

    if (isDbConnected()) {
      let user = await User.findById(req.user.userId).populate("restaurantId");

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const normalizedAuth = await ensureAuthBusinessType({
        user,
        restaurant: user.restaurantId
      });
      user = normalizedAuth.user;

      const subscription = user.restaurantId
        ? await Subscription.findOne({ restaurantId: user.restaurantId._id }).lean()
        : null;
      const authContext = await resolveAuthTenantContext(
        user,
        req.header("x-tenant-id") || req.query?.tenantId || req.user?.tenantId || req.user?.restaurantId
      );
      const activeRole = authContext?.activeRole || user.role;
      const activeTenantId = authContext?.activeTenantId || null;
      const activeBusinessType = normalizeBusinessType(
        authContext?.activeBusinessType || normalizedAuth.businessType || user.businessType,
        ""
      );

      return res.json({
        user: sanitizeUser({
          ...user.toObject(),
          role: activeRole,
          restaurantId: activeTenantId,
          businessType: activeBusinessType
        }),
        restaurant: authContext?.activeRestaurant || buildRestaurantAuthSnapshot(user.restaurantId, subscription),
        tenants: authContext?.tenants || [],
        roles: authContext?.roles || [],
        activeTenantId,
        activeRole
      });
    }

    let localUser = findLocalUserById(req.user.userId);

    if (!localUser || localUser.isActive === false) {
      return res.status(404).json({ message: "User not found" });
    }

    let localRestaurant = localUser.restaurantId
      ? findLocalRestaurantById(localUser.restaurantId)
      : null;
    const normalizedAuth = await ensureAuthBusinessType({
      user: localUser,
      restaurant: localRestaurant,
      local: true
    });
    localUser = normalizedAuth.user;
    localRestaurant = normalizedAuth.restaurant;
    const authContext = await resolveAuthTenantContext(
      localUser,
      req.header("x-tenant-id") || req.query?.tenantId || req.user?.tenantId || req.user?.restaurantId
    );
    const activeRole = authContext?.activeRole || localUser.role;
    const activeTenantId = authContext?.activeTenantId || localUser.restaurantId || null;
    const activeBusinessType = normalizeBusinessType(
      authContext?.activeBusinessType || localRestaurant?.businessType || localUser.businessType,
      ""
    );

    return res.json({
      user: sanitizeUser({
        ...localUser,
        role: activeRole,
        restaurantId: activeTenantId,
        businessType: activeBusinessType
      }),
      restaurant: authContext?.activeRestaurant || buildRestaurantAuthSnapshot(localRestaurant),
      tenants: authContext?.tenants || [],
      roles: authContext?.roles || [],
      activeTenantId,
      activeRole
    });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

router.post("/select-tenant", authMiddleware, async (req, res) => {
  try {
    const requestedTenantId = String(
      req.body?.tenantId || req.header("x-tenant-id") || req.query?.tenantId || ""
    ).trim();

    if (!requestedTenantId) {
      return res.status(400).json({ message: "tenantId is required" });
    }

    if (String(req.user?.role || "").toUpperCase() === "SUPER_ADMIN") {
      return res.status(400).json({ message: "Super admin does not require tenant selection" });
    }

    if (isDbConnected()) {
      const user = await User.findById(req.user.userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const authContext = await resolveAuthTenantContext(user, requestedTenantId);
      if (!authContext?.activeTenantId || String(authContext.activeTenantId) !== requestedTenantId) {
        return res.status(403).json({ message: "Access denied for selected tenant" });
      }

      const tokens = issueAuthTokens(user, authContext);
      setAuthCookies(res, tokens);
      return res.json(buildAuthPayload(user, authContext, tokens));
    }

    const localUser = findLocalUserById(req.user.userId);
    if (!localUser || localUser.isActive === false) {
      return res.status(404).json({ message: "User not found" });
    }

    const authContext = await resolveAuthTenantContext(localUser, requestedTenantId);
    if (!authContext?.activeTenantId || String(authContext.activeTenantId) !== requestedTenantId) {
      return res.status(403).json({ message: "Access denied for selected tenant" });
    }

    const tokens = issueAuthTokens(localUser, authContext);
    setAuthCookies(res, tokens);
    return res.json(buildAuthPayload(localUser, authContext, tokens));
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

/**
 * CHANGE PASSWORD
 */
router.put("/change-password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res
        .status(400)
        .json({ message: "New password must be at least 6 characters" });
    }

    if (isDbConnected()) {
      const user = await User.findById(req.user.userId);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      if (user.passwordHash) {
        const isMatch = await bcrypt.compare(currentPassword || "", user.passwordHash);

        if (!isMatch) {
          return res.status(400).json({ message: "Current password is incorrect" });
        }
      }

      user.passwordHash = await bcrypt.hash(newPassword, 10);
      if (!user.provider) {
        user.provider = "local";
      }
      user.refreshTokenVersion = Number(user.refreshTokenVersion || 0) + 1;
      user.loginOtpHash = "";
      user.loginOtpExpiresAt = null;
      user.loginOtpAttempts = 0;
      user.loginOtpChallengeId = "";
      user.loginOtpChannel = "none";
      user.loginOtpDestination = "";
      user.accountRecoveryOtpHash = "";
      user.accountRecoveryOtpExpiresAt = null;
      user.accountRecoveryOtpAttempts = 0;
      user.accountRecoveryOtpChallengeId = "";
      user.accountRecoveryOtpChannel = "none";
      user.accountRecoveryOtpDestination = "";
      user.accountRecoveryOtpPurpose = "none";

      await user.save();

      return res.json({ message: "Password updated successfully" });
    }

    const localUser = findLocalUserById(req.user.userId);

    if (!localUser || localUser.isActive === false) {
      return res.status(404).json({ message: "User not found" });
    }

    if (localUser.passwordHash) {
      const isMatch = await bcrypt.compare(currentPassword || "", localUser.passwordHash);

      if (!isMatch) {
        return res.status(400).json({ message: "Current password is incorrect" });
      }
    }

    const nextPasswordHash = await bcrypt.hash(newPassword, 10);
    updateLocalUser(localUser, {
      passwordHash: nextPasswordHash,
      provider: localUser.provider || "local",
      refreshTokenVersion: Number(localUser.refreshTokenVersion || 0) + 1,
      loginOtpHash: "",
      loginOtpExpiresAt: null,
      loginOtpAttempts: 0,
      loginOtpChallengeId: "",
      loginOtpChannel: "none",
      loginOtpDestination: "",
      accountRecoveryOtpHash: "",
      accountRecoveryOtpExpiresAt: null,
      accountRecoveryOtpAttempts: 0,
      accountRecoveryOtpChallengeId: "",
      accountRecoveryOtpChannel: "none",
      accountRecoveryOtpDestination: "",
      accountRecoveryOtpPurpose: "none"
    });

    return res.json({ message: "Password updated successfully" });
  } catch (err) {
    return sendAuthRouteError(res, err);
  }
});

module.exports = router;
