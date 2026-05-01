const mongoose = require("mongoose");
const AuthRateLimit = require("../models/AuthRateLimit");

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 60;

const getClientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
  req.socket?.remoteAddress ||
  "unknown-ip";

const isDbConnected = () => mongoose.connection.readyState === 1;

const createApiRateLimit = ({
  keyPrefix = "api",
  windowMs = DEFAULT_WINDOW_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  message = "Too many requests. Please retry later."
} = {}) => {
  const attemptsByKey = new Map();

  const cleanupExpired = (now) => {
    for (const [key, value] of attemptsByKey.entries()) {
      if (!value || now > value.resetAt) {
        attemptsByKey.delete(key);
      }
    }
  };

  const incrementMemoryCounter = (key) => {
    const now = Date.now();
    cleanupExpired(now);

    const existing = attemptsByKey.get(key);
    if (!existing || now > existing.resetAt) {
      const nextState = {
        count: 1,
        resetAt: now + windowMs
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
    const resetAt = new Date(now.getTime() + windowMs);
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

  return async (req, res, next) => {
    const routeKey = `${req.baseUrl || ""}${req.route?.path || req.path || ""}`;
    const key = `${keyPrefix}:${routeKey}:${getClientIp(req)}`;

    try {
      const state = isDbConnected()
        ? await incrementDbCounter(key)
        : incrementMemoryCounter(key);

      if (state.count > maxAttempts) {
        const retryAfterSec = Math.ceil((state.resetAt - Date.now()) / 1000);
        res.set("Retry-After", String(Math.max(1, retryAfterSec)));
        return res.status(429).json({ message });
      }

      return next();
    } catch (error) {
      console.error("[api-rate-limit] fallback to memory counter", error);
      const state = incrementMemoryCounter(key);

      if (state.count > maxAttempts) {
        const retryAfterSec = Math.ceil((state.resetAt - Date.now()) / 1000);
        res.set("Retry-After", String(Math.max(1, retryAfterSec)));
        return res.status(429).json({ message });
      }

      return next();
    }
  };
};

module.exports = createApiRateLimit;
