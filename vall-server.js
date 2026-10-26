/**
 * vall-server.js — Dedicated Vall Music Platform Server
 * 100% Isolated Music Engine & Web Application.
 * No dependencies on other projects or shared routes.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const vallBackend = require('./vallBackend');

const app = express();
// Dedicated Port (defaults to 3000 or ENV)
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Dedicated Root Routes: Serve Vall Music First
app.get(['/', '/music', '/vall', '/player'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vall-music.html'));
});

// Mount Dedicated Vall Music API
app.use('/api/music', vallBackend);

// Static Web Assets for Vall Music (disable index.html auto-serving)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Dedicated Health Check
app.get('/api/music/health', (req, res) => {
  res.json({
    status: 'online',
    app: 'Vall Music Platform',
    version: '1.0.0',
    mode: 'Dedicated Music Server',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Global Error / Abort guards
process.on('uncaughtException', (err) => {
  if (err.code === 'EOF' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED' || err.code === 'ECONNRESET') {
    return;
  }
  console.error('[Vall Music Server] Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Vall Music Server] Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`⚡ VALL MUSIC — Standalone Dedicated Sonic Platform`);
  console.log(`🎵 Web App URL : http://localhost:${PORT}/`);
  console.log(`📡 Music API   : http://localhost:${PORT}/api/music`);
  console.log(`====================================================`);
});
