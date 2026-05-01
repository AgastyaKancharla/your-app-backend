const parseCoordinate = (rawValue, { min, max }) => {
  const value = rawValue;
  const isMissing = value === undefined || value === null || value === "";
  if (isMissing) {
    return {
      supplied: false,
      valid: true,
      value: null
    };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return {
      supplied: true,
      valid: false,
      value: null
    };
  }

  if (parsed < min || parsed > max) {
    return {
      supplied: true,
      valid: false,
      value: null
    };
  }

  return {
    supplied: true,
    valid: true,
    value: parsed
  };
};

const parseLatitude = (value) => parseCoordinate(value, { min: -90, max: 90 });
const parseLongitude = (value) => parseCoordinate(value, { min: -180, max: 180 });

module.exports = {
  parseLatitude,
  parseLongitude
};
