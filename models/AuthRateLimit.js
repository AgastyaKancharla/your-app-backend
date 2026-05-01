const mongoose = require("mongoose");

const authRateLimitSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    count: {
      type: Number,
      default: 0
    },
    windowExpiresAt: {
      type: Date,
      required: true,
      index: {
        expireAfterSeconds: 0
      }
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("AuthRateLimit", authRateLimitSchema);
