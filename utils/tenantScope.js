const getTenantRestaurantId = (req) => {
  return req.tenant?.restaurantId || req.user?.tenantId || req.user?.restaurantId || null;
};

const DENY_ALL_FILTER = { _id: null, restaurantId: null };

const toPlainObject = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...value };
};

const withTenantFilter = (req, filter = {}) => {
  const restaurantId = getTenantRestaurantId(req);
  if (!restaurantId) {
    return { ...DENY_ALL_FILTER };
  }

  const scopedFilter = toPlainObject(filter);
  delete scopedFilter.restaurantId;

  return {
    ...scopedFilter,
    restaurantId
  };
};

const withTenantDocFilter = (req, id, filter = {}) => {
  const base = withTenantFilter(req, filter);

  return {
    ...base,
    _id: id
  };
};

module.exports = {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
};
