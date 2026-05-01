const express = require("express");

const loginRateLimit = require("../middleware/loginRateLimit");
const {
  sendOtp,
  verifyOtpAndCreateWorkspace
} = require("../controllers/onboardingController");

const router = express.Router();

router.post("/send-otp", loginRateLimit, sendOtp);
router.post("/verify-otp", loginRateLimit, verifyOtpAndCreateWorkspace);

module.exports = router;

