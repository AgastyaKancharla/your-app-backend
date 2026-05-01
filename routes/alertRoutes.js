const express = require("express");

const requirePermission = require("../middleware/requirePermission");
const { getAlerts } = require("../services/cloudKitchenOperationsService");
const { assertCloudKitchenWorkspace } = require("../utils/cloudKitchenWorkspace");

const router = express.Router();

router.get("/", requirePermission("orders.view"), async (req, res) => {
  try {
    const workspace = await assertCloudKitchenWorkspace(req);
    const result = await getAlerts({
      restaurantId: workspace._id
    });

    return res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
});

module.exports = router;
