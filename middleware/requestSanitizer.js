const cleanObject = (value) => {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(cleanObject);
  }

  const clean = {};
  for (const [key, val] of Object.entries(value)) {
    // Block basic NoSQL operator style keys
    if (key.startsWith("$") || key.includes(".")) {
      continue;
    }

    clean[key] = cleanObject(val);
  }

  return clean;
};

const requestSanitizer = (req, _res, next) => {
  req.body = cleanObject(req.body);
  req.query = cleanObject(req.query);
  req.params = cleanObject(req.params);
  next();
};

module.exports = requestSanitizer;
