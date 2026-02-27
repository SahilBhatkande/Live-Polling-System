const logger = require('../utils/logger');

const corsOptions = {
  origin: function (origin, callback) {
    // Allow any origin (any host/port), including requests with no origin.
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

// CORS error handler
const corsErrorHandler = (err, req, res, next) => {
  if (err.message.includes('CORS policy')) {
    logger.warn(`CORS error for ${req.method} ${req.path} from origin: ${req.get('Origin')}`);
    return res.status(403).json({
      success: false,
      error: {
        message: 'Cross-origin request blocked by CORS policy',
        code: 'CORS_ERROR',
        origin: req.get('Origin'),
      },
    });
  }
  next(err);
};

module.exports = {
  corsOptions,
  corsErrorHandler,
};
