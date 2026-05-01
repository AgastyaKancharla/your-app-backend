const mongoose = require("mongoose");

const SUBSCRIPTION_PLANS = ["STARTER", "GROWTH", "PRO", "ENTERPRISE"];
const SUBSCRIPTION_STATUSES = ["TRIAL", "ACTIVE", "EXPIRED", "CANCELLED"];

const subscriptionSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      unique: true,
      index: true
    },
    plan: {
      type: String,
      enum: SUBSCRIPTION_PLANS,
      default: "STARTER",
      required: true
    },
    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      default: "TRIAL",
      required: true
    },
    startDate: {
      type: Date,
      default: Date.now,
      required: true
    },
    expiryDate: {
      type: Date,
      default: null
    },
    trialEndsAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

subscriptionSchema.index({ restaurantId: 1, status: 1 });
subscriptionSchema.index({ restaurantId: 1, plan: 1 });

module.exports = mongoose.model("Subscription", subscriptionSchema);
module.exports.SUBSCRIPTION_PLANS = SUBSCRIPTION_PLANS;
module.exports.SUBSCRIPTION_STATUSES = SUBSCRIPTION_STATUSES;

