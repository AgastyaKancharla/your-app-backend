const DEFAULT_USER_AGENT = "wevalue-crm-geocoder/1.0";
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

const forwardCache = new Map();
const reverseCache = new Map();

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const setCache = (cache, key, value) => {
  if (!key) {
    return;
  }

  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) {
      cache.delete(firstKey);
    }
  }

  cache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value
  });
};

const getCache = (cache, key) => {
  const cached = cache.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() > cached.expiresAt) {
    cache.delete(key);
    return null;
  }

  return cached.value;
};

const normalizeForwardResult = (entry = {}) => {
  const latitude = toNumber(entry?.lat || entry?.latitude);
  const longitude = toNumber(entry?.lon || entry?.longitude);

  if (latitude === null || longitude === null) {
    return null;
  }

  const address = entry?.address || {};
  const city = address?.city || address?.town || address?.village || entry?.city || "";
  const state = address?.state || entry?.state || "";
  const pinCode = address?.postcode || entry?.postcode || "";
  const country = address?.country || entry?.country || "";

  return {
    latitude,
    longitude,
    displayName: String(entry?.display_name || entry?.label || "").trim(),
    city: String(city || "").trim(),
    state: String(state || "").trim(),
    pinCode: String(pinCode || "").trim(),
    country: String(country || "").trim()
  };
};

const normalizeReverseResult = (entry = {}) => {
  const normalized = normalizeForwardResult(entry);
  if (!normalized) {
    return null;
  }

  const address = entry?.address || {};
  const road = String(address?.road || "").trim();
  const suburb = String(address?.suburb || "").trim();
  const locality = [road, suburb].filter(Boolean).join(", ");

  return {
    ...normalized,
    address: String(entry?.display_name || locality || "").trim()
  };
};

const safeFetchJson = async (url, { timeoutMs = 5000, headers = {} } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Provider request failed (${response.status})`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const getNominatimBase = () =>
  String(process.env.GEOCODING_NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org").trim();
const getMapsCoBase = () =>
  String(process.env.GEOCODING_MAPSCO_BASE_URL || "https://geocode.maps.co").trim();
const getMapsCoApiKey = () => String(process.env.GEOCODING_MAPSCO_API_KEY || "").trim();
const getUserAgent = () => String(process.env.GEOCODING_USER_AGENT || DEFAULT_USER_AGENT).trim();
const isGeocodingDisabled = () => String(process.env.GEOCODING_DISABLED || "").toLowerCase() === "true";

const geocodeWithNominatim = async (query) => {
  const base = getNominatimBase().replace(/\/$/, "");
  const url = `${base}/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(query)}`;
  const payload = await safeFetchJson(url, {
    headers: {
      "User-Agent": getUserAgent()
    }
  });

  if (!Array.isArray(payload) || !payload.length) {
    return null;
  }

  return normalizeForwardResult(payload[0]);
};

const reverseWithNominatim = async ({ latitude, longitude }) => {
  const base = getNominatimBase().replace(/\/$/, "");
  const url = `${base}/reverse?format=jsonv2&addressdetails=1&lat=${latitude}&lon=${longitude}`;
  const payload = await safeFetchJson(url, {
    headers: {
      "User-Agent": getUserAgent()
    }
  });

  return normalizeReverseResult(payload);
};

const geocodeWithMapsCo = async (query) => {
  const base = getMapsCoBase().replace(/\/$/, "");
  const apiKey = getMapsCoApiKey();
  const url = `${base}/search?q=${encodeURIComponent(query)}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ""}`;
  const payload = await safeFetchJson(url, {
    headers: {
      "User-Agent": getUserAgent()
    }
  });

  if (!Array.isArray(payload) || !payload.length) {
    return null;
  }

  return normalizeForwardResult(payload[0]);
};

const reverseWithMapsCo = async ({ latitude, longitude }) => {
  const base = getMapsCoBase().replace(/\/$/, "");
  const apiKey = getMapsCoApiKey();
  const url = `${base}/reverse?lat=${latitude}&lon=${longitude}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ""}`;
  const payload = await safeFetchJson(url, {
    headers: {
      "User-Agent": getUserAgent()
    }
  });

  return normalizeReverseResult(payload);
};

const geocodeAddress = async (query = "") => {
  if (isGeocodingDisabled()) {
    throw new Error("Geocoding is disabled");
  }

  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return null;
  }

  const cacheKey = trimmed.toLowerCase();
  const cached = getCache(forwardCache, cacheKey);
  if (cached) {
    return cached;
  }

  let result = null;
  let lastError = null;

  try {
    result = await geocodeWithNominatim(trimmed);
  } catch (error) {
    lastError = error;
  }

  if (!result) {
    try {
      result = await geocodeWithMapsCo(trimmed);
    } catch (error) {
      lastError = error;
    }
  }

  if (!result && lastError) {
    throw lastError;
  }

  if (result) {
    setCache(forwardCache, cacheKey, result);
  }

  return result;
};

const reverseGeocode = async ({ latitude, longitude }) => {
  if (isGeocodingDisabled()) {
    throw new Error("Geocoding is disabled");
  }

  const lat = toNumber(latitude);
  const lng = toNumber(longitude);
  if (lat === null || lng === null) {
    return null;
  }

  const cacheKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const cached = getCache(reverseCache, cacheKey);
  if (cached) {
    return cached;
  }

  let result = null;
  let lastError = null;

  try {
    result = await reverseWithNominatim({ latitude: lat, longitude: lng });
  } catch (error) {
    lastError = error;
  }

  if (!result) {
    try {
      result = await reverseWithMapsCo({ latitude: lat, longitude: lng });
    } catch (error) {
      lastError = error;
    }
  }

  if (!result && lastError) {
    throw lastError;
  }

  if (result) {
    setCache(reverseCache, cacheKey, result);
  }

  return result;
};

module.exports = {
  geocodeAddress,
  reverseGeocode
};
