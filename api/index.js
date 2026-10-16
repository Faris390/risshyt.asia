const app = require('../server');
app.get('/api/ping', (req, res) => res.json({ ok: true, url: req.url }));

module.exports = app;
