const DEFAULT_SERVER_ERROR_MESSAGE = "Internal server error";

const notFoundHandler = (req, res, _next) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

const resolveClientMessage = (status, err, fallbackMessage = DEFAULT_SERVER_ERROR_MESSAGE) => {
  if (status >= 500) {
    return fallbackMessage;
  }

  return err?.message || fallbackMessage;
};

const sendServerError = (
  res,
  err,
  {
    logLabel = "[server-error]",
    status = 500,
    fallbackMessage = DEFAULT_SERVER_ERROR_MESSAGE
  } = {}
) => {
  console.error(logLabel, err);

  return res.status(status).json({
    message: resolveClientMessage(status, err, fallbackMessage)
  });
};

const errorHandler = (err, _req, res, _next) => {
  let status = Number(err?.status || 500);

  if (!err?.status && err?.name === "MulterError") {
    status = 400;
  }

  return sendServerError(res, err, { status });
};

module.exports = {
  DEFAULT_SERVER_ERROR_MESSAGE,
  notFoundHandler,
  errorHandler,
  sendServerError
};
