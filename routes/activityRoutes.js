const express = require("express");

const ActivityLog = require("../models/ActivityLog");
const requirePermission = require("../middleware/requirePermission");
const { withTenantFilter } = require("../utils/tenantScope");

const router = express.Router();

router.get("/", requirePermission("audit.view"), async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    const logs = await ActivityLog.find(withTenantFilter(req))
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json(
      logs.map((log) => ({
        id: log._id,
        userId: log.userId,
        userName: log.userName || "System",
        role: log.role || "",
        action: log.action,
        module: log.module,
        metadata: log.metadata || {},
        timestamp: log.createdAt
      }))
    );
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
