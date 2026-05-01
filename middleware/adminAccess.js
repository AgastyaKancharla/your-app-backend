const jwt = require("jsonwebtoken");
const { getAuthCookiesFromRequest } = require("../utils/httpCookies");

const normalize = (value) => String(value || "").trim();

const getConfiguredAdminKey = () => normalize(process.env.SUPER_ADMIN_API_KEY);

const getHeaderToken = (req) => {
  const header = normalize(req.headers.authorization);
  if (!header || !header.startsWith("Bearer ")) {
    return "";
  }

  return normalize(header.slice(7));
};

const getRequestAccessToken = (req) => {
  const headerToken = getHeaderToken(req);
  if (headerToken) {
    return headerToken;
  }

  return normalize(getAuthCookiesFromRequest(req).accessToken);
};

const buildSyntheticAdminUser = () => ({
  userId: "super-admin",
  role: "SUPER_ADMIN",
  restaurantId: null
});

const requireAdminAccess = (req, res, next) => {
  const headerKey = normalize(req.headers["x-super-admin-key"]);
  const configuredKey = getConfiguredAdminKey();

  if (configuredKey && headerKey && configuredKey === headerKey) {
    req.user = req.user || buildSyntheticAdminUser();
    req.adminAuth = { method: "api_key" };
    return next();
  }

  const token = getRequestAccessToken(req);
  if (!token) {
    return res.status(401).json({ message: "Admin authentication required" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded?.type && decoded.type !== "access") {
      return res.status(401).json({ message: "Invalid token type" });
    }

    const role = normalize(decoded?.role).toUpperCase();
    if (role !== "SUPER_ADMIN") {
      return res.status(403).json({ message: "Super admin access required" });
    }

    req.user = decoded;
    req.adminAuth = { method: "token" };
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid admin token" });
  }
};

module.exports = requireAdminAccess;
