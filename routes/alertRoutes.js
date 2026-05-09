const express = require("express");

const requirePermission = require("../middleware/requirePermission");
const hybridInventoryController = require("../controllers/hybridInventoryController");
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

router.get("/inventory", requirePermission("inventory.view"), hybridInventoryController.listAlerts);

router.patch(
  "/inventory/:id/acknowledge",
  requirePermission("inventory.update"),
  hybridInventoryController.acknowledgeAlert
);

module.exports = router;
