const mongoose = require("mongoose");

const RecipeIngredientSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ingredient",
      default: null
    },
    inventoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ingredient",
      default: null
    },
    ingredientName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    quantityRequired: { type: Number, default: 0, min: 0 },
    quantityPerPack: { type: Number, default: 0, min: 0 },
    unit: { type: String, default: "kg" }
  },
  { _id: false }
);

const RecipeSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    menuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MenuItem",
      default: null
    },
    menuItem: { type: String, required: true, trim: true },
    packName: {
      type: String,
      default: "Pack",
      trim: true
    },
    ingredients: {
      type: [RecipeIngredientSchema],
      default: []
    }
  },
  { timestamps: true }
);

RecipeSchema.pre("validate", function syncRecipeIngredientAliases(next) {
  this.ingredients = Array.isArray(this.ingredients)
    ? this.ingredients.map((ingredient) => {
        const itemId = ingredient.itemId || ingredient.inventoryId || null;
        const quantity = Number(
          ingredient.quantityPerPack ?? ingredient.quantityRequired ?? ingredient.quantity ?? 0
        );

        return {
          ...ingredient,
          itemId,
          inventoryId: itemId,
          quantity: Number.isFinite(quantity) ? Math.max(0, quantity) : 0,
          quantityRequired: Number.isFinite(quantity) ? Math.max(0, quantity) : 0,
          quantityPerPack: Number.isFinite(quantity) ? Math.max(0, quantity) : 0
        };
      })
    : [];

  next();
});

RecipeSchema.index({ restaurantId: 1, menuItem: 1 });
RecipeSchema.index({ restaurantId: 1, menuItemId: 1 });
RecipeSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model("Recipe", RecipeSchema);
