const mongoose = require("mongoose");

const reservationSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Table",
      default: null
    },
    customerName: {
      type: String,
      required: true,
      trim: true
    },
    customerPhone: {
      type: String,
      default: "",
      trim: true
    },
    customerEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true
    },
    partySize: {
      type: Number,
      min: 1,
      default: 2
    },
    reservedFor: {
      type: Date,
      required: true
    },
    expectedDurationMinutes: {
      type: Number,
      min: 15,
      default: 90
    },
    source: {
      type: String,
      enum: ["PHONE", "WALK_IN", "ONLINE", "WHATSAPP"],
      default: "PHONE"
    },
    status: {
      type: String,
      enum: ["BOOKED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW"],
      default: "BOOKED"
    },
    notes: {
      type: String,
      default: "",
      trim: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  { timestamps: true }
);

reservationSchema.index({ restaurantId: 1, reservedFor: 1, status: 1 });
reservationSchema.index({ restaurantId: 1, customerPhone: 1 });
reservationSchema.index({ restaurantId: 1, tableId: 1, reservedFor: 1 });

module.exports = mongoose.model("Reservation", reservationSchema);
