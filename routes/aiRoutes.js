const express = require("express");

const authorizeRoles = require("../middleware/authorizeRoles");
const { OWNER_ONLY_ROLES } = require("../utils/accessControl");
const {
  chatWithOwner,
  executeAiCampaign,
  generateInsights,
  getLatestInsights
} = require("../controllers/aiController");

const router = express.Router();

router.use(authorizeRoles(OWNER_ONLY_ROLES));
router.post("/generate/:restaurantId", generateInsights);
router.get("/insights/:restaurantId", getLatestInsights);
router.post("/chat", chatWithOwner);
router.post("/campaign/:restaurantId/send", executeAiCampaign);

module.exports = router;
