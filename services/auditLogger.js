const mongoose = require("mongoose");

const ActivityLog = require("../models/ActivityLog");
const { getTenantRestaurantId } = require("../utils/tenantScope");

const isDbConnected = () => mongoose.connection.readyState === 1;

const sanitizeMetadata = (metadata = {}) => {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  const safeMetadata = { ...metadata };
  delete safeMetadata.password;
  delete safeMetadata.passwordHash;
  delete safeMetadata.token;
  delete safeMetadata.refreshToken;
  return safeMetadata;
};

const writeActivityLog = async (req, log = {}) => {
  if (!isDbConnected()) {
    return null;
  }

  const restaurantId = getTenantRestaurantId(req);

  return ActivityLog.create({
    restaurantId: restaurantId || null,
    userId: req.user?.userId || null,
    userName: req.user?.name || "",
    role: req.user?.role || "",
    action: log.action,
    module: log.module,
    metadata: sanitizeMetadata(log.metadata)
  });
};

module.exports = {
  writeActivityLog
};
