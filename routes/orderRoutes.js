const express = require("express");

const auditActivity = require("../middleware/auditActivity");
const requirePermission = require("../middleware/requirePermission");
const orderController = require("../controllers/orderController");

const router = express.Router();

router.post(
  "/",
  requirePermission("pos.create"),
  auditActivity({ action: "Order created", module: "POS" }),
  orderController.createOrder
);
router.get("/", requirePermission("orders.view"), orderController.listOrders);
router.get("/active", requirePermission("orders.view"), orderController.listActiveOrders);
router.get(
  "/insights",
  requirePermission("orders.view"),
  orderController.getOrderInsights
);
router.get(
  "/analytics-summary",
  requirePermission("orders.view"),
  orderController.getOrderAnalyticsSummary
);
router.get(
  "/report/daily",
  requirePermission("finance.view"),
  orderController.getDailyReport
);
router.get(
  "/report/monthly",
  requirePermission("finance.view"),
  orderController.getMonthlyReport
);
router
  .route("/:id/status")
  .patch(
    requirePermission("orders.update"),
    auditActivity({ action: "Order updated", module: "Orders" }),
    orderController.updateOrderStatus
  )
  .put(
    requirePermission("orders.update"),
    auditActivity({ action: "Order updated", module: "Orders" }),
    orderController.updateOrderStatus
  );
router.put(
  "/:id/cancel",
  requirePermission("orders.update"),
  auditActivity({ action: "Order cancelled", module: "Orders" }),
  orderController.cancelOrder
);
router.delete(
  "/:id",
  requirePermission("orders.delete"),
  auditActivity({ action: "Order deleted", module: "Orders" }),
  orderController.deleteOrder
);

module.exports = router;
