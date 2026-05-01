const mongoose = require("mongoose");
const { MEMBERSHIP_ROLES } = require("../utils/membershipRoles");

const membershipSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true
    },
    role: {
      type: String,
      enum: Object.values(MEMBERSHIP_ROLES),
      default: MEMBERSHIP_ROLES.STAFF
    }
  },
  { timestamps: true }
);

membershipSchema.index({ userId: 1, tenantId: 1 }, { unique: true });
membershipSchema.index({ tenantId: 1, role: 1 });

module.exports = mongoose.model("Membership", membershipSchema);
