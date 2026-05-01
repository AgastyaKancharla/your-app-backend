const mongoose = require("mongoose");

const MarketingAutomationSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    triggerType: {
      type: String,
      enum: ["INACTIVE_30_DAYS", "FIRST_ORDER", "LOYALTY_MILESTONE", "MANUAL_SEGMENT"],
      default: "INACTIVE_30_DAYS"
    },
    channel: {
      type: String,
      enum: ["WHATSAPP", "SMS"],
      default: "WHATSAPP"
    },
    messageTemplate: {
      type: String,
      default: "",
      trim: true
    },
    couponCode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true
    },
    isActive: {
      type: Boolean,
      default: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  { timestamps: true }
);

MarketingAutomationSchema.index({ restaurantId: 1, isActive: 1, createdAt: -1 });

module.exports = mongoose.model("MarketingAutomation", MarketingAutomationSchema);
