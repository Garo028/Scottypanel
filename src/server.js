const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const multer = require('multer');

const pm = require('./processManager');
const { extractZip, clearDeploy, ensureDirs, DEPLOY_DIR, UPLOAD_DIR } = require('./deployer');

ensureDirs();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── DEPLOY UPLOAD ────────────────────────────────────────────────────────────

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.zip')) cb(null, true);
    else cb(new Error('Only .zip files are allowed'));
  },
});

app.post('/api/deploy', upload.single('zip'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No ZIP file uploaded' });

  // Stop current bot if running
  if (pm.getState() === 'online') pm.stop();

  const logs = [];
  const onLog = (msg, type) => {
    const entry = { msg, type, time: Date.now() };
    logs.push(entry);
    io.emit('log', entry);
    io.emit('deploy_log', entry);
  };

  try {
    clearDeploy();
    onLog(`[DEPLOY] Received: ${req.file.originalname}`, 'system');
    extractZip(req.file.path, onLog);
    io.emit('deployment_ready', pm.getDeploymentInfo());
    res.json({ success: true, info: pm.getDeploymentInfo() });
  } catch (err) {
    onLog(`[DEPLOY] Failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// ─── FILE MANAGER API ─────────────────────────────────────────────────────────

app.get('/api/files', (req, res) => {
  const rel = (req.query.path || '/').replace(/\.\./g, '');
  const dir = path.join(DEPLOY_DIR, rel === '/' ? '' : rel);
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .map(e => {
        const fullPath = path.join(dir, e.name);
        const stat = fs.statSync(fullPath);
        return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: stat.size, modified: stat.mtime };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: rel, entries });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/files/content', (req, res) => {
  const rel = (req.query.path || '').replace(/\.\./g, '');
  try {
    const content = fs.readFileSync(path.join(DEPLOY_DIR, rel), 'utf8');
    res.json({ content });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/files/write', (req, res) => {
  const rel = (req.body.path || '').replace(/\.\./g, '');
  try {
    fs.writeFileSync(path.join(DEPLOY_DIR, rel), req.body.content || '');
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/files/mkdir', (req, res) => {
  const rel = (req.body.path || '').replace(/\.\./g, '');
  try {
    fs.mkdirSync(path.join(DEPLOY_DIR, rel), { recursive: true });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/files', (req, res) => {
  const rel = (req.query.path || '').replace(/\.\./g, '');
  try {
    fs.rmSync(path.join(DEPLOY_DIR, rel), { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const rel = (req.query.path || '/').replace(/\.\./g, '');
    const dir = path.join(DEPLOY_DIR, rel);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
app.post('/api/files/upload', multer({ storage: fileStorage }).array('files'), (req, res) => {
  res.json({ success: true, count: req.files.length });
});

// ─── STATS API ────────────────────────────────────────────────────────────────

let cpuUsage = 0;
let prev = getCpuInfo();
function getCpuInfo() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  cpus.forEach(c => { for (const t in c.times) total += c.times[t]; idle += c.times.idle; });
  return { idle, total };
}
setInterval(() => {
  const curr = getCpuInfo();
  const idleDiff = curr.idle - prev.idle;
  const totalDiff = curr.total - prev.total;
  cpuUsage = totalDiff === 0 ? 0 : (1 - idleDiff / totalDiff) * 100;
  prev = curr;
}, 2000);

app.get('/api/stats', (req, res) => {
  const total = os.totalmem(), free = os.freemem();
  const up = process.uptime();
  res.json({
    uptime: up,
    cpu: cpuUsage.toFixed(1),
    memory: {
      used: ((total - free) / 1024 / 1024).toFixed(0),
      total: (total / 1024 / 1024).toFixed(0),
    },
    address: req.hostname + ':' + PORT,
    botState: pm.getState(),
    hasDeployment: pm.hasDeployment(),
    deployInfo: pm.getDeploymentInfo(),
  });
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────

pm.setEmit((event, data) => io.emit(event, data));

io.on('connection', (socket) => {
  socket.emit('log_history', pm.getLogs());
  socket.emit('bot_state', pm.getState());
  socket.emit('deployment_status', {
    has: pm.hasDeployment(),
    info: pm.getDeploymentInfo(),
  });

  socket.on('start_bot', () => pm.start());
  socket.on('stop_bot', () => pm.stop());
  socket.on('restart_bot', () => pm.restart());
});

// ─── LISTEN ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Panel → http://localhost:${PORT}\n`);
  // Log startup info
  const info = pm.getDeploymentInfo();
  if (info) console.log(`📦 Deployment found: ${info.name} v${info.version}`);
  else console.log('📭 No deployment yet. Upload a bot ZIP to get started.');
});
