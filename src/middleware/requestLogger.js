/**
 * Request logging middleware for Express.
 */
const logger = require('../config/logger');

function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const elapsed = Date.now() - start;
    const user = req.user?.username || 'anonymous';
    const msg = `${req.method} ${req.originalUrl} ${res.statusCode} ${elapsed}ms [${user}]`;

    if (res.statusCode >= 500) {
      logger.error(msg);
    } else if (res.statusCode >= 400) {
      logger.warn(msg);
    } else {
      logger.info(msg);
    }
  });

  next();
}

module.exports = requestLogger;
