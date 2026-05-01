const mongoose = require("mongoose");

const MenuVariantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    price: {
      type: Number,
      required: true,
      min: 0
    },
    isDefault: {
      type: Boolean,
      default: false
    }
  },
  { _id: false }
);

const MenuAddOnSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    price: {
      type: Number,
      required: true,
      min: 0
    },
    isAvailable: {
      type: Boolean,
      default: true
    }
  },
  { _id: false }
);

const MenuItemSchema = new mongoose.Schema(
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
    category: {
      type: String,
      default: "General",
      trim: true
    },
    type: {
      type: String,
      enum: ["VEG", "NON_VEG"],
      default: "VEG"
    },
    costPrice: {
      type: Number,
      default: 0,
      min: 0
    },
    cost: {
      type: Number,
      default: 0,
      min: 0
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0
    },
    gstPercentage: {
      type: Number,
      default: 5,
      min: 0
    },
    isAvailable: {
      type: Boolean,
      default: true
    },
    availability: {
      type: String,
      enum: ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"],
      default: "IN_STOCK"
    },
    isActive: {
      type: Boolean,
      default: true
    },
    tags: {
      type: [String],
      default: []
    },
    // Kept for backward compatibility with existing POS screens
    price: {
      type: Number,
      default: 0,
      min: 0
    },
    image: {
      type: String,
      default: ""
    },
    expectedPrepTimeMinutes: {
      type: Number,
      default: 15,
      min: 1
    },
    recipeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Recipe",
      default: null
    },
    recipeLink: {
      type: String,
      default: "",
      trim: true
    },
    variants: {
      type: [MenuVariantSchema],
      default: []
    },
    addOns: {
      type: [MenuAddOnSchema],
      default: []
    }
  },
  { timestamps: true }
);

MenuItemSchema.pre("validate", function syncLegacyMenuFields(next) {
  const normalizedPrice = Number(this.sellingPrice ?? this.price ?? 0);
  const normalizedCost = Number(this.cost ?? this.costPrice ?? 0);
  const normalizedAvailability = String(this.availability || "")
    .trim()
    .toUpperCase();

  this.price = Number.isFinite(normalizedPrice) ? Math.max(0, normalizedPrice) : 0;
  this.sellingPrice = this.price;
  this.cost = Number.isFinite(normalizedCost) ? Math.max(0, normalizedCost) : 0;
  this.costPrice = this.cost;
  this.tags = Array.isArray(this.tags)
    ? this.tags
        .map((tag) => String(tag || "").trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  if (this.isActive === false) {
    this.isAvailable = false;
    this.availability = "OUT_OF_STOCK";
    return next();
  }

  if (["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"].includes(normalizedAvailability)) {
    this.availability = normalizedAvailability;
  } else {
    this.availability = this.isAvailable === false ? "OUT_OF_STOCK" : "IN_STOCK";
  }

  this.isAvailable = this.availability !== "OUT_OF_STOCK";
  next();
});

MenuItemSchema.index({ restaurantId: 1, name: 1 });
MenuItemSchema.index({ restaurantId: 1, category: 1, isAvailable: 1 });
MenuItemSchema.index({ restaurantId: 1, availability: 1, isActive: 1 });
MenuItemSchema.index({ createdAt: -1 });

module.exports = mongoose.model("MenuItem", MenuItemSchema);
