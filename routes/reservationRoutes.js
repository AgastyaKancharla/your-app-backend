const express = require("express");

const Reservation = require("../models/Reservation");
const Table = require("../models/Table");
const authorizeRoles = require("../middleware/authorizeRoles");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");
const { RESERVATION_MANAGEMENT_ROLES } = require("../utils/accessControl");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");

const router = express.Router();

router.use(
  requirePlanFeature("reservationSystem", {
    requiredPlan: "PRO",
    message: "Reservation system is available on PRO and above plans."
  })
);

const normalizeText = (value = "") => String(value || "").trim();
const normalizePhone = (value = "") => String(value || "").replace(/[^\d+]/g, "").trim();
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeDate = (value) => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeStatus = (value = "") => {
  const status = String(value || "").trim().toUpperCase();
  if (["BOOKED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW"].includes(status)) {
    return status;
  }
  return "BOOKED";
};

const normalizeSource = (value = "") => {
  const source = String(value || "").trim().toUpperCase();
  if (["PHONE", "WALK_IN", "ONLINE", "WHATSAPP"].includes(source)) {
    return source;
  }
  return "PHONE";
};

const buildReservationPayload = (body = {}) => ({
  customerName: normalizeText(body.customerName),
  customerPhone: normalizePhone(body.customerPhone),
  customerEmail: normalizeText(body.customerEmail).toLowerCase(),
  partySize: Math.max(1, toNumber(body.partySize, 2)),
  reservedFor: normalizeDate(body.reservedFor),
  expectedDurationMinutes: Math.max(15, toNumber(body.expectedDurationMinutes, 90)),
  source: normalizeSource(body.source),
  status: normalizeStatus(body.status),
  notes: normalizeText(body.notes),
  tableId: body.tableId || null
});

const syncTableStatusForReservation = async ({ req, reservation, status }) => {
  if (!reservation?.tableId) {
    return;
  }

  const table = await Table.findOne(withTenantDocFilter(req, reservation.tableId));
  if (!table) {
    return;
  }

  if (status === "SEATED") {
    table.status = "OCCUPIED";
    table.currentCustomerName = reservation.customerName || "";
  } else if (status === "BOOKED") {
    table.status = "RESERVED";
    table.currentCustomerName = reservation.customerName || "";
  } else if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(status)) {
    table.status = "AVAILABLE";
    table.currentCustomerName = "";
    table.currentOrderId = null;
  }

  await table.save();
};

router.get("/", authorizeRoles(RESERVATION_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const filter = withTenantFilter(req);
    const status = normalizeText(req.query?.status).toUpperCase();
    if (status && status !== "ALL") {
      filter.status = normalizeStatus(status);
    }

    const from = normalizeDate(req.query?.from);
    const to = normalizeDate(req.query?.to);
    if (from || to) {
      filter.reservedFor = {};
      if (from) {
        from.setHours(0, 0, 0, 0);
        filter.reservedFor.$gte = from;
      }
      if (to) {
        to.setHours(23, 59, 59, 999);
        filter.reservedFor.$lte = to;
      }
    }

    const reservations = await Reservation.find(filter)
      .populate("tableId", "code displayName status capacity")
      .sort({ reservedFor: 1, createdAt: -1 });

    return res.json(reservations);
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/", authorizeRoles(RESERVATION_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const payload = buildReservationPayload(req.body);

    if (!payload.customerName || !payload.reservedFor) {
      return res.status(400).json({
        message: "Customer name and reservation date/time are required"
      });
    }

    if (payload.tableId) {
      const table = await Table.findOne(withTenantDocFilter(req, payload.tableId));
      if (!table) {
        return res.status(404).json({ message: "Selected table was not found" });
      }
    }

    const created = await Reservation.create({
      restaurantId,
      createdBy: req.user?.userId || null,
      ...payload
    });

    await syncTableStatusForReservation({
      req,
      reservation: created,
      status: payload.status
    });

    const populated = await Reservation.findById(created._id).populate(
      "tableId",
      "code displayName status capacity"
    );

    return res.status(201).json(populated);
  } catch (err) {
    return res.serverError(err);
  }
});

router.put("/:id", authorizeRoles(RESERVATION_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const updates = buildReservationPayload(req.body);
    if (!updates.customerName || !updates.reservedFor) {
      return res.status(400).json({
        message: "Customer name and reservation date/time are required"
      });
    }

    if (updates.tableId) {
      const table = await Table.findOne(withTenantDocFilter(req, updates.tableId));
      if (!table) {
        return res.status(404).json({ message: "Selected table was not found" });
      }
    }

    const reservation = await Reservation.findOneAndUpdate(
      withTenantDocFilter(req, req.params.id),
      updates,
      {
        new: true,
        runValidators: true
      }
    );

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    await syncTableStatusForReservation({
      req,
      reservation,
      status: updates.status
    });

    const populated = await Reservation.findById(reservation._id).populate(
      "tableId",
      "code displayName status capacity"
    );

    return res.json(populated);
  } catch (err) {
    return res.serverError(err);
  }
});

router.put("/:id/status", authorizeRoles(RESERVATION_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const status = normalizeStatus(req.body?.status);
    const reservation = await Reservation.findOneAndUpdate(
      withTenantDocFilter(req, req.params.id),
      { status },
      {
        new: true,
        runValidators: true
      }
    );

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    await syncTableStatusForReservation({
      req,
      reservation,
      status
    });

    const populated = await Reservation.findById(reservation._id).populate(
      "tableId",
      "code displayName status capacity"
    );

    return res.json(populated);
  } catch (err) {
    return res.serverError(err);
  }
});

router.delete("/:id", authorizeRoles(RESERVATION_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const reservation = await Reservation.findOneAndDelete(withTenantDocFilter(req, req.params.id));
    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    await syncTableStatusForReservation({
      req,
      reservation,
      status: "CANCELLED"
    });

    return res.json({ message: "Reservation removed" });
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
