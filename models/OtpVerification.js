const mongoose = require("mongoose");

const OTP_PURPOSES = ["ONBOARDING"];

const otpVerificationSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    otp: {
      type: String,
      required: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0
    },
    resendCount: {
      type: Number,
      default: 0,
      min: 0
    },
    purpose: {
      type: String,
      enum: OTP_PURPOSES,
      default: "ONBOARDING",
      required: true
    },
    payload: {
      name: { type: String, default: "", trim: true },
      email: { type: String, default: "", trim: true, lowercase: true },
      passwordHash: { type: String, default: "" },
      restaurantName: { type: String, default: "", trim: true },
      city: { type: String, default: "", trim: true }
    }
  },
  { timestamps: true }
);

otpVerificationSchema.index({ phone: 1, purpose: 1 }, { unique: true });
otpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("OtpVerification", otpVerificationSchema);
module.exports.OTP_PURPOSES = OTP_PURPOSES;
