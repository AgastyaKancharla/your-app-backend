const express = require("express");

const authorizeRoles = require("../middleware/authorizeRoles");
const { USER_ROLES } = require("../utils/accessControl");
const { createRestaurantWorkspace } = require("../controllers/restaurantController");

const router = express.Router();

router.post(
  "/create",
  authorizeRoles([USER_ROLES.OWNER]),
  createRestaurantWorkspace
);

module.exports = router;

