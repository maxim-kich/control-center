'use strict';

exports.register = function register({ express, extension }) {
  const router = express.Router();
  router.get('/status', (req, res) => {
    res.json({
      ok: true,
      extension: extension.id,
      name: extension.name,
      version: extension.version,
    });
  });
  return router;
};
