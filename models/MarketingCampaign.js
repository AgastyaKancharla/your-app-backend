const mongoose = require("mongoose");

const MarketingCampaignSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    channel: {
      type: String,
      enum: ["WHATSAPP", "SMS"],
      required: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    message: {
      type: String,
      required: true,
      trim: true
    },
    couponCode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true
    },
    audienceCount: {
      type: Number,
      default: 0,
      min: 0
    },
    status: {
      type: String,
      enum: ["DRAFT", "SENT"],
      default: "SENT"
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  { timestamps: true }
);

MarketingCampaignSchema.index({ restaurantId: 1, channel: 1, createdAt: -1 });

module.exports = mongoose.model("MarketingCampaign", MarketingCampaignSchema);
