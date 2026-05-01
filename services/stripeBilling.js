const crypto = require("crypto");

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const ACTIVE_BILLING_STATUSES = new Set(["active", "trialing", "past_due"]);
const SUPPORTED_PLANS = new Set(["STARTER", "GROWTH", "PRO", "ENTERPRISE"]);
const DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

const normalizePlan = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "BASIC") {
    return "GROWTH";
  }
  if (normalized === "FREE") {
    return "STARTER";
  }
  return normalized;
};

const getStripeSecretKey = () => String(process.env.STRIPE_SECRET_KEY || "").trim();

const assertStripeConfigured = () => {
  const stripeSecretKey = getStripeSecretKey();
  if (!stripeSecretKey) {
    throw new Error("Stripe is not configured: STRIPE_SECRET_KEY is missing");
  }

  return { stripeSecretKey };
};

const getPriceIdForPlan = (plan) => {
  const normalized = normalizePlan(plan);
  const map = {
    STARTER: String(process.env.STRIPE_PRICE_STARTER || "").trim(),
    GROWTH: String(process.env.STRIPE_PRICE_GROWTH || process.env.STRIPE_PRICE_BASIC || "").trim(),
    PRO: String(process.env.STRIPE_PRICE_PRO || "").trim(),
    ENTERPRISE: String(process.env.STRIPE_PRICE_ENTERPRISE || "").trim()
  };

  if (!SUPPORTED_PLANS.has(normalized)) {
    throw new Error("Unsupported billing plan");
  }

  if (!map[normalized]) {
    throw new Error(`Missing Stripe price configuration for ${normalized}`);
  }

  return map[normalized];
};

const planFromPriceId = (priceId) => {
  const target = String(priceId || "").trim();
  if (!target) {
    return "";
  }

  const map = {
    STARTER: String(process.env.STRIPE_PRICE_STARTER || "").trim(),
    GROWTH: String(process.env.STRIPE_PRICE_GROWTH || process.env.STRIPE_PRICE_BASIC || "").trim(),
    PRO: String(process.env.STRIPE_PRICE_PRO || "").trim(),
    ENTERPRISE: String(process.env.STRIPE_PRICE_ENTERPRISE || "").trim()
  };

  for (const [plan, configuredPriceId] of Object.entries(map)) {
    if (configuredPriceId && configuredPriceId === target) {
      return plan;
    }
  }

  return "";
};

const appendNestedFormData = (params, key, value) => {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      appendNestedFormData(params, `${key}[${index}]`, item);
    });
    return;
  }

  if (typeof value === "object") {
    Object.entries(value).forEach(([childKey, childValue]) => {
      appendNestedFormData(params, `${key}[${childKey}]`, childValue);
    });
    return;
  }

  params.append(key, String(value));
};

const buildFormParams = (payload = {}) => {
  const params = new URLSearchParams();
  Object.entries(payload).forEach(([key, value]) => appendNestedFormData(params, key, value));
  return params;
};

const stripeRequest = async ({ method = "GET", path, payload }) => {
  const { stripeSecretKey } = assertStripeConfigured();
  const normalizedPath = String(path || "").startsWith("/") ? path : `/${path}`;

  let url = `${STRIPE_API_BASE}${normalizedPath}`;
  const headers = {
    Authorization: `Bearer ${stripeSecretKey}`
  };

  const init = { method, headers };

  if (method === "GET" && payload && Object.keys(payload).length) {
    const qs = buildFormParams(payload).toString();
    if (qs) {
      url = `${url}?${qs}`;
    }
  } else if (method !== "GET") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = buildFormParams(payload).toString();
  }

  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message = json?.error?.message || `Stripe API error (${res.status})`;
    const err = new Error(message);
    err.statusCode = res.status;
    err.response = json;
    throw err;
  }

  return json;
};

const createStripeCustomer = async ({ restaurant }) => {
  return stripeRequest({
    method: "POST",
    path: "/customers",
    payload: {
      name: restaurant.name || "Restaurant",
      email: restaurant.email || "",
      phone: restaurant.phone || "",
      metadata: {
        restaurantId: restaurant._id
      }
    }
  });
};

const createStripeCheckoutSession = async ({
  customerId,
  priceId,
  successUrl,
  cancelUrl,
  metadata
}) => {
  return stripeRequest({
    method: "POST",
    path: "/checkout/sessions",
    payload: {
      mode: "subscription",
      customer: customerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: "true",
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: metadata || {},
      subscription_data: {
        metadata: metadata || {}
      }
    }
  });
};

const createStripePortalSession = async ({ customerId, returnUrl }) => {
  return stripeRequest({
    method: "POST",
    path: "/billing_portal/sessions",
    payload: {
      customer: customerId,
      return_url: returnUrl
    }
  });
};

const parseStripeSignature = (headerValue) => {
  const entries = String(headerValue || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const parsed = { t: "", v1: [] };
  entries.forEach((entry) => {
    const [key, value] = entry.split("=");
    if (!key || !value) {
      return;
    }

    if (key === "t") {
      parsed.t = value;
      return;
    }

    if (key === "v1") {
      parsed.v1.push(value);
    }
  });

  return parsed;
};

const safeCompareHex = (a, b) => {
  const left = Buffer.from(String(a || ""), "hex");
  const right = Buffer.from(String(b || ""), "hex");

  if (!left.length || !right.length || left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
};

const verifyStripeWebhookSignature = ({ rawBody, signatureHeader, webhookSecret }) => {
  const secret = String(webhookSecret || "").trim();
  if (!secret) {
    throw new Error("Stripe webhook secret is missing");
  }

  const rawPayload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const { t, v1 } = parseStripeSignature(signatureHeader);

  if (!t || !v1.length || !rawPayload) {
    return false;
  }

  const timestamp = Number(t);
  const toleranceSeconds = Math.max(
    30,
    Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS || DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS)
  );

  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > toleranceSeconds) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${rawPayload}`, "utf8")
    .digest("hex");

  return v1.some((signature) => safeCompareHex(signature, expected));
};

const toDateFromUnix = (value) => {
  const unix = Number(value || 0);
  if (!Number.isFinite(unix) || unix <= 0) {
    return null;
  }

  return new Date(unix * 1000);
};

const mapBillingStatusToRestaurantStatus = (billingStatus) => {
  const status = String(billingStatus || "").toLowerCase();
  if (ACTIVE_BILLING_STATUSES.has(status)) {
    return "ACTIVE";
  }

  if (!status || status === "inactive") {
    return "ACTIVE";
  }

  return "SUSPENDED";
};

const derivePlanFromSubscriptionObject = (subscriptionObject, fallbackPlan = "") => {
  const metadataPlan = normalizePlan(subscriptionObject?.metadata?.plan);
  if (SUPPORTED_PLANS.has(metadataPlan)) {
    return metadataPlan;
  }

  const items = subscriptionObject?.items?.data;
  const firstPriceId = Array.isArray(items) ? items[0]?.price?.id : "";
  const mappedPlan = planFromPriceId(firstPriceId);
  if (mappedPlan) {
    return mappedPlan;
  }

  const fallback = normalizePlan(fallbackPlan);
  if (SUPPORTED_PLANS.has(fallback)) {
    return fallback;
  }

  return "FREE";
};

module.exports = {
  normalizePlan,
  getPriceIdForPlan,
  planFromPriceId,
  stripeRequest,
  createStripeCustomer,
  createStripeCheckoutSession,
  createStripePortalSession,
  verifyStripeWebhookSignature,
  toDateFromUnix,
  mapBillingStatusToRestaurantStatus,
  derivePlanFromSubscriptionObject
};
