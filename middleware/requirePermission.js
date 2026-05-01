const { hasPermission } = require("../utils/permissionEngine");

const requirePermission = (permission) => (req, res, next) => {
  if (!hasPermission(req.user, permission)) {
    return res.status(403).json({
      message: "Forbidden: permission denied",
      permission
    });
  }

  return next();
};

module.exports = requirePermission;
