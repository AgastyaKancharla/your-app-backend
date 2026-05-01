const mongoose = require("mongoose");

const SupplierSchema = new mongoose.Schema(
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
    contactPerson: {
      type: String,
      default: "",
      trim: true
    },
    phone: {
      type: String,
      default: "",
      trim: true
    },
    contact: {
      type: String,
      default: "",
      trim: true
    },
    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true
    },
    gstNumber: {
      type: String,
      default: "",
      trim: true
    },
    address: {
      type: String,
      default: "",
      trim: true
    },
    notes: {
      type: String,
      default: "",
      trim: true
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    onTimeDelivery: {
      type: Number,
      default: 100,
      min: 0,
      max: 100
    },
    category: {
      type: String,
      default: "General",
      trim: true
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

SupplierSchema.pre("validate", function syncSupplierAliases(next) {
  this.contact = String(this.contact || this.phone || this.email || "").trim();
  this.category = String(this.category || "General").trim() || "General";
  next();
});

SupplierSchema.index({ restaurantId: 1, name: 1 }, { unique: true });
SupplierSchema.index({ restaurantId: 1, isActive: 1, createdAt: -1 });
SupplierSchema.index({ restaurantId: 1, category: 1, isActive: 1 });

module.exports = mongoose.model("Supplier", SupplierSchema);
