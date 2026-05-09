const mongoose = require("mongoose");
const { normalizeUnit } = require("../utils/unitConversion");

const ingredientSchema = new mongoose.Schema({
  restaurantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Restaurant",
    required: true
  },

  name: {
    type: String,
    required: true
  },
  itemName: {
    type: String,
    default: ""
  },

  supplier: {
    type: String,
    default: ""
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Supplier",
    default: null
  },
  category: {
    type: String,
    default: "General",
    trim: true
  },
  image: {
    type: String,
    default: "",
    trim: true
  },

  stockCategory: {
    type: String,
    enum: ["RAW_MATERIAL", "PACKAGING"],
    default: "RAW_MATERIAL"
  },

  purchasePrice: {
    type: Number,
    default: 0
  },

  currentStock: {
    type: Number,
    default: 0
  },

  minStockAlert: {
    type: Number,
    default: 0
  },

  lowStockAlert: {
    type: Boolean,
    default: false
  },

  // Legacy compatibility fields
  quantity: {
    type: Number,
    required: true
  },
  stock: {
    type: Number,
    default: 0
  },

  unit: {
    type: String,
    default: "kg"
  },

  minStock: {
    type: Number,
    required: true
  },
  threshold: {
    type: Number,
    default: 0
  },

  minStockUnit: {
    type: String,
    default: ""
  },

  pricePerUnit: {
    type: Number,
    default: 0
  },
  costPerUnit: {
    type: Number,
    default: 0
  },

  purchaseDate: Date,
  expiryDate: Date,

  vendorName: String,
  vendorPhone: String

}, { timestamps: true });

ingredientSchema.pre("validate", function syncInventoryAliases(next) {
  const name = String(this.name || this.itemName || "").trim();
  const quantity = Number(this.quantity ?? this.stock ?? this.currentStock ?? 0);
  const minStock = Number(this.minStock ?? this.threshold ?? this.minStockAlert ?? 0);
  const unitCostSource =
    Number(this.costPerUnit || 0) > 0
      ? this.costPerUnit
      : Number(this.pricePerUnit || 0) > 0
        ? this.pricePerUnit
        : this.purchasePrice;
  const unitCost = Number(unitCostSource || 0);

  this.name = name;
  this.itemName = name;
  this.quantity = Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
  this.stock = this.quantity;
  this.currentStock = this.quantity;
  this.minStock = Number.isFinite(minStock) ? Math.max(0, minStock) : 0;
  this.threshold = this.minStock;
  this.minStockAlert = this.minStock;
  this.costPerUnit = Number.isFinite(unitCost) ? Math.max(0, unitCost) : 0;
  this.pricePerUnit = this.costPerUnit;
  this.purchasePrice = this.costPerUnit;
  this.unit = normalizeUnit(this.unit || "kg") || "kg";
  this.minStockUnit = normalizeUnit(this.minStockUnit || this.unit) || this.unit;
  this.category = String(this.category || "General").trim() || "General";

  next();
});

ingredientSchema.index({ restaurantId: 1, name: 1 });
ingredientSchema.index({ restaurantId: 1, itemName: 1 });
ingredientSchema.index({ restaurantId: 1, lowStockAlert: 1 });
ingredientSchema.index({ restaurantId: 1, stockCategory: 1, name: 1 });
ingredientSchema.index({ restaurantId: 1, category: 1, stockCategory: 1 });
ingredientSchema.index({ restaurantId: 1, supplierId: 1 });
ingredientSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Ingredient", ingredientSchema);
