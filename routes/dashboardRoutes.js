const express = require("express");

const requirePermission = require("../middleware/requirePermission");
const { assertCloudKitchenWorkspace } = require("../utils/cloudKitchenWorkspace");
const {
  resolveDashboardRange,
  getDashboardMetrics
} = require("../services/cloudKitchenDashboardService");

const router = express.Router();

router.get("/metrics", requirePermission("dashboard.view"), async (req, res) => {
  try {
    const workspace = await assertCloudKitchenWorkspace(req);
    const range = resolveDashboardRange({
      range: req.query?.range,
      from: req.query?.from,
      to: req.query?.to
    });
    const metrics = await getDashboardMetrics({
      restaurantId: workspace._id,
      range
    });

    return res.json(metrics);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
});

module.exports = router;
