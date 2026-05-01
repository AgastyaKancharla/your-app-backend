const Restaurant = require("../models/Restaurant");
const Subscription = require("../models/Subscription");
const User = require("../models/User");
const { getTenantRestaurantId } = require("../utils/tenantScope");
const { getTrialEndDate } = require("../services/subscriptionPlans");
const { normalizeBusinessType } = require("../services/workspaceAccess");
const { USER_ROLES } = require("../utils/accessControl");

const normalizeText = (value = "") => String(value || "").trim();

const createRestaurantWorkspace = async (req, res) => {
  try {
    const tenantRestaurantId = getTenantRestaurantId(req);
    if (tenantRestaurantId) {
      return res.status(409).json({
        message: "Restaurant workspace already exists for this account"
      });
    }

    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const restaurantName = normalizeText(req.body?.restaurantName);
    const businessType = normalizeBusinessType(req.body?.businessType, "");
    const cuisineType = normalizeText(req.body?.cuisineType);
    const address = normalizeText(req.body?.address);
    const city = normalizeText(req.body?.city);
    const pincode = normalizeText(req.body?.pincode);
    const gstNumber = normalizeText(req.body?.gstNumber);
    const fssaiLicense = normalizeText(req.body?.fssaiLicense);

    if (!restaurantName || !city || !businessType) {
      return res.status(400).json({
        message: "restaurantName, city and businessType are required"
      });
    }

    const trialEndsAt = getTrialEndDate();
    const restaurant = await Restaurant.create({
      name: restaurantName,
      restaurantName,
      ownerId: user._id,
      ownerName: user.name || "",
      email: user.email || "",
      phone: user.phone || "",
      businessType,
      cuisineType,
      address,
      city,
      pincode,
      gstNumber,
      fssaiLicense,
      subscriptionPlan: "STARTER",
      subscriptionExpiry: trialEndsAt,
      status: "ACTIVE"
    });

    user.restaurantId = restaurant._id;
    user.role = USER_ROLES.OWNER;
    user.isVerified = true;
    user.emailVerified = true;
    await user.save();

    await Subscription.findOneAndUpdate(
      { restaurantId: restaurant._id },
      {
        restaurantId: restaurant._id,
        plan: "STARTER",
        status: "TRIAL",
        startDate: new Date(),
        expiryDate: trialEndsAt,
        trialEndsAt
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    return res.status(201).json({
      message: "Restaurant workspace created",
      restaurant: {
        id: restaurant._id,
        restaurantName: restaurant.restaurantName || restaurant.name,
        ownerId: restaurant.ownerId,
        city: restaurant.city,
        plan: restaurant.subscriptionPlan,
        trialEndsAt
      }
    });
  } catch (err) {
    return res.serverError(err, { fallbackMessage: "Unable to create restaurant workspace." });
  }
};

module.exports = {
  createRestaurantWorkspace
};
