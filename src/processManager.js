const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEPLOY_DIR = path.join(__dirname, '../deployments/active');
const MAX_LOGS = 1000;

let proc = null;
let installProc = null;
let state = 'offline'; // offline | installing | online | stopping | crashed
let logs = [];
let emitFn = null;
let autoRestart = true;
let crashCount = 0;

function getState() { return state; }
function getLogs() { return logs; }
function setEmit(fn) { emitFn = fn; }

function emit(event, data) {
  if (emitFn) emitFn(event, data);
}

function addLog(msg, type = 'info') {
  const entry = { msg, type, time: Date.now() };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  emit('log', entry);
  return entry;
}

// Detect start command from package.json
function detectStartCommand() {
  const pkgPath = path.join(DEPLOY_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    // fallback: look for common entry files
    for (const f of ['index.js', 'app.js', 'main.js', 'bot.js', 'server.js']) {
      if (fs.existsSync(path.join(DEPLOY_DIR, f))) return { cmd: 'node', args: [f] };
    }
    return null;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  // prefer scripts.start
  if (pkg.scripts?.start) {
    const parts = pkg.scripts.start.trim().split(/\s+/);
    return { cmd: parts[0], args: parts.slice(1) };
  }
  // use main field
  if (pkg.main) return { cmd: 'node', args: [pkg.main] };
  // fallback index.js
  return { cmd: 'node', args: ['index.js'] };
}

function hasDeployment() {
  return fs.existsSync(DEPLOY_DIR) &&
    fs.readdirSync(DEPLOY_DIR).length > 0;
}

function getDeploymentInfo() {
  const pkgPath = path.join(DEPLOY_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { name: pkg.name || 'Unknown', version: pkg.version || '1.0.0', description: pkg.description || '' };
  } catch { return null; }
}

// Run npm install
async function install() {
  return new Promise((resolve, reject) => {
    state = 'installing';
    emit('bot_state', state);
    addLog('[SYSTEM] Running npm install...', 'system');

    installProc = spawn('npm', ['install', '--production'], {
      cwd: DEPLOY_DIR,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    installProc.stdout.on('data', d => {
      const lines = d.toString().trim().split('\n');
      lines.forEach(l => { if (l.trim()) addLog(l, 'muted'); });
    });
    installProc.stderr.on('data', d => {
      const lines = d.toString().trim().split('\n');
      lines.forEach(l => { if (l.trim() && !l.includes('WARN')) addLog(l, 'warn'); });
    });
    installProc.on('close', code => {
      if (code === 0) {
        addLog('[SYSTEM] npm install complete.', 'success');
        resolve();
      } else {
        addLog(`[SYSTEM] npm install failed (code ${code})`, 'error');
        state = 'offline';
        emit('bot_state', state);
        reject(new Error('npm install failed'));
      }
    });
  });
}

// Start the bot process
async function start(skipInstall = false) {
  if (state === 'online' || state === 'installing') {
    addLog('[SYSTEM] Already running.', 'warn');
    return;
  }
  if (!hasDeployment()) {
    addLog('[SYSTEM] No deployment found. Upload a bot ZIP first.', 'error');
    emit('bot_state', 'no_deployment');
    return;
  }

  if (!skipInstall) {
    try { await install(); } catch { return; }
  }

  const cmd = detectStartCommand();
  if (!cmd) {
    addLog('[SYSTEM] Could not detect start command. Add a "start" script to package.json.', 'error');
    state = 'offline';
    emit('bot_state', state);
    return;
  }

  addLog(`[SYSTEM] Starting: ${cmd.cmd} ${cmd.args.join(' ')}`, 'system');
  state = 'online';
  emit('bot_state', state);
  crashCount = 0;

  proc = spawn(cmd.cmd, cmd.args, {
    cwd: DEPLOY_DIR,
    shell: true,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NODE_ENV: process.env.NODE_ENV || 'production',
    },
  });

  proc.stdout.on('data', (d) => {
    d.toString().trim().split('\n').forEach(l => { if (l) addLog(l, 'output'); });
  });
  proc.stderr.on('data', (d) => {
    d.toString().trim().split('\n').forEach(l => { if (l) addLog(l, 'stderr'); });
  });

  proc.on('close', (code) => {
    addLog(`[SYSTEM] Process exited with code ${code}`, code === 0 ? 'system' : 'error');
    proc = null;

    if (state !== 'stopping' && autoRestart && code !== 0) {
      crashCount++;
      const delay = Math.min(5000 * crashCount, 30000);
      addLog(`[SYSTEM] Crash detected. Restarting in ${delay / 1000}s... (attempt ${crashCount})`, 'warn');
      state = 'starting';
      emit('bot_state', state);
      setTimeout(() => start(true), delay);
    } else {
      state = 'offline';
      emit('bot_state', state);
    }
  });

  proc.on('error', (err) => {
    addLog(`[SYSTEM] Spawn error: ${err.message}`, 'error');
    state = 'offline';
    emit('bot_state', state);
  });
}

function stop() {
  autoRestart = false;
  state = 'stopping';
  emit('bot_state', state);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      try { if (proc) proc.kill('SIGKILL'); } catch (_) {}
    }, 3000);
  }
  if (installProc) { try { installProc.kill(); } catch (_) {} }
  addLog('[SYSTEM] Bot stopped.', 'system');
  setTimeout(() => {
    state = 'offline';
    emit('bot_state', state);
  }, 500);
}

async function restart() {
  addLog('[SYSTEM] Restarting...', 'system');
  autoRestart = false;
  stop();
  setTimeout(() => {
    autoRestart = true;
    start(true);
  }, 2000);
}

function setAutoRestart(val) { autoRestart = val; }

module.exports = {
  start, stop, restart,
  getState, getLogs, setEmit,
  hasDeployment, getDeploymentInfo,
  DEPLOY_DIR,
};
