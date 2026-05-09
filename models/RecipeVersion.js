const mongoose = require("mongoose");

const RecipeVersionIngredientSchema = new mongoose.Schema(
  {
    ingredientId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    ingredientType: {
      type: String,
      enum: ["raw_material", "prep_item"],
      required: true
    },
    ingredientName: {
      type: String,
      default: "",
      trim: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 0
    },
    unit: {
      type: String,
      default: "kg",
      trim: true
    },
    isCritical: {
      type: Boolean,
      default: true
    }
  },
  { _id: false }
);

const RecipeVersionSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    recipeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Recipe",
      required: true
    },
    version: {
      type: Number,
      required: true,
      min: 1
    },
    menuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MenuItem",
      required: true
    },
    variantId: {
      type: String,
      default: "",
      trim: true
    },
    variantName: {
      type: String,
      default: "",
      trim: true
    },
    ingredients: {
      type: [RecipeVersionIngredientSchema],
      default: []
    },
    yieldQuantity: {
      type: Number,
      default: 1,
      min: 0
    },
    preparationLossPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    active: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

RecipeVersionSchema.pre("save", function preventImmutableVersionEdits(next) {
  if (!this.isNew && this.isModified("ingredients")) {
    const error = new Error("Recipe versions are immutable. Create a new version instead.");
    error.status = 400;
    return next(error);
  }
  return next();
});

RecipeVersionSchema.index({ restaurantId: 1, recipeId: 1, version: -1 });
RecipeVersionSchema.index({ restaurantId: 1, menuItemId: 1, variantId: 1, active: 1 });
RecipeVersionSchema.index(
  { recipeId: 1, version: 1 },
  { unique: true }
);

module.exports = mongoose.model("RecipeVersion", RecipeVersionSchema);
