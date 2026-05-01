const express = require("express");
const bcrypt = require("bcryptjs");

const User = require("../models/User");
const auditActivity = require("../middleware/auditActivity");
const requirePermission = require("../middleware/requirePermission");
const {
  STAFF_ROLES,
  normalizeRole
} = require("../utils/accessControl");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");
const {
  getCurrentPlanLimits,
  requirePlanFeature,
  buildUpgradeResponse
} = require("../middleware/planLimitMiddleware");

const router = express.Router();

const normalizeEmail = (email = "") => email.trim().toLowerCase();
const normalizeText = (value = "") => String(value || "").trim();
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

const buildEmployment = (body = {}, existing = {}) => ({
  employeeCode: normalizeText(body.employeeCode ?? existing.employeeCode),
  salaryAmount: Math.max(0, toNumber(body.salaryAmount ?? existing.salaryAmount)),
  salaryType: ["MONTHLY", "DAILY", "HOURLY"].includes(
    String(body.salaryType ?? existing.salaryType ?? "").trim().toUpperCase()
  )
    ? String(body.salaryType ?? existing.salaryType ?? "").trim().toUpperCase()
    : "MONTHLY",
  joinedOn: normalizeDate(body.joinedOn ?? existing.joinedOn)
});

const buildAttendance = (body = {}, existing = {}) => ({
  status: ["PRESENT", "ABSENT", "LEAVE", "HALF_DAY", "OFF_DUTY"].includes(
    String(body.status ?? existing.status ?? "").trim().toUpperCase()
  )
    ? String(body.status ?? existing.status ?? "").trim().toUpperCase()
    : "PRESENT",
  presentDays: Math.max(0, toNumber(body.presentDays ?? existing.presentDays)),
  absentDays: Math.max(0, toNumber(body.absentDays ?? existing.absentDays)),
  leaveDays: Math.max(0, toNumber(body.leaveDays ?? existing.leaveDays)),
  punctualityScore: Math.min(
    100,
    Math.max(0, toNumber(body.punctualityScore ?? existing.punctualityScore, 100))
  ),
  lastCheckInAt: normalizeDate(body.lastCheckInAt ?? existing.lastCheckInAt)
});

const buildPerformance = (body = {}, existing = {}) => ({
  rating: Math.min(5, Math.max(0, toNumber(body.rating ?? existing.rating))),
  score: Math.min(100, Math.max(0, toNumber(body.score ?? existing.score))),
  completedOrders: Math.max(0, toNumber(body.completedOrders ?? existing.completedOrders)),
  notes: normalizeText(body.notes ?? existing.notes)
});

const sanitizeUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
  isActive: user.isActive,
  createdAt: user.createdAt,
  employment: {
    employeeCode: user.employment?.employeeCode || "",
    salaryAmount: Number(user.employment?.salaryAmount || 0),
    salaryType: user.employment?.salaryType || "MONTHLY",
    joinedOn: user.employment?.joinedOn || null
  },
  attendance: {
    status: user.attendance?.status || "PRESENT",
    presentDays: Number(user.attendance?.presentDays || 0),
    absentDays: Number(user.attendance?.absentDays || 0),
    leaveDays: Number(user.attendance?.leaveDays || 0),
    punctualityScore: Number(user.attendance?.punctualityScore ?? 100),
    lastCheckInAt: user.attendance?.lastCheckInAt || null
  },
  performance: {
    rating: Number(user.performance?.rating || 0),
    score: Number(user.performance?.score || 0),
    completedOrders: Number(user.performance?.completedOrders || 0),
    notes: user.performance?.notes || ""
  }
});

const listStaff = async (req, res) => {
  try {
    const users = await User.find(withTenantFilter(req)).sort({ createdAt: -1 });
    return res.json(users.map(sanitizeUser));
  } catch (err) {
    return res.serverError(err);
  }
};

const createStaff = async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);

    const name = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email);
    const phone = String(req.body?.phone || "").trim();
    const role = normalizeRole(req.body?.role);
    const password = String(req.body?.password || "");
    const employment = buildEmployment(req.body);
    const attendance = buildAttendance(req.body);
    const performance = buildPerformance(req.body);

    if (!name || !email || !role || !password) {
      return res
        .status(400)
        .json({ message: "name, email, role and password are required" });
    }

    if (!STAFF_ROLES.includes(role)) {
      return res.status(400).json({ message: "Invalid staff role" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const maxStaffUsers = Number(getCurrentPlanLimits(req).maxStaffUsers || 0);
    const staffCount = await User.countDocuments(
      withTenantFilter(req, {
        role: { $ne: "OWNER" }
      })
    );

    if (staffCount >= maxStaffUsers) {
      return res.status(403).json(
        buildUpgradeResponse({
          req,
          feature: "staffSeats",
          message: `Staff limit reached (${maxStaffUsers} seats). Upgrade your plan for more users.`,
          requiredPlan: "PRO",
          limit: maxStaffUsers,
          current: staffCount
        })
      );
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const created = await User.create({
      restaurantId,
      name,
      email,
      phone,
      role,
      passwordHash,
      provider: "local",
      isActive: true,
      employment,
      attendance,
      performance
    });

    return res.status(201).json(sanitizeUser(created));
  } catch (err) {
    return res.serverError(err);
  }
};

router.get("/", requirePermission("staff.view"), listStaff);
router.get("/list", requirePermission("staff.view"), listStaff);

router.post(
  "/",
  requirePermission("staff.create"),
  auditActivity({ action: "User added", module: "Staff" }),
  requirePlanFeature("staffManagement", {
    requiredPlan: "GROWTH",
    message: "Staff management is available on GROWTH and above plans."
  }),
  createStaff
);

router.post(
  "/create",
  requirePermission("staff.create"),
  auditActivity({ action: "User added", module: "Staff" }),
  requirePlanFeature("staffManagement", {
    requiredPlan: "GROWTH",
    message: "Staff management is available on GROWTH and above plans."
  }),
  createStaff
);

router.put(
  "/:id",
  requirePermission("staff.update"),
  auditActivity({ action: "Role changed", module: "Staff" }),
  requirePlanFeature("staffManagement", {
    requiredPlan: "GROWTH",
    message: "Staff management is available on GROWTH and above plans."
  }),
  async (req, res) => {
  try {
    const updates = {};
    if (req.body?.name !== undefined) {
      updates.name = String(req.body.name || "").trim();
    }
    if (req.body?.phone !== undefined) {
      updates.phone = String(req.body.phone || "").trim();
    }
    if (req.body?.role !== undefined) {
      const role = normalizeRole(req.body.role);
      if (!STAFF_ROLES.includes(role)) {
        return res.status(400).json({ message: "Invalid staff role" });
      }
      updates.role = role;
    }
    if (req.body?.isActive !== undefined) {
      updates.isActive = Boolean(req.body.isActive);
    }
    if (req.body?.employeeCode !== undefined ||
      req.body?.salaryAmount !== undefined ||
      req.body?.salaryType !== undefined ||
      req.body?.joinedOn !== undefined) {
      updates.employment = buildEmployment(req.body, req.body?.employment || {});
    }
    if (req.body?.attendance !== undefined ||
      req.body?.attendanceStatus !== undefined ||
      req.body?.presentDays !== undefined ||
      req.body?.absentDays !== undefined ||
      req.body?.leaveDays !== undefined ||
      req.body?.punctualityScore !== undefined ||
      req.body?.lastCheckInAt !== undefined) {
      const attendancePayload = req.body?.attendance || {
        status: req.body?.attendanceStatus,
        presentDays: req.body?.presentDays,
        absentDays: req.body?.absentDays,
        leaveDays: req.body?.leaveDays,
        punctualityScore: req.body?.punctualityScore,
        lastCheckInAt: req.body?.lastCheckInAt
      };
      updates.attendance = buildAttendance(attendancePayload, req.body?.attendance || {});
    }
    if (req.body?.performance !== undefined ||
      req.body?.performanceRating !== undefined ||
      req.body?.performanceScore !== undefined ||
      req.body?.completedOrders !== undefined ||
      req.body?.performanceNotes !== undefined) {
      const performancePayload = req.body?.performance || {
        rating: req.body?.performanceRating,
        score: req.body?.performanceScore,
        completedOrders: req.body?.completedOrders,
        notes: req.body?.performanceNotes
      };
      updates.performance = buildPerformance(performancePayload, req.body?.performance || {});
    }
    if (req.body?.password !== undefined) {
      const password = String(req.body.password || "");
      if (password && password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }
      if (password) {
        updates.passwordHash = await bcrypt.hash(password, 10);
      }
    }

    const existing = await User.findOne(
      withTenantDocFilter(req, req.params.id, { role: { $ne: "OWNER" } })
    );

    if (!existing) {
      return res.status(404).json({ message: "Staff user not found" });
    }

    if (updates.employment) {
      updates.employment = buildEmployment(updates.employment, existing.employment || {});
    }
    if (updates.attendance) {
      updates.attendance = buildAttendance(updates.attendance, existing.attendance || {});
    }
    if (updates.performance) {
      updates.performance = buildPerformance(updates.performance, existing.performance || {});
    }

    const updated = await User.findByIdAndUpdate(existing._id, updates, { new: true });

    return res.json(sanitizeUser(updated));
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
