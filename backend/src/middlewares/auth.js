// Minimal Basic Auth for write routes only (POST/PUT/DELETE)
const env = require('../config/env');

function requireBasicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (user === env.BASIC_AUTH_USER && pass === env.BASIC_AUTH_PASS) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireBasicAuth };