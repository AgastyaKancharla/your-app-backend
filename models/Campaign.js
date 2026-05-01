const mongoose = require("mongoose");

const CampaignMetricsSchema = new mongoose.Schema(
  {
    sent: {
      type: Number,
      default: 0,
      min: 0
    },
    delivered: {
      type: Number,
      default: 0,
      min: 0
    },
    opened: {
      type: Number,
      default: 0,
      min: 0
    },
    clicked: {
      type: Number,
      default: 0,
      min: 0
    },
    orders: {
      type: Number,
      default: 0,
      min: 0
    },
    revenue: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  { _id: false }
);

const CampaignSchema = new mongoose.Schema(
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
    type: {
      type: String,
      default: "PROMO",
      trim: true
    },
    channel: {
      type: String,
      enum: ["WHATSAPP", "SMS"],
      required: true
    },
    audience: {
      type: String,
      default: "ALL",
      trim: true
    },
    message: {
      type: String,
      default: "",
      trim: true
    },
    scheduledFor: {
      type: Date,
      default: null
    },
    status: {
      type: String,
      enum: ["DRAFT", "SCHEDULED", "SENT"],
      default: "SENT"
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    metrics: {
      type: CampaignMetricsSchema,
      default: () => ({})
    }
  },
  { timestamps: true }
);

CampaignSchema.index({ restaurantId: 1, createdAt: -1 });
CampaignSchema.index({ restaurantId: 1, channel: 1, status: 1 });

module.exports = mongoose.model("Campaign", CampaignSchema);
