const { getTenantRestaurantId } = require("../utils/tenantScope");
const { assertCloudKitchenWorkspace } = require("../utils/cloudKitchenWorkspace");
const { getFinanceOverviewData } = require("../services/financeOverviewService");

const getFinanceOverview = async (req, res) => {
  try {
    await assertCloudKitchenWorkspace(req);

    const payload = await getFinanceOverviewData({
      restaurantId: getTenantRestaurantId(req),
      range: req.query?.range || req.query?.preset,
      from: req.query?.from,
      to: req.query?.to
    });

    return res.json(payload);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
};

module.exports = {
  getFinanceOverview
};
