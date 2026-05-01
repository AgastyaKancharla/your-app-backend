const express = require("express");

const { getFinanceOverview } = require("../controllers/financeController");
const requirePermission = require("../middleware/requirePermission");
const { requireReportRangeWithinPlan } = require("../middleware/planLimitMiddleware");

const router = express.Router();

router.use(requirePermission("finance.view"));
router.use(requireReportRangeWithinPlan);

router.get("/overview", getFinanceOverview);

module.exports = router;
