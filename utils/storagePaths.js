const fs = require("fs");
const path = require("path");

const getStorageRoot = () => {
  const configured = String(process.env.FILE_STORAGE_ROOT || "").trim();
  if (configured) {
    return path.resolve(__dirname, "..", configured);
  }

  return path.resolve(__dirname, "..", "storage");
};

const ensureStorageDir = (...segments) => {
  const dir = path.join(getStorageRoot(), ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

module.exports = {
  getStorageRoot,
  ensureStorageDir
};
