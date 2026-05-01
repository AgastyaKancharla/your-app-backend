const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const isLoopbackHostname = (hostname) => {
  const normalized = String(hostname || "").trim().toLowerCase();
  return Boolean(normalized) && (LOOPBACK_HOSTNAMES.has(normalized) || normalized.endsWith(".localhost"));
};

const isDevelopmentLoopbackOrigin = (origin, { isProduction = false } = {}) => {
  if (isProduction) {
    return false;
  }

  const input = String(origin || "").trim();
  if (!input) {
    return false;
  }

  try {
    const parsed = new URL(input);
    return ["http:", "https:"].includes(parsed.protocol) && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
};

module.exports = {
  isLoopbackHostname,
  isDevelopmentLoopbackOrigin
};
