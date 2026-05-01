const mongoose = require("mongoose");

const AuthRateLimit = require("../models/AuthRateLimit");

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 20;
const attemptsByKey = new Map();
let hasLoggedDatabaseCaseWarning = false;

const getClientIp = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown-ip"
  );
};

const getClientKey = (req) => {
  const ip = getClientIp(req);
  const routeKey = `${req.baseUrl || ""}${req.route?.path || req.path || ""}` || "auth";
  return `${routeKey}:${ip}`;
};

const cleanupOld = (now) => {
  for (const [key, value] of attemptsByKey.entries()) {
    if (!value || now > value.resetAt) {
      attemptsByKey.delete(key);
    }
  }
};

const applyRateLimit = (res, resetAt) => {
  const retryAfterSec = Math.ceil((resetAt - Date.now()) / 1000);
  res.set("Retry-After", String(Math.max(1, retryAfterSec)));
  return res
    .status(429)
    .json({ message: "Too many login attempts. Please retry later." });
};

const isDbConnected = () => mongoose.connection.readyState === 1;

const incrementMemoryCounter = (key) => {
  const now = Date.now();
  cleanupOld(now);

  const existing = attemptsByKey.get(key);
  if (!existing || now > existing.resetAt) {
    const nextState = {
      count: 1,
      resetAt: now + WINDOW_MS
    };

    attemptsByKey.set(key, nextState);
    return nextState;
  }

  existing.count += 1;
  attemptsByKey.set(key, existing);
  return existing;
};

const incrementDbCounter = async (key) => {
  const now = new Date();
  const resetAt = new Date(now.getTime() + WINDOW_MS);
  const existing = await AuthRateLimit.findOne({ key });

  if (!existing || new Date(existing.windowExpiresAt).getTime() <= now.getTime()) {
    const nextState = await AuthRateLimit.findOneAndUpdate(
      { key },
      {
        key,
        count: 1,
        windowExpiresAt: resetAt
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    ).lean();

    return {
      count: Number(nextState?.count || 1),
      resetAt: new Date(nextState?.windowExpiresAt || resetAt).getTime()
    };
  }

  existing.count = Number(existing.count || 0) + 1;
  await existing.save();

  return {
    count: Number(existing.count || 0),
    resetAt: new Date(existing.windowExpiresAt).getTime()
  };
};

const loginRateLimit = async (req, res, next) => {
  const key = getClientKey(req);

  try {
    const state = isDbConnected()
      ? await incrementDbCounter(key)
      : incrementMemoryCounter(key);

    if (state.count > MAX_ATTEMPTS) {
      return applyRateLimit(res, state.resetAt);
    }

    return next();
  } catch (error) {
    const normalizedMessage = String(error?.message || "").toLowerCase();
    const databaseCaseMismatch =
      error?.codeName === "DatabaseDifferCase" ||
      normalizedMessage.includes("db already exists with different case");

    if (databaseCaseMismatch) {
      if (!hasLoggedDatabaseCaseWarning) {
        hasLoggedDatabaseCaseWarning = true;
        console.error(
          "[login-rate-limit] MongoDB database name case mismatch in MONGO_URI. " +
            "Use the exact existing Atlas database case (for example restaurantCRM, not restaurantcrm). " +
            "Temporarily using in-memory rate limiter."
        );
      }
    } else {
      console.error("[login-rate-limit] falling back to memory store", error);
    }

    const state = incrementMemoryCounter(key);
    if (state.count > MAX_ATTEMPTS) {
      return applyRateLimit(res, state.resetAt);
    }

    return next();
  }
};

module.exports = loginRateLimit;
