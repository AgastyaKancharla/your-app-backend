const express = require("express");

const authorizeRoles = require("../middleware/authorizeRoles");
const { OWNER_ONLY_ROLES } = require("../utils/accessControl");
const { createTrend } = require("../controllers/trendController");

const router = express.Router();

router.use(authorizeRoles(OWNER_ONLY_ROLES));
router.post("/", createTrend);

module.exports = router;
