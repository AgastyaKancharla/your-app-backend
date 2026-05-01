const test = require("node:test");
const assert = require("node:assert/strict");

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

const resetEnv = () => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  });
  Object.assign(process.env, ORIGINAL_ENV);
};

const loadService = () => {
  const modulePath = require.resolve("../services/geocodingService");
  delete require.cache[modulePath];
  return require("../services/geocodingService");
};

test.afterEach(() => {
  resetEnv();
  global.fetch = ORIGINAL_FETCH;
});

test("geocodeAddress returns normalized payload and reuses cache", async () => {
  process.env.GEOCODING_DISABLED = "false";
  process.env.GEOCODING_NOMINATIM_BASE_URL = "https://geo-primary.example";
  process.env.GEOCODING_MAPSCO_BASE_URL = "https://geo-fallback.example";
  process.env.GEOCODING_USER_AGENT = "test-agent";

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return [
          {
            lat: "12.9716",
            lon: "77.5946",
            display_name: "Bengaluru, Karnataka, India",
            address: {
              city: "Bengaluru",
              state: "Karnataka",
              postcode: "560001",
              country: "India"
            }
          }
        ];
      }
    };
  };

  const { geocodeAddress } = loadService();
  const first = await geocodeAddress("MG Road Bengaluru");
  const second = await geocodeAddress("MG Road Bengaluru");

  assert.equal(first.city, "Bengaluru");
  assert.equal(first.state, "Karnataka");
  assert.equal(first.pinCode, "560001");
  assert.equal(first.latitude, 12.9716);
  assert.equal(first.longitude, 77.5946);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("reverseGeocode falls back when primary provider fails", async () => {
  process.env.GEOCODING_DISABLED = "false";
  process.env.GEOCODING_NOMINATIM_BASE_URL = "https://geo-primary.example";
  process.env.GEOCODING_MAPSCO_BASE_URL = "https://geo-fallback.example";
  process.env.GEOCODING_USER_AGENT = "test-agent";

  global.fetch = async (url) => {
    if (String(url).startsWith("https://geo-primary.example")) {
      throw new Error("Primary provider unavailable");
    }

    return {
      ok: true,
      async json() {
        return {
          lat: "12.9716",
          lon: "77.5946",
          display_name: "MG Road, Bengaluru, Karnataka, India",
          address: {
            city: "Bengaluru",
            state: "Karnataka",
            postcode: "560001",
            road: "MG Road"
          }
        };
      }
    };
  };

  const { reverseGeocode } = loadService();
  const result = await reverseGeocode({
    latitude: 12.9716,
    longitude: 77.5946
  });

  assert.equal(result.city, "Bengaluru");
  assert.equal(result.state, "Karnataka");
  assert.equal(result.pinCode, "560001");
  assert.equal(result.address.includes("MG Road"), true);
});
