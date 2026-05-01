const { writeActivityLog } = require("../services/auditLogger");

const auditActivity = ({ action, module, getMetadata } = {}) => (req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 400 || !action || !module) {
      return;
    }

    const metadata =
      typeof getMetadata === "function"
        ? getMetadata(req, res) || {}
        : {
            method: req.method,
            path: req.originalUrl,
            params: req.params
          };

    writeActivityLog(req, { action, module, metadata }).catch((err) => {
      console.error("Unable to write activity log:", err?.message || err);
    });
  });

  return next();
};

module.exports = auditActivity;
