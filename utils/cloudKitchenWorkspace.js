const Restaurant = require("../models/Restaurant");
const { getTenantRestaurantId } = require("./tenantScope");
const { BUSINESS_TYPES, normalizeBusinessType } = require("../services/workspaceAccess");

const assertCloudKitchenWorkspace = async (req) => {
  const restaurantId = getTenantRestaurantId(req);
  if (!restaurantId) {
    const error = new Error("Tenant context is required");
    error.status = 401;
    throw error;
  }

  const restaurant = await Restaurant.findById(restaurantId)
    .select("_id name businessType subscriptionPlan")
    .lean();

  if (!restaurant) {
    const error = new Error("Workspace not found");
    error.status = 404;
    throw error;
  }

  if (normalizeBusinessType(restaurant.businessType) !== BUSINESS_TYPES.CLOUD_KITCHEN) {
    const error = new Error("Cloud kitchen workspace required");
    error.status = 403;
    throw error;
  }

  return restaurant;
};

const getCloudKitchenWorkspaceIfAvailable = async (req) => {
  try {
    return await assertCloudKitchenWorkspace(req);
  } catch (error) {
    if (error?.status === 403) {
      return null;
    }

    throw error;
  }
};

module.exports = {
  assertCloudKitchenWorkspace,
  getCloudKitchenWorkspaceIfAvailable
};
