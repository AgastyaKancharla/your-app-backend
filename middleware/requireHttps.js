const requireHttps = (req, res, next) => {
  if (process.env.NODE_ENV !== "production") {
    return next();
  }

  const isSecure =
    req.secure ||
    String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";

  if (!isSecure) {
    return res.status(403).json({ message: "HTTPS is required in production" });
  }

  return next();
};

module.exports = requireHttps;
