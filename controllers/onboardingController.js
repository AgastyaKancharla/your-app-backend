const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Restaurant = require("../models/Restaurant");
const Membership = require("../models/Membership");
const Subscription = require("../models/Subscription");
const OtpVerification = require("../models/OtpVerification");
const { USER_ROLES } = require("../utils/accessControl");
const { parseBoolean, setAuthCookies } = require("../utils/httpCookies");
const {
  MAX_OTP_ATTEMPTS,
  MAX_OTP_RESENDS,
  OTP_TTL_MS,
  normalizePhone,
  generateOtpCode,
  hashOtp,
  compareOtp,
  buildOtpExpiry,
  sendOtpUsingSmsApi
} = require("../services/onboardingOtpService");
const { getTrialEndDate } = require("../services/subscriptionPlans");
const { normalizeBusinessType } = require("../services/workspaceAccess");
const { MEMBERSHIP_ROLES } = require("../utils/membershipRoles");

const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || "1h";
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || "7d";
const INCLUDE_DEV_OTP =
  String(process.env.NODE_ENV || "").toLowerCase() !== "production" &&
  parseBoolean(process.env.ONBOARDING_OTP_INCLUDE_DEV_CODE, false);

const normalizeEmail = (email = "") => String(email || "").trim().toLowerCase();
const normalizeText = (value = "") => String(value || "").trim();

const signAccessToken = (user) => {
  const tenantId = user.tenantId || user.restaurantId || null;
  return jwt.sign(
    {
      userId: user._id,
      restaurantId: tenantId,
      tenantId,
      role: user.role,
      membershipRole: MEMBERSHIP_ROLES.OWNER,
      type: "access"
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
};

const signRefreshToken = (user) => {
  const tenantId = user.tenantId || user.restaurantId || null;
  return jwt.sign(
    {
      userId: user._id,
      restaurantId: tenantId,
      tenantId,
      role: user.role,
      membershipRole: MEMBERSHIP_ROLES.OWNER,
      type: "refresh",
      tokenVersion: Number(user.refreshTokenVersion || 0)
    },
    process.env.JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
};

const sanitizeUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
  restaurantId: user.restaurantId,
  isVerified: Boolean(user.isVerified || user.emailVerified)
});

const sendOtp = async (req, res) => {
  try {
    const name = normalizeText(req.body?.name);
    const phone = normalizePhone(req.body?.phone);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const restaurantName = normalizeText(req.body?.restaurantName);
    const city = normalizeText(req.body?.city);
    const businessType = normalizeBusinessType(req.body?.businessType, "");

    if (!name || !phone || !email || !password || !restaurantName || !city || !businessType) {
      return res.status(400).json({
        message:
          "name, phone, email, password, restaurantName, city and businessType are required"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters"
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { phone }]
    }).lean();
    if (existingUser) {
      return res.status(409).json({
        message: "An account already exists with this email or phone number"
      });
    }

    const otpCode = generateOtpCode();
    const otpHash = hashOtp(otpCode);
    const expiresAt = buildOtpExpiry();
    const passwordHash = await bcrypt.hash(password, 10);

    const now = Date.now();
    const existingOtp = await OtpVerification.findOne({
      phone,
      purpose: "ONBOARDING"
    });

    const withinValidWindow =
      existingOtp && new Date(existingOtp.expiresAt).getTime() > now;
    if (withinValidWindow) {
      const resendCount = Number(existingOtp.resendCount || 0);
      if (resendCount >= MAX_OTP_RESENDS) {
        return res.status(429).json({
          message: "OTP resend limit reached. Please wait for expiry and try again."
        });
      }
    }

    const nextOtpDoc = {
      otp: otpHash,
      expiresAt,
      attempts: 0,
      resendCount: withinValidWindow
        ? Number(existingOtp.resendCount || 0) + 1
        : 0,
      payload: {
        name,
        email,
        passwordHash,
        restaurantName,
        city,
        businessType
      }
    };

    await OtpVerification.findOneAndUpdate(
      { phone, purpose: "ONBOARDING" },
      {
        phone,
        purpose: "ONBOARDING",
        ...nextOtpDoc
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    await sendOtpUsingSmsApi({ phone, otp: otpCode });

    const response = {
      message: "OTP sent successfully",
      otpTtlSeconds: Math.floor(OTP_TTL_MS / 1000),
      maxAttempts: MAX_OTP_ATTEMPTS,
      maxResend: MAX_OTP_RESENDS
    };

    if (INCLUDE_DEV_OTP) {
      response.otpCode = otpCode;
    }

    return res.status(200).json(response);
  } catch (err) {
    return res.serverError(err, { fallbackMessage: "Unable to send OTP at the moment." });
  }
};

const verifyOtpAndCreateWorkspace = async (req, res) => {
  let createdRestaurant = null;
  let createdUser = null;
  try {
    const phone = normalizePhone(req.body?.phone);
    const otp = normalizeText(req.body?.otp);

    if (!phone || !otp) {
      return res.status(400).json({
        message: "phone and otp are required"
      });
    }

    const existingOtp = await OtpVerification.findOne({
      phone,
      purpose: "ONBOARDING"
    });

    if (!existingOtp) {
      return res.status(400).json({ message: "OTP not found. Please request a new OTP." });
    }

    if (new Date(existingOtp.expiresAt).getTime() < Date.now()) {
      await OtpVerification.deleteOne({ _id: existingOtp._id });
      return res.status(400).json({ message: "OTP expired. Please request a new OTP." });
    }

    if (Number(existingOtp.attempts || 0) >= MAX_OTP_ATTEMPTS) {
      await OtpVerification.deleteOne({ _id: existingOtp._id });
      return res.status(429).json({ message: "Maximum OTP attempts reached. Request a new OTP." });
    }

    if (!compareOtp({ plainOtp: otp, otpHash: existingOtp.otp })) {
      const nextAttempts = Number(existingOtp.attempts || 0) + 1;
      if (nextAttempts >= MAX_OTP_ATTEMPTS) {
        await OtpVerification.deleteOne({ _id: existingOtp._id });
      } else {
        existingOtp.attempts = nextAttempts;
        await existingOtp.save();
      }
      return res.status(400).json({ message: "Invalid OTP" });
    }

    const payload = existingOtp.payload || {};
    const email = normalizeEmail(payload.email);
    const name = normalizeText(payload.name);
    const restaurantName = normalizeText(payload.restaurantName);
    const city = normalizeText(payload.city);
    const businessType = normalizeBusinessType(payload.businessType, "");
    const passwordHash = normalizeText(payload.passwordHash);

    if (!email || !name || !restaurantName || !city || !businessType || !passwordHash) {
      await OtpVerification.deleteOne({ _id: existingOtp._id });
      return res.status(400).json({
        message: "Invalid onboarding data. Please restart signup."
      });
    }

    const duplicateUser = await User.findOne({
      $or: [{ email }, { phone }]
    }).lean();
    if (duplicateUser) {
      await OtpVerification.deleteOne({ _id: existingOtp._id });
      return res.status(409).json({
        message: "An account already exists with this email or phone number"
      });
    }

    const now = new Date();
    const trialEndsAt = getTrialEndDate(now);

    createdRestaurant = await Restaurant.create({
      name: restaurantName,
      restaurantName,
      ownerName: name,
      email,
      phone,
      businessType,
      city,
      status: "ACTIVE",
      subscriptionPlan: "STARTER",
      subscriptionExpiry: trialEndsAt
    });

    createdUser = await User.create({
      name,
      email,
      phone,
      passwordHash,
      role: USER_ROLES.OWNER,
      provider: "local",
      restaurantId: createdRestaurant._id,
      emailVerified: true,
      isVerified: true,
      isActive: true
    });

    createdRestaurant.ownerId = createdUser._id;
    await createdRestaurant.save();

    await Subscription.findOneAndUpdate(
      { restaurantId: createdRestaurant._id },
      {
        restaurantId: createdRestaurant._id,
        plan: "STARTER",
        status: "TRIAL",
        startDate: now,
        expiryDate: trialEndsAt,
        trialEndsAt
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
        new: true
      }
    );
    await Membership.findOneAndUpdate(
      {
        userId: createdUser._id,
        tenantId: createdRestaurant._id
      },
      {
        $setOnInsert: {
          userId: createdUser._id,
          tenantId: createdRestaurant._id,
          role: MEMBERSHIP_ROLES.OWNER
        }
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
        new: true
      }
    );

    await OtpVerification.deleteOne({ _id: existingOtp._id });

    const accessToken = signAccessToken(createdUser);
    const refreshToken = signRefreshToken(createdUser);
    setAuthCookies(res, { accessToken, refreshToken });

    return res.status(201).json({
      token: accessToken,
      refreshToken,
      restaurantId: createdUser.restaurantId,
      tenantId: createdUser.restaurantId,
      role: createdUser.role,
      roles: [MEMBERSHIP_ROLES.OWNER],
      activeTenantId: createdUser.restaurantId,
      tenants: [
        {
          id: createdRestaurant._id,
          tenantId: createdRestaurant._id,
          name: createdRestaurant.name,
          businessType: createdRestaurant.businessType,
          role: MEMBERSHIP_ROLES.OWNER
        }
      ],
      user: sanitizeUser(createdUser),
      trialEndsAt
    });
  } catch (err) {
    if (createdRestaurant?._id && !createdUser?._id) {
      await Subscription.deleteOne({ restaurantId: createdRestaurant._id }).catch(() => {});
      await Restaurant.deleteOne({ _id: createdRestaurant._id }).catch(() => {});
    }

    if (err?.code === 11000) {
      return res.status(409).json({
        message: "Account already exists with this email or phone number"
      });
    }

    return res.serverError(err, {
      fallbackMessage: "Unable to verify OTP and create workspace."
    });
  }
};

module.exports = {
  sendOtp,
  verifyOtpAndCreateWorkspace
};
