const express = require("express");

const authorizeRoles = require("../middleware/authorizeRoles");
const { USER_ROLES } = require("../utils/accessControl");
const {
  getSubscriptionStatus,
  selectSubscriptionPlan
} = require("../controllers/subscriptionController");

const router = express.Router();

router.get(
  "/status",
  authorizeRoles([
    USER_ROLES.OWNER,
    USER_ROLES.MANAGER,
    USER_ROLES.ACCOUNTANT
  ]),
  getSubscriptionStatus
);

router.post(
  "/select-plan",
  authorizeRoles([USER_ROLES.OWNER]),
  selectSubscriptionPlan
);

module.exports = router;

