const express = require("express");

const requirePermission = require("../middleware/requirePermission");
const { assertCloudKitchenWorkspace } = require("../utils/cloudKitchenWorkspace");
const { getOperationalInsights } = require("../services/cloudKitchenDashboardService");

const router = express.Router();

router.get("/", requirePermission("dashboard.view"), async (req, res) => {
  try {
    const workspace = await assertCloudKitchenWorkspace(req);
    const insights = await getOperationalInsights({
      restaurantId: workspace._id
    });

    return res.json(insights);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
});

module.exports = router;
