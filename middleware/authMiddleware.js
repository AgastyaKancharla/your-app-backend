const jwt = require("jsonwebtoken");
const { getAuthCookiesFromRequest } = require("../utils/httpCookies");

module.exports = (req, res, next) => {
  const header = req.headers.authorization;
  const cookieToken = getAuthCookiesFromRequest(req).accessToken;

  if ((!header || !header.startsWith("Bearer ")) && !cookieToken) {
    return res.status(401).json({ message: "No token" });
  }

  const token = header?.startsWith("Bearer ") ? header.split(" ")[1] : cookieToken;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded?.type && decoded.type !== "access") {
      return res.status(401).json({ message: "Invalid access token type" });
    }

    req.user = {
      ...decoded,
      tenantId: decoded?.tenantId || decoded?.restaurantId || null,
      restaurantId: decoded?.restaurantId || decoded?.tenantId || null
    };
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};
