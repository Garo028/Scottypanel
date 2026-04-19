const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const DEPLOY_DIR = path.join(__dirname, '../deployments/active');
const UPLOAD_DIR = path.join(__dirname, '../deployments/uploads');

function ensureDirs() {
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Clear the active deployment folder
function clearDeploy() {
  if (fs.existsSync(DEPLOY_DIR)) {
    fs.rmSync(DEPLOY_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
}

// Extract ZIP to deploy dir
// Handles both: zip with top-level folder AND zip with files at root
function extractZip(zipPath, onLog) {
  onLog('[DEPLOY] Extracting ZIP...', 'system');

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (!entries.length) throw new Error('ZIP is empty');

  // Detect if all files share a common top-level directory
  const topDirs = new Set(
    entries
      .map(e => e.entryName.split('/')[0])
      .filter(Boolean)
  );

  let stripPrefix = '';
  if (topDirs.size === 1) {
    const top = [...topDirs][0];
    // Check it's actually a folder (not a single file)
    const isFolder = entries.some(e => e.entryName.startsWith(top + '/') && e.entryName.length > top.length + 1);
    if (isFolder) {
      stripPrefix = top + '/';
      onLog(`[DEPLOY] Detected top-level folder: ${top}/`, 'muted');
    }
  }

  let extracted = 0;
  entries.forEach(entry => {
    if (entry.isDirectory) return;

    let relPath = entry.entryName;
    if (stripPrefix && relPath.startsWith(stripPrefix)) {
      relPath = relPath.slice(stripPrefix.length);
    }
    if (!relPath) return;

    const outPath = path.join(DEPLOY_DIR, relPath);
    const outDir = path.dirname(outPath);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, entry.getData());
    extracted++;
  });

  onLog(`[DEPLOY] Extracted ${extracted} files.`, 'success');

  // Verify package.json exists
  const pkgPath = path.join(DEPLOY_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    onLog('[DEPLOY] ⚠ No package.json found. Make sure your ZIP contains a valid Node.js project.', 'warn');
  } else {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    onLog(`[DEPLOY] Project: ${pkg.name || 'unnamed'} v${pkg.version || '?'}`, 'success');
    if (pkg.scripts?.start) {
      onLog(`[DEPLOY] Start command: ${pkg.scripts.start}`, 'muted');
    }
  }

  // Clean up uploaded zip
  try { fs.unlinkSync(zipPath); } catch (_) {}

  return true;
}

module.exports = { extractZip, clearDeploy, ensureDirs, DEPLOY_DIR, UPLOAD_DIR };
