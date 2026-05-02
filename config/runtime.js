const fs = require("fs");
const path = require("path");

const { parseBoolean, getCookieSettings } = require("../utils/httpCookies");
const { getStorageRoot } = require("../utils/storagePaths");

const isProduction = () => String(process.env.NODE_ENV || "").toLowerCase() === "production";

const isHttpsUrl = (value) => {
  const input = String(value || "").trim();
  if (!input) {
    return false;
  }

  try {
    const parsed = new URL(input);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const hasEmailDeliveryConfig = () => {
  const resendReady =
    String(process.env.RESEND_API_KEY || "").trim() &&
    String(process.env.RESEND_FROM_EMAIL || "").trim();
  const webhookReady = String(process.env.AUTH_EMAIL_HOOK_URL || "").trim();

  return Boolean(resendReady || webhookReady);
};

const hasOtpDeliveryConfig = () => {
  const twilioReady =
    String(process.env.TWILIO_ACCOUNT_SID || "").trim() &&
    String(process.env.TWILIO_AUTH_TOKEN || "").trim() &&
    String(process.env.TWILIO_FROM_PHONE || "").trim();
  const resendReady =
    String(process.env.RESEND_API_KEY || "").trim() &&
    String(process.env.RESEND_FROM_EMAIL || "").trim();
  const webhookReady =
    String(process.env.AUTH_LOGIN_OTP_HOOK_URL || "").trim() ||
    String(process.env.AUTH_EMAIL_HOOK_URL || "").trim();

  return Boolean(twilioReady || resendReady || webhookReady);
};

const hasVerificationLinkConfig = () => {
  const template = String(process.env.AUTH_EMAIL_VERIFY_URL_TEMPLATE || "").trim();
  const baseUrl = String(process.env.AUTH_VERIFICATION_BASE_URL || "").trim();
  return Boolean(template || baseUrl);
};

const getConfiguredStripePlans = () => {
  const planMap = {
    STARTER: process.env.STRIPE_PRICE_STARTER,
    GROWTH: process.env.STRIPE_PRICE_GROWTH || process.env.STRIPE_PRICE_BASIC,
    PRO: process.env.STRIPE_PRICE_PRO,
    ENTERPRISE: process.env.STRIPE_PRICE_ENTERPRISE
  };

  return Object.entries(planMap)
    .filter(([, value]) => String(value || "").trim())
    .map(([plan]) => plan);
};

const hasStripeBillingConfig = () => {
  const secretKeyReady = String(process.env.STRIPE_SECRET_KEY || "").trim();
  return Boolean(secretKeyReady && getConfiguredStripePlans().length);
};

const hasAnyStripeConfig = () => {
  return Boolean(
    String(process.env.STRIPE_SECRET_KEY || "").trim() ||
      String(process.env.STRIPE_WEBHOOK_SECRET || "").trim() ||
      getConfiguredStripePlans().length
  );
};

const hasStripeWebhookConfig = () => Boolean(String(process.env.STRIPE_WEBHOOK_SECRET || "").trim());

const getWhatsAppVerifyToken = () =>
  String(process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN || "").trim();

const hasAnyWhatsAppConfig = () => {
  return Boolean(
    String(process.env.WHATSAPP_TOKEN || "").trim() ||
      String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim() ||
      getWhatsAppVerifyToken()
  );
};

const hasWhatsAppConfig = () => {
  return Boolean(
    String(process.env.WHATSAPP_TOKEN || "").trim() &&
      String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim() &&
      getWhatsAppVerifyToken()
  );
};

const hasStripeUrlConfig = () => {
  const successUrl = String(process.env.STRIPE_CHECKOUT_SUCCESS_URL || "").trim();
  const cancelUrl = String(process.env.STRIPE_CHECKOUT_CANCEL_URL || "").trim();
  const portalUrl = String(process.env.STRIPE_PORTAL_RETURN_URL || "").trim();

  return (
    isHttpsUrl(successUrl) &&
    isHttpsUrl(cancelUrl) &&
    isHttpsUrl(portalUrl)
  );
};

const hasConfiguredSuperAdmin = () => {
  return Boolean(
    String(process.env.SUPER_ADMIN_EMAIL || "").trim() &&
      String(process.env.SUPER_ADMIN_PASSWORD || "").trim()
  );
};

const getRuntimeReadiness = () => {
  const requireEmailVerification = parseBoolean(process.env.REQUIRE_EMAIL_VERIFICATION, false);
  const loginOtpEnabled = parseBoolean(process.env.LOGIN_OTP_ENABLED, true);
  const configuredStripePlans = getConfiguredStripePlans();

  return {
    auth: {
      emailVerificationEnabled: requireEmailVerification,
      emailDeliveryReady: hasEmailDeliveryConfig(),
      verificationLinkReady: hasVerificationLinkConfig(),
      loginOtpEnabled,
      otpDeliveryReady: hasOtpDeliveryConfig(),
      googleLoginReady: false,
      superAdminReady: hasConfiguredSuperAdmin()
    },
    billing: {
      provider: hasStripeBillingConfig() ? "STRIPE" : "NONE",
      stripeReady: hasStripeBillingConfig(),
      webhookReady: hasStripeWebhookConfig(),
      checkoutUrlsReady: hasStripeUrlConfig(),
      configuredPlans: configuredStripePlans
    },
    messaging: {
      whatsappReady: hasWhatsAppConfig(),
      whatsappOutboundReady: Boolean(
        String(process.env.WHATSAPP_TOKEN || "").trim() &&
          String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim()
      ),
      whatsappWebhookReady: Boolean(getWhatsAppVerifyToken())
    },
    ai: {
      openAiReady: Boolean(String(process.env.OPENAI_API_KEY || "").trim())
    }
  };
};

const getOriginFromUrl = (value) => {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }

  try {
    return new URL(input).origin;
  } catch {
    return "";
  }
};

const getMongoDbNameFromUri = (mongoUri = "") => {
  const input = String(mongoUri || "").trim();
  if (!input) {
    return "";
  }

  try {
    const parsed = new URL(input);
    const pathname = String(parsed.pathname || "").replace(/^\/+/, "");
    return pathname.split("/")[0]?.trim() || "";
  } catch {
    return "";
  }
};

const normalizeMongoUri = (value = "") => {
  let mongoUri = String(value || "").trim();

  if (
    mongoUri.startsWith("MONGO_URI=") ||
    mongoUri.startsWith("MONGODB_URL=") ||
    mongoUri.startsWith("MONGODB_URI=")
  ) {
    mongoUri = mongoUri.slice(mongoUri.indexOf("=") + 1).trim();
  }

  return mongoUri.replace(/^['"]+|['";]+$/g, "").trim();
};

const validateRuntimeConfig = () => {
  const production = isProduction();
  const errors = [];
  const warnings = [];
  const jwtSecret = String(process.env.JWT_SECRET || "").trim();
  const cookieSettings = getCookieSettings();
  const storageRoot = getStorageRoot();
  const appOrigin = getOriginFromUrl(process.env.APP_BASE_URL);
  const geocodingDisabled =
    String(process.env.GEOCODING_DISABLED || "").toLowerCase() === "true";
  const geocodingUserAgent = String(process.env.GEOCODING_USER_AGENT || "").trim();
  const shouldServeFrontend =
    String(process.env.SERVE_FRONTEND || "true").toLowerCase() !== "false";
  const frontendBuildDir = path.resolve(
    __dirname,
    process.env.FRONTEND_BUILD_DIR || "../frontend/build"
  );
  const frontendIndexFile = path.join(frontendBuildDir, "index.html");
  const requireEmailVerification = parseBoolean(process.env.REQUIRE_EMAIL_VERIFICATION, false);
  const loginOtpEnabled = parseBoolean(process.env.LOGIN_OTP_ENABLED, true);
  const enableSuperAdminLogin =
    String(process.env.REACT_APP_ENABLE_SUPER_ADMIN_LOGIN || "false").trim().toLowerCase() ===
    "true";

  if (!jwtSecret) {
    errors.push("JWT_SECRET is required");
  } else if (production && jwtSecret.length < 32) {
    errors.push("JWT_SECRET must be at least 32 characters in production");
  }

  try {
    fs.mkdirSync(storageRoot, { recursive: true });
  } catch (error) {
    errors.push(`FILE_STORAGE_ROOT is not writable: ${error.message}`);
  }

  if (cookieSettings.sameSite === "none" && !cookieSettings.secure) {
    errors.push("AUTH_COOKIE_SAME_SITE=none requires AUTH_COOKIE_SECURE=true");
  }

  if (production) {
    const mongoUri = normalizeMongoUri(process.env.MONGO_URI);
    const mongoDbName = String(process.env.MONGO_DB_NAME || "").trim();
    const mongoDbNameFromUri = getMongoDbNameFromUri(mongoUri);

    if (parseBoolean(process.env.SKIP_DB_CONNECT, false)) {
      errors.push("SKIP_DB_CONNECT must be false in production");
    }

    if (!mongoUri) {
      errors.push("MONGO_URI is required in production");
    }

    if (
      mongoUri &&
      !mongoUri.startsWith("mongodb://") &&
      !mongoUri.startsWith("mongodb+srv://")
    ) {
      errors.push(
        'MONGO_URI must start with "mongodb://" or "mongodb+srv://"'
      );
    }

    if (mongoDbName && mongoDbNameFromUri && mongoDbName !== mongoDbNameFromUri) {
      warnings.push(
        `MONGO_DB_NAME (${mongoDbName}) overrides URI database name (${mongoDbNameFromUri}).`
      );
    }

    if (!isHttpsUrl(process.env.APP_BASE_URL)) {
      errors.push("APP_BASE_URL must be a valid https:// URL in production");
    }

    if (shouldServeFrontend && !fs.existsSync(frontendIndexFile)) {
      errors.push(
        `SERVE_FRONTEND is enabled, but frontend build is missing: ${frontendIndexFile}`
      );
    }

    const configuredOrigins = String(process.env.CORS_ORIGIN || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const allowedOrigins = configuredOrigins.length
      ? configuredOrigins
      : (appOrigin ? [appOrigin] : []);

    if (!allowedOrigins.length) {
      errors.push("CORS_ORIGIN must include your production CRM origin");
    } else if (allowedOrigins.some((origin) => !isHttpsUrl(origin))) {
      errors.push("Every CORS_ORIGIN value must be an https:// URL in production");
    }

    if (
      appOrigin &&
      allowedOrigins.some((origin) => getOriginFromUrl(origin) && getOriginFromUrl(origin) !== appOrigin) &&
      cookieSettings.sameSite !== "none"
    ) {
      errors.push(
        "Cross-origin frontend deployments require AUTH_COOKIE_SAME_SITE=none in production"
      );
    }

    if (requireEmailVerification && !hasEmailDeliveryConfig()) {
      errors.push(
        "Email verification is enabled, but no email delivery provider is configured"
      );
    }

    if (requireEmailVerification && !hasVerificationLinkConfig()) {
      warnings.push(
        "Email verification link is not configured. Set AUTH_VERIFICATION_BASE_URL or AUTH_EMAIL_VERIFY_URL_TEMPLATE for one-click verification emails."
      );
    }

    if (loginOtpEnabled && !hasOtpDeliveryConfig()) {
      errors.push("Login OTP is enabled, but no OTP delivery provider is configured");
    }

    if (hasAnyStripeConfig()) {
      if (!String(process.env.STRIPE_SECRET_KEY || "").trim()) {
        errors.push("Stripe billing config is incomplete: STRIPE_SECRET_KEY is required");
      }

      if (!getConfiguredStripePlans().length) {
        errors.push(
          "Stripe billing config is incomplete: configure at least one STRIPE_PRICE_* value"
        );
      }

      if (!hasStripeWebhookConfig()) {
        errors.push("Stripe billing config is incomplete: STRIPE_WEBHOOK_SECRET is required");
      }

      if (!hasStripeUrlConfig()) {
        errors.push(
          "Stripe billing config is incomplete: STRIPE_CHECKOUT_SUCCESS_URL, STRIPE_CHECKOUT_CANCEL_URL, and STRIPE_PORTAL_RETURN_URL must be valid https:// URLs"
        );
      }
    }

    if (hasAnyWhatsAppConfig() && !hasWhatsAppConfig()) {
      errors.push(
        "WhatsApp config is incomplete: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and VERIFY_TOKEN are required"
      );
    }

    if (enableSuperAdminLogin && !hasConfiguredSuperAdmin()) {
      errors.push(
        "REACT_APP_ENABLE_SUPER_ADMIN_LOGIN=true requires SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD"
      );
    }

    if (parseBoolean(process.env.AUTH_INCLUDE_DEV_VERIFICATION_TOKEN, false)) {
      errors.push("AUTH_INCLUDE_DEV_VERIFICATION_TOKEN must be false in production");
    }

    if (parseBoolean(process.env.LOGIN_OTP_INCLUDE_DEV_CODE, false)) {
      errors.push("LOGIN_OTP_INCLUDE_DEV_CODE must be false in production");
    }

    if (parseBoolean(process.env.AUTH_ALLOW_QUICK_LOGIN, false)) {
      errors.push("AUTH_ALLOW_QUICK_LOGIN must be false in production");
    }

    if (parseBoolean(process.env.AUTH_ALLOW_INSECURE_PASSWORD_RESET, false)) {
      errors.push("AUTH_ALLOW_INSECURE_PASSWORD_RESET must be false in production");
    }

    if (parseBoolean(process.env.AUTH_ALLOW_DECODED_GOOGLE_LOGIN, false)) {
      errors.push("AUTH_ALLOW_DECODED_GOOGLE_LOGIN must be false in production");
    }

    if (!geocodingDisabled && !geocodingUserAgent) {
      warnings.push(
        "GEOCODING_USER_AGENT is not configured. Set a descriptive value for geocoding provider compliance."
      );
    }
  } else {
    if (!String(process.env.MONGO_URI || "").trim()) {
      warnings.push("MONGO_URI is not set. CRM data modules will stay offline.");
    }

    if (
      requireEmailVerification && !hasEmailDeliveryConfig()
    ) {
      warnings.push("Email delivery is not configured. Verification emails will use dev fallback.");
    }

    if (requireEmailVerification && !hasVerificationLinkConfig()) {
      warnings.push(
        "Verification link URL is not configured. Emails will include a code only until AUTH_VERIFICATION_BASE_URL or AUTH_EMAIL_VERIFY_URL_TEMPLATE is set."
      );
    }

    if (loginOtpEnabled && !hasOtpDeliveryConfig()) {
      warnings.push("OTP delivery is not configured. Login OTP will use dev fallback.");
    }

    if (hasAnyStripeConfig() && (!hasStripeWebhookConfig() || !hasStripeUrlConfig())) {
      warnings.push(
        "Stripe is partially configured. Add webhook secret and Stripe return URLs before go-live."
      );
    }

    if (hasAnyWhatsAppConfig() && !hasWhatsAppConfig()) {
      warnings.push(
        "WhatsApp is partially configured. Add WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and VERIFY_TOKEN before go-live."
      );
    }

    if (!geocodingDisabled && !geocodingUserAgent) {
      warnings.push(
        "GEOCODING_USER_AGENT is not set. Geocoding services may reject requests in some environments."
      );
    }
  }

  return {
    errors,
    warnings,
    storageRoot
  };
};

const assertRuntimeConfig = () => {
  const result = validateRuntimeConfig();
  result.warnings.forEach((warning) => {
    console.warn(`[runtime-warning] ${warning}`);
  });

  if (result.errors.length) {
    throw new Error(result.errors.join("; "));
  }

  return result;
};

module.exports = {
  getRuntimeReadiness,
  hasEmailDeliveryConfig,
  hasOtpDeliveryConfig,
  hasVerificationLinkConfig,
  hasStripeBillingConfig,
  hasStripeWebhookConfig,
  hasStripeUrlConfig,
  hasWhatsAppConfig,
  validateRuntimeConfig,
  assertRuntimeConfig
};
