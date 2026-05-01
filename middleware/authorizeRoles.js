const { normalizeRole } = require("../utils/accessControl");

const authorizeRoles = (allowedRoles = []) => {
  const allowed = new Set(allowedRoles.map(normalizeRole));

  return (req, res, next) => {
    const role = normalizeRole(req.user?.role);

    if (!role || !allowed.has(role)) {
      return res.status(403).json({ message: "Forbidden: role access denied" });
    }

    return next();
  };
};

module.exports = authorizeRoles;
