const { resolvePlanDefinition } = require("../config/planLimits");
const {
  APP_CONFIG,
  getDevModeUnlockedFeatures,
  getDevModeUnlockedLimits
} = require("../config/appConfig");

const getCurrentPlanDefinition = (req) => {
  const plan = req.restaurant?.subscriptionPlan || "STARTER";
  const planDefinition = resolvePlanDefinition(plan);

  if (!APP_CONFIG.DEV_MODE_UNLOCK_ALL) {
    return planDefinition;
  }

  return {
    ...planDefinition,
    features: getDevModeUnlockedFeatures(),
    limits: getDevModeUnlockedLimits()
  };
};

const getCurrentPlanCode = (req) => getCurrentPlanDefinition(req).code;

const getCurrentPlanLimits = (req) => getCurrentPlanDefinition(req).limits;

const getCurrentPlanFeatures = (req) => getCurrentPlanDefinition(req).features;

const buildUpgradeResponse = ({
  req,
  feature,
  message,
  requiredPlan = "PRO",
  limit,
  current
}) => {
  if (APP_CONFIG.DEV_MODE_UNLOCK_ALL) {
    return {
      message: "Development mode unlock is active.",
      devModeUnlocked: true,
      plan: getCurrentPlanCode(req)
    };
  }

  const payload = {
    message,
    upgradeRequired: true,
    plan: getCurrentPlanCode(req),
    requiredPlan
  };

  if (feature) {
    payload.feature = feature;
  }

  if (limit !== undefined) {
    payload.limit = limit;
  }

  if (current !== undefined) {
    payload.current = current;
  }

  return payload;
};

const requirePlanFeature = (feature, options = {}) => {
  const requiredPlan = String(options.requiredPlan || "PRO").trim().toUpperCase() || "PRO";
  const message =
    options.message ||
    `This feature is not available on your current plan. Upgrade to ${requiredPlan}.`;

  return (req, res, next) => {
    if (APP_CONFIG.DEV_MODE_UNLOCK_ALL) {
      return next();
    }

    const features = getCurrentPlanFeatures(req);
    if (features[feature]) {
      return next();
    }

    return res.status(403).json(
      buildUpgradeResponse({
        req,
        feature,
        message,
        requiredPlan
      })
    );
  };
};

const parseDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
};

const dayDiffInclusive = (from, to) => {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);

  const end = new Date(to);
  end.setHours(0, 0, 0, 0);

  const diffMs = end.getTime() - start.getTime();
  return Math.max(1, Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1);
};

const requireReportRangeWithinPlan = (req, res, next) => {
  if (APP_CONFIG.DEV_MODE_UNLOCK_ALL) {
    return next();
  }

  const limits = getCurrentPlanLimits(req);
  const maxDays = Number(limits.maxReportDays || 30);

  const requestedDays = req.query?.days;
  if (requestedDays !== undefined) {
    const parsed = Number(requestedDays);
    if (Number.isFinite(parsed) && parsed > maxDays) {
      return res.status(403).json(
        buildUpgradeResponse({
          req,
          feature: "reportRangeDays",
          message: `Your plan supports up to ${maxDays} reporting days at a time.`,
          requiredPlan: "PRO",
          limit: maxDays,
          current: parsed
        })
      );
    }
  }

  const from = req.query?.from;
  const to = req.query?.to;
  if (from || to) {
    const fromDate = parseDate(from);
    const toDate = parseDate(to);

    if (fromDate && toDate) {
      const requestedRangeDays = dayDiffInclusive(fromDate, toDate);
      if (requestedRangeDays > maxDays) {
        return res.status(403).json(
          buildUpgradeResponse({
            req,
            feature: "reportRangeDays",
            message: `Your plan supports up to ${maxDays} reporting days at a time.`,
            requiredPlan: "PRO",
            limit: maxDays,
            current: requestedRangeDays
          })
        );
      }
    }
  }

  return next();
};

module.exports = {
  getCurrentPlanCode,
  getCurrentPlanLimits,
  getCurrentPlanFeatures,
  buildUpgradeResponse,
  requirePlanFeature,
  requireReportRangeWithinPlan
};
