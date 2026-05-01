const crypto = require("crypto");
const mongoose = require("mongoose");

const buildIntegrationKey = () => crypto.randomBytes(24).toString("hex");

const partnerIntegrationSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    storeId: { type: String, default: "", trim: true },
    locationLabel: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true }
  },
  { _id: false }
);

const websiteIntegrationSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    notes: { type: String, default: "", trim: true }
  },
  { _id: false }
);

const whatsappIntegrationSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    phoneNumberId: { type: String, default: "", trim: true },
    businessName: { type: String, default: "", trim: true }
  },
  { _id: false }
);

const restaurantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    restaurantName: { type: String, default: "", trim: true },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    ownerName: { type: String, default: "", trim: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "", trim: true },
    businessType: {
      type: String,
      enum: ["CLOUD_KITCHEN", "RESTAURANT"],
      default: null,
      trim: true
    },
    cuisineType: { type: String, default: "", trim: true },
    gstNumber: { type: String, default: "", trim: true },
    fssaiLicense: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    location: { type: String, default: "", trim: true },
    audienceType: { type: String, default: "", trim: true },
    avgPrice: { type: Number, default: 0, min: 0 },
    menu: { type: [String], default: [] },
    logoUrl: { type: String, default: "", trim: true },
    websiteUrl: { type: String, default: "", trim: true },
    integrationApiKey: {
      type: String,
      default: buildIntegrationKey,
      trim: true
    },
    orderIntegrations: {
      swiggy: {
        type: partnerIntegrationSchema,
        default: () => ({})
      },
      zomato: {
        type: partnerIntegrationSchema,
        default: () => ({})
      },
      magicpin: {
        type: partnerIntegrationSchema,
        default: () => ({})
      },
      otherApps: {
        type: partnerIntegrationSchema,
        default: () => ({})
      },
      website: {
        type: websiteIntegrationSchema,
        default: () => ({})
      }
    },
    whatsapp: {
      type: whatsappIntegrationSchema,
      default: () => ({})
    },
    city: { type: String, default: "", trim: true },
    pincode: { type: String, default: "", trim: true },
    subscriptionPlan: {
      type: String,
      enum: ["FREE", "BASIC", "STARTER", "GROWTH", "PRO", "ENTERPRISE"],
      default: "STARTER"
    },
    subscriptionExpiry: { type: Date, default: null },
    billingProvider: {
      type: String,
      enum: ["NONE", "STRIPE"],
      default: "NONE"
    },
    billingCustomerId: {
      type: String,
      default: "",
      trim: true
    },
    billingSubscriptionId: {
      type: String,
      default: "",
      trim: true
    },
    billingStatus: {
      type: String,
      default: "inactive",
      trim: true
    },
    billingCurrentPeriodEnd: { type: Date, default: null },
    billingLastWebhookAt: { type: Date, default: null },
    status: { type: String, enum: ["ACTIVE", "SUSPENDED"], default: "ACTIVE" }
  },
  { timestamps: true }
);

restaurantSchema.pre("validate", function syncRestaurantName(next) {
  const trimmedName = String(this.name || "").trim();
  const trimmedRestaurantName = String(this.restaurantName || "").trim();

  if (!trimmedName && trimmedRestaurantName) {
    this.name = trimmedRestaurantName;
  }
  if (!trimmedRestaurantName && trimmedName) {
    this.restaurantName = trimmedName;
  }

  next();
});

restaurantSchema.pre("save", function ensureIntegrationKey(next) {
  if (!String(this.integrationApiKey || "").trim()) {
    this.integrationApiKey = buildIntegrationKey();
  }

  next();
});

restaurantSchema.index({ email: 1 });
restaurantSchema.index({ ownerId: 1 });
restaurantSchema.index({ subscriptionExpiry: 1 });
restaurantSchema.index({ billingCustomerId: 1 });
restaurantSchema.index({ billingSubscriptionId: 1 });
restaurantSchema.index({ integrationApiKey: 1 });
restaurantSchema.index({ "whatsapp.phoneNumberId": 1 });

module.exports = mongoose.model("Restaurant", restaurantSchema);
