const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};

const isProduction = () => String(process.env.NODE_ENV || "").toLowerCase() === "production";

const normalizeSameSite = (value, fallback = "lax") => {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return normalizeSameSite(fallback);
  }

  if (normalized === "strict") {
    return "strict";
  }

  if (normalized === "none") {
    return "none";
  }

  return "lax";
};

const parseDurationToMs = (value, fallbackMs = 0) => {
  const input = String(value || "").trim();
  if (!input) {
    return fallbackMs;
  }

  const match = input.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    return fallbackMs;
  }

  const amount = Number(match[1]);
  const unit = String(match[2] || "").toLowerCase();

  if (!Number.isFinite(amount) || amount <= 0) {
    return fallbackMs;
  }

  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  return amount * (multipliers[unit] || 1);
};

const getCookieSettings = () => {
  const secure = parseBoolean(process.env.AUTH_COOKIE_SECURE, true);
  const sameSite = normalizeSameSite(
    process.env.AUTH_COOKIE_SAME_SITE,
    "none"
  );

  return {
    accessCookieName: String(process.env.AUTH_ACCESS_COOKIE_NAME || "token").trim(),
    refreshCookieName: String(process.env.AUTH_REFRESH_COOKIE_NAME || "wevalue_refresh").trim(),
    domain: String(process.env.AUTH_COOKIE_DOMAIN || "").trim(),
    path: String(process.env.AUTH_COOKIE_PATH || "/").trim() || "/",
    secure,
    sameSite,
    accessMaxAgeMs: parseDurationToMs(process.env.ACCESS_TOKEN_EXPIRY || "1h", 60 * 60 * 1000),
    refreshMaxAgeMs: parseDurationToMs(
      process.env.REFRESH_TOKEN_EXPIRY || "7d",
      7 * 24 * 60 * 60 * 1000
    )
  };
};

const parseRequestCookies = (req) => {
  const raw = String(req?.headers?.cookie || "");
  if (!raw.trim()) {
    return {};
  }

  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const separatorIndex = item.indexOf("=");
      if (separatorIndex <= 0) {
        return acc;
      }

      const key = decodeURIComponent(item.slice(0, separatorIndex).trim());
      const value = decodeURIComponent(item.slice(separatorIndex + 1).trim());
      if (key) {
        acc[key] = value;
      }
      return acc;
    }, {});
};

const getAuthCookiesFromRequest = (req) => {
  const cookies = parseRequestCookies(req);
  const settings = getCookieSettings();

  return {
    accessToken: String(cookies[settings.accessCookieName] || "").trim(),
    refreshToken: String(cookies[settings.refreshCookieName] || "").trim()
  };
};

const buildCookieOptions = (maxAge) => {
  const settings = getCookieSettings();
  const options = {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    path: settings.path,
    maxAge
  };

  if (settings.domain) {
    options.domain = settings.domain;
  }

  return options;
};

const setAuthCookies = (res, { accessToken, refreshToken }) => {
  const settings = getCookieSettings();

  if (accessToken) {
    res.cookie(
      settings.accessCookieName,
      accessToken,
      buildCookieOptions(settings.accessMaxAgeMs)
    );
  }

  if (refreshToken) {
    res.cookie(
      settings.refreshCookieName,
      refreshToken,
      buildCookieOptions(settings.refreshMaxAgeMs)
    );
  }
};

const clearAuthCookies = (res) => {
  const settings = getCookieSettings();
  const clearOptions = buildCookieOptions(0);

  res.clearCookie(settings.accessCookieName, clearOptions);
  res.clearCookie(settings.refreshCookieName, clearOptions);
};

module.exports = {
  parseBoolean,
  parseDurationToMs,
  getCookieSettings,
  parseRequestCookies,
  getAuthCookiesFromRequest,
  setAuthCookies,
  clearAuthCookies
};
