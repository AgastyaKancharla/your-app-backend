const express = require("express");

const Order = require("../models/Order");
const auditActivity = require("../middleware/auditActivity");
const requirePermission = require("../middleware/requirePermission");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");
const { normalizeOrderStatus } = require("../utils/accessControl");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");

const router = express.Router();
router.use(
  requirePlanFeature("deliveryManagement", {
    requiredPlan: "GROWTH",
    message: "Delivery management is available on GROWTH and above plans."
  })
);

const normalizeText = (value = "") => String(value || "").trim();
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const emitTenantOrderEvent = (req, eventName, orderPayload) => {
  const ordersIo = req.app.get("ordersIo");
  const restaurantId = getTenantRestaurantId(req);
  if (!ordersIo || !restaurantId) {
    return;
  }

  ordersIo.to(`tenant:${restaurantId}`).emit(eventName, orderPayload);
};

router.get("/", requirePermission("dispatch.view"), async (req, res) => {
  try {
    const status = String(req.query?.status || "").trim().toUpperCase();
    const scopedFilter = withTenantFilter(req, {
      status: status ? normalizeOrderStatus(status, "") : "READY"
    });
    if (scopedFilter.status === "") {
      delete scopedFilter.status;
    }

    const orders = await Order.find(scopedFilter).sort({ createdAt: -1 }).limit(200);
    return res.json(orders);
  } catch (err) {
    return res.serverError(err);
  }
});

router.put(
  "/:id/assign",
  requirePermission("dispatch.update"),
  auditActivity({ action: "Delivery assigned", module: "Dispatch" }),
  async (req, res) => {
  try {
    const order = await Order.findOne(withTenantDocFilter(req, req.params.id));
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const currentStatus = normalizeOrderStatus(order.status);
    if (["DELIVERED", "DISPATCHED"].includes(currentStatus)) {
      return res.status(400).json({ message: "Completed orders cannot be assigned for delivery." });
    }

    if (currentStatus !== "READY") {
      return res.status(400).json({
        message: "Order must be Ready before assigning delivery."
      });
    }

    const partnerName = normalizeText(req.body?.partnerName);
    if (!partnerName) {
      return res.status(400).json({ message: "Delivery partner name is required" });
    }

    order.delivery = {
      partnerName,
      partnerPhone: normalizeText(req.body?.partnerPhone),
      etaMinutes: Math.max(0, toNumber(req.body?.etaMinutes)),
      notes: normalizeText(req.body?.notes),
      assignedAt: new Date(),
      deliveredAt: null
    };
    order.status = "READY";
    await order.save();
    emitTenantOrderEvent(req, "order:update", order.toObject());

    return res.json(order);
  } catch (err) {
    return res.serverError(err);
  }
  }
);

router.put(
  "/:id/complete",
  requirePermission("dispatch.update"),
  auditActivity({ action: "Delivery completed", module: "Dispatch" }),
  async (req, res) => {
  try {
    const order = await Order.findOne(withTenantDocFilter(req, req.params.id));
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const currentStatus = normalizeOrderStatus(order.status);
    if (currentStatus !== "READY") {
      return res.status(400).json({ message: "Order is not in delivery stage." });
    }

    const completionTime = new Date();
    order.status = "DISPATCHED";
    order.completedAt = order.completedAt || completionTime;
    order.delivery = {
      ...(order.delivery || {}),
      deliveredAt: completionTime
    };
    await order.save();
    emitTenantOrderEvent(req, "order:update", order.toObject());

    return res.json(order);
  } catch (err) {
    return res.serverError(err);
  }
  }
);

module.exports = router;
