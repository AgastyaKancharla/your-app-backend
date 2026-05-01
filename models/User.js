const mongoose = require("mongoose");
const { ALL_USER_ROLES, USER_ROLES } = require("../utils/accessControl");

const EmploymentSchema = new mongoose.Schema(
  {
    employeeCode: {
      type: String,
      default: "",
      trim: true
    },
    salaryAmount: {
      type: Number,
      default: 0,
      min: 0
    },
    salaryType: {
      type: String,
      enum: ["MONTHLY", "DAILY", "HOURLY"],
      default: "MONTHLY"
    },
    joinedOn: {
      type: Date,
      default: null
    }
  },
  { _id: false }
);

const AttendanceSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["PRESENT", "ABSENT", "LEAVE", "HALF_DAY", "OFF_DUTY"],
      default: "PRESENT"
    },
    presentDays: {
      type: Number,
      default: 0,
      min: 0
    },
    absentDays: {
      type: Number,
      default: 0,
      min: 0
    },
    leaveDays: {
      type: Number,
      default: 0,
      min: 0
    },
    punctualityScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100
    },
    lastCheckInAt: {
      type: Date,
      default: null
    }
  },
  { _id: false }
);

const PerformanceSchema = new mongoose.Schema(
  {
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    score: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    completedOrders: {
      type: Number,
      default: 0,
      min: 0
    },
    notes: {
      type: String,
      default: "",
      trim: true
    }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    unique: true,
    required: true,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    trim: true
  },
  passwordHash: {
    type: String,
    default: ""
  },
  provider: {
    type: String,
    enum: ["local", "google"],
    default: "local"
  },
  googleId: {
    type: String,
    default: ""
  },
  avatarUrl: {
    type: String,
    default: ""
  },
  role: {
    type: String,
    enum: ALL_USER_ROLES,
    default: USER_ROLES.OWNER
  },
  businessType: {
    type: String,
    enum: ["CLOUD_KITCHEN", "RESTAURANT"],
    default: null
  },
  restaurantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Restaurant"
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationTokenHash: {
    type: String,
    default: ""
  },
  emailVerificationExpiresAt: {
    type: Date,
    default: null
  },
  loginOtpHash: {
    type: String,
    default: ""
  },
  loginOtpExpiresAt: {
    type: Date,
    default: null
  },
  loginOtpAttempts: {
    type: Number,
    default: 0
  },
  loginOtpChallengeId: {
    type: String,
    default: ""
  },
  loginOtpChannel: {
    type: String,
    enum: ["email", "sms", "none"],
    default: "none"
  },
  loginOtpDestination: {
    type: String,
    default: ""
  },
  accountRecoveryOtpHash: {
    type: String,
    default: ""
  },
  accountRecoveryOtpExpiresAt: {
    type: Date,
    default: null
  },
  accountRecoveryOtpAttempts: {
    type: Number,
    default: 0
  },
  accountRecoveryOtpChallengeId: {
    type: String,
    default: ""
  },
  accountRecoveryOtpChannel: {
    type: String,
    enum: ["email", "sms", "none"],
    default: "none"
  },
  accountRecoveryOtpDestination: {
    type: String,
    default: ""
  },
  accountRecoveryOtpPurpose: {
    type: String,
    enum: ["password_reset", "username_recovery", "none"],
    default: "none"
  },
  employment: {
    type: EmploymentSchema,
    default: () => ({})
  },
  attendance: {
    type: AttendanceSchema,
    default: () => ({})
  },
  performance: {
    type: PerformanceSchema,
    default: () => ({})
  },
  isActive: { type: Boolean, default: true },
  refreshTokenVersion: { type: Number, default: 0 }
}, { timestamps: true });

userSchema.index({ restaurantId: 1, role: 1, isActive: 1 });
userSchema.index({ emailVerificationExpiresAt: 1 });
userSchema.index({ loginOtpExpiresAt: 1 });
userSchema.index({ phone: 1, isActive: 1 });
userSchema.index({ accountRecoveryOtpExpiresAt: 1 });
userSchema.index({ createdAt: -1 });

userSchema.pre("save", function syncVerificationFlags(next) {
  if (this.isModified("emailVerified") && !this.isModified("isVerified")) {
    this.isVerified = Boolean(this.emailVerified);
  } else if (this.isModified("isVerified") && !this.isModified("emailVerified")) {
    this.emailVerified = Boolean(this.isVerified);
  }

  next();
});

module.exports = mongoose.model("User", userSchema);
