const test = require("node:test");
const assert = require("node:assert/strict");

const { parseLatitude, parseLongitude } = require("../utils/geoCoordinates");

test("parseLatitude accepts valid latitude range", () => {
  const result = parseLatitude("12.9716");
  assert.equal(result.supplied, true);
  assert.equal(result.valid, true);
  assert.equal(result.value, 12.9716);
});

test("parseLatitude rejects out of range latitude", () => {
  const result = parseLatitude("120.5");
  assert.equal(result.supplied, true);
  assert.equal(result.valid, false);
  assert.equal(result.value, null);
});

test("parseLongitude accepts valid longitude range", () => {
  const result = parseLongitude("77.5946");
  assert.equal(result.supplied, true);
  assert.equal(result.valid, true);
  assert.equal(result.value, 77.5946);
});

test("parseLongitude rejects non-numeric values", () => {
  const result = parseLongitude("abc");
  assert.equal(result.supplied, true);
  assert.equal(result.valid, false);
  assert.equal(result.value, null);
});

test("parseLatitude and parseLongitude allow empty values as null", () => {
  const latitude = parseLatitude("");
  const longitude = parseLongitude(undefined);
  assert.equal(latitude.valid, true);
  assert.equal(latitude.value, null);
  assert.equal(longitude.valid, true);
  assert.equal(longitude.value, null);
});
