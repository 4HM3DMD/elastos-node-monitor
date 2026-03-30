require('dotenv').config();
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const express = require('express');

const PORT = parseInt(process.env.PORT || '9999', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const ELASTOS_NODE_DIR = process.env.ELASTOS_NODE_DIR || '';
const DATA_DIR = path.join(__dirname, 'data');
const COLLECT_INTERVAL_MS = 30_000;
const RETENTION_DAYS = 30;
const IS_LINUX = os.platform() === 'linux';

// ---------------------------------------------------------------------------
// Auto-detect server specs (overridable via .env)
// ---------------------------------------------------------------------------

function detectSpecs() {
  const cpuCores = parseInt(process.env.CPU_CORES, 10) || os.cpus().length;
  const ramGB = parseFloat(process.env.RAM_GB) || Math.round(os.totalmem() / (1024 ** 3) * 10) / 10;

  let diskGB = parseFloat(process.env.DISK_GB) || 0;
  let diskMount = process.env.DISK_MOUNT || '/';
  if (!diskGB) {
    try {
      const dfOut = execSync(`df -BG --output=size "${diskMount}" 2>/dev/null || df -g "${diskMount}" 2>/dev/null`, { encoding: 'utf8' });
      const match = dfOut.match(/(\d+)G?\s*$/m);
      if (match) diskGB = parseInt(match[1], 10);
    } catch { diskGB = 0; }
  }

  return { cpuCores, ramGB, diskGB, diskMount };
}

const SPECS = detectSpecs();
console.log(`[specs] Detected: ${SPECS.cpuCores} cores, ${SPECS.ramGB} GB RAM, ${SPECS.diskGB} GB Disk (mount: ${SPECS.diskMount})`);

// ---------------------------------------------------------------------------
// CPU usage from /proc/stat (Linux) or os module (fallback)
// ---------------------------------------------------------------------------

let prevCpuTimes = null;

function readProcStat() {
  try {
    const content = fs.readFileSync('/proc/stat', 'utf8');
    const lines = content.split('\n');
    const aggregate = lines[0]; // "cpu  user nice system idle ..."
    const parts = aggregate.trim().split(/\s+/).slice(1).map(Number);
    // parts: user, nice, system, idle, iowait, irq, softirq, steal
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);

    const perCore = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].startsWith('cpu')) break;
      const cp = lines[i].trim().split(/\s+/).slice(1).map(Number);
      const cIdle = cp[3] + (cp[4] || 0);
      const cTotal = cp.reduce((a, b) => a + b, 0);
      perCore.push({ idle: cIdle, total: cTotal });
    }
    return { idle, total, perCore };
  } catch {
    return null;
  }
}

function getCpuUsage() {
  if (!IS_LINUX) {
    const load = os.loadavg()[0];
    const pct = Math.min(100, (load / SPECS.cpuCores) * 100);
    return { percent: Math.round(pct * 10) / 10, perCore: [], loadAvg: os.loadavg() };
  }

  const curr = readProcStat();
  if (!curr || !prevCpuTimes) {
    prevCpuTimes = curr;
    const load = os.loadavg()[0];
    return { percent: Math.min(100, Math.round((load / SPECS.cpuCores) * 100 * 10) / 10), perCore: [], loadAvg: os.loadavg() };
  }

  const dIdle = curr.idle - prevCpuTimes.idle;
  const dTotal = curr.total - prevCpuTimes.total;
  const percent = dTotal === 0 ? 0 : Math.round((1 - dIdle / dTotal) * 100 * 10) / 10;

  const perCore = [];
  for (let i = 0; i < curr.perCore.length && i < prevCpuTimes.perCore.length; i++) {
    const di = curr.perCore[i].idle - prevCpuTimes.perCore[i].idle;
    const dt = curr.perCore[i].total - prevCpuTimes.perCore[i].total;
    perCore.push(dt === 0 ? 0 : Math.round((1 - di / dt) * 100 * 10) / 10);
  }

  prevCpuTimes = curr;
  return { percent, perCore, loadAvg: os.loadavg() };
}

// ---------------------------------------------------------------------------
// Memory from /proc/meminfo (Linux) or os module (fallback)
// ---------------------------------------------------------------------------

function getMemory() {
  if (!IS_LINUX) {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
      totalGB: Math.round(total / (1024 ** 3) * 100) / 100,
      usedGB: Math.round(used / (1024 ** 3) * 100) / 100,
      freeGB: Math.round(free / (1024 ** 3) * 100) / 100,
      percent: Math.round(used / total * 100 * 10) / 10,
      buffersGB: 0,
      cachedGB: 0,
      swapTotalGB: 0,
      swapUsedGB: 0,
    };
  }

  try {
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = content.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? parseInt(m[1], 10) : 0; // in kB
    };
    const totalKB = get('MemTotal');
    const freeKB = get('MemFree');
    const buffersKB = get('Buffers');
    const cachedKB = get('Cached');
    const sReclaimableKB = get('SReclaimable');
    const swapTotalKB = get('SwapTotal');
    const swapFreeKB = get('SwapFree');

    const actualUsedKB = totalKB - freeKB - buffersKB - cachedKB - sReclaimableKB;
    const toGB = (kb) => Math.round(kb / (1024 ** 2) * 100) / 100;

    return {
      totalGB: toGB(totalKB),
      usedGB: toGB(Math.max(0, actualUsedKB)),
      freeGB: toGB(freeKB),
      percent: Math.round(Math.max(0, actualUsedKB) / totalKB * 100 * 10) / 10,
      buffersGB: toGB(buffersKB),
      cachedGB: toGB(cachedKB + sReclaimableKB),
      swapTotalGB: toGB(swapTotalKB),
      swapUsedGB: toGB(swapTotalKB - swapFreeKB),
    };
  } catch {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      totalGB: Math.round(total / (1024 ** 3) * 100) / 100,
      usedGB: Math.round((total - free) / (1024 ** 3) * 100) / 100,
      freeGB: Math.round(free / (1024 ** 3) * 100) / 100,
      percent: Math.round((total - free) / total * 100 * 10) / 10,
      buffersGB: 0, cachedGB: 0, swapTotalGB: 0, swapUsedGB: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Disk usage via df
// ---------------------------------------------------------------------------

function getDisk() {
  try {
    const raw = execSync(`df -B1 "${SPECS.diskMount}" 2>/dev/null || df "${SPECS.diskMount}" 2>/dev/null`, { encoding: 'utf8' });
    const lines = raw.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[lines.length - 1].trim().split(/\s+/);
    // parts: filesystem, 1B-blocks (or 512-blocks), used, available, use%, mountpoint
    let totalBytes, usedBytes, availBytes;
    if (parts[1] && parseInt(parts[1], 10) > 1e9) {
      totalBytes = parseInt(parts[1], 10);
      usedBytes = parseInt(parts[2], 10);
      availBytes = parseInt(parts[3], 10);
    } else {
      totalBytes = parseInt(parts[1], 10) * 512;
      usedBytes = parseInt(parts[2], 10) * 512;
      availBytes = parseInt(parts[3], 10) * 512;
    }
    const toGB = (b) => Math.round(b / (1024 ** 3) * 100) / 100;
    return {
      totalGB: toGB(totalBytes),
      usedGB: toGB(usedBytes),
      availGB: toGB(availBytes),
      percent: Math.round(usedBytes / totalBytes * 100 * 10) / 10,
    };
  } catch {
    return { totalGB: SPECS.diskGB, usedGB: 0, availGB: SPECS.diskGB, percent: 0 };
  }
}

// ---------------------------------------------------------------------------
// Network from /proc/net/dev (Linux)
// ---------------------------------------------------------------------------

let prevNetStats = null;
let prevNetTime = null;

function readNetDev() {
  try {
    const content = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = content.split('\n').slice(2);
    let rxBytes = 0, txBytes = 0;
    for (const line of lines) {
      const parts = line.trim().split(/[:\s]+/);
      if (parts.length < 10) continue;
      const iface = parts[0];
      if (iface === 'lo') continue;
      rxBytes += parseInt(parts[1], 10);
      txBytes += parseInt(parts[9], 10);
    }
    return { rxBytes, txBytes };
  } catch {
    return null;
  }
}

function getNetwork() {
  if (!IS_LINUX) return { rxMBps: 0, txMBps: 0, rxTotalGB: 0, txTotalGB: 0 };

  const curr = readNetDev();
  const now = Date.now();
  if (!curr) return { rxMBps: 0, txMBps: 0, rxTotalGB: 0, txTotalGB: 0 };

  const toGB = (b) => Math.round(b / (1024 ** 3) * 100) / 100;
  const result = { rxMBps: 0, txMBps: 0, rxTotalGB: toGB(curr.rxBytes), txTotalGB: toGB(curr.txBytes) };

  if (prevNetStats && prevNetTime) {
    const dt = (now - prevNetTime) / 1000;
    if (dt > 0) {
      result.rxMBps = Math.round((curr.rxBytes - prevNetStats.rxBytes) / dt / (1024 ** 2) * 100) / 100;
      result.txMBps = Math.round((curr.txBytes - prevNetStats.txBytes) / dt / (1024 ** 2) * 100) / 100;
    }
  }

  prevNetStats = curr;
  prevNetTime = now;
  return result;
}

// ---------------------------------------------------------------------------
// Elastos process discovery
// ---------------------------------------------------------------------------

const CHAIN_DEFS = [
  { id: 'ela',        name: 'ELA Mainchain',     bins: ['ela'],        pgrep: 'ela' },
  { id: 'did',        name: 'DID Sidechain',     bins: ['did'],        pgrep: 'did' },
  { id: 'esc',        name: 'ESC Sidechain',     bins: ['esc'],        pgrep: '\\./esc .*--rpc' },
  { id: 'esc-oracle', name: 'ESC Oracle',         bins: [],             pgrep: 'crosschain_esc' },
  { id: 'eid',        name: 'EID Sidechain',     bins: ['eid'],        pgrep: '\\./eid .*--rpc' },
  { id: 'eid-oracle', name: 'EID Oracle',         bins: [],             pgrep: 'crosschain_eid' },
  { id: 'eco',        name: 'ECO Sidechain',     bins: ['eco'],        pgrep: '\\./eco .*--rpc' },
  { id: 'eco-oracle', name: 'ECO Oracle',         bins: [],             pgrep: 'crosschain_eco' },
  { id: 'pg',         name: 'PG Sidechain',      bins: ['pg'],         pgrep: '\\./pg .*--rpc' },
  { id: 'pg-oracle',  name: 'PG Oracle',          bins: [],             pgrep: 'crosschain_pg' },
  { id: 'arbiter',    name: 'Arbiter',            bins: ['arbiter'],    pgrep: 'arbiter' },
  { id: 'carrier',    name: 'Carrier Bootstrap',  bins: ['carrier'],    pgrep: 'carrier' },
];

function getElastosProcesses() {
  const results = [];

  let psLines = [];
  try {
    const psOut = execSync('ps -eo pid,pcpu,rss,vsz,comm,args --no-headers', {
      encoding: 'utf8',
      timeout: 5000,
    });
    psLines = psOut.trim().split('\n');
  } catch {
    for (const def of CHAIN_DEFS) {
      results.push({ id: def.id, name: def.name, pid: null, cpu: 0, ramMB: 0, status: 'unknown' });
    }
    return results;
  }

  const matched = new Set();

  for (const def of CHAIN_DEFS) {
    let found = false;

    // Method 1: use pgrep pattern (matches how node.sh finds its own processes)
    if (def.pgrep) {
      try {
        const pgrepOut = execSync(`pgrep -f '${def.pgrep}' 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
        const pids = pgrepOut.trim().split('\n').map(p => parseInt(p, 10)).filter(p => p > 0 && !matched.has(p));
        if (pids.length > 0) {
          const targetPid = pids[0];
          matched.add(targetPid);
          const psLine = psLines.find(l => {
            const p = parseInt(l.trim().split(/\s+/)[0], 10);
            return p === targetPid;
          });
          let cpu = 0, ramMB = 0;
          if (psLine) {
            const parts = psLine.trim().split(/\s+/);
            cpu = parseFloat(parts[1]) || 0;
            ramMB = Math.round((parseInt(parts[2], 10) || 0) / 1024 * 10) / 10;
          }
          results.push({ id: def.id, name: def.name, pid: targetPid, cpu, ramMB, status: 'running' });
          found = true;
        }
      } catch { /* pgrep returns exit 1 when no match */ }
    }

    // Method 2: fallback to binary name match from ps output
    if (!found && def.bins.length > 0) {
      for (const line of psLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const pid = parseInt(parts[0], 10);
        if (matched.has(pid)) continue;
        const comm = parts[4].toLowerCase();
        if (def.bins.some(b => comm === b || comm.endsWith('/' + b))) {
          matched.add(pid);
          results.push({
            id: def.id, name: def.name, pid,
            cpu: parseFloat(parts[1]) || 0,
            ramMB: Math.round((parseInt(parts[2], 10) || 0) / 1024 * 10) / 10,
            status: 'running',
          });
          found = true;
          break;
        }
      }
    }

    if (!found) {
      results.push({ id: def.id, name: def.name, pid: null, cpu: 0, ramMB: 0, status: 'stopped' });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// JSONL Storage
// ---------------------------------------------------------------------------

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function todayFilename() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}.jsonl`;
}

function appendSnapshot(snapshot) {
  ensureDataDir();
  const fpath = path.join(DATA_DIR, todayFilename());
  fs.appendFileSync(fpath, JSON.stringify(snapshot) + '\n');
}

function pruneOldFiles() {
  ensureDataDir();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const dateStr = f.replace('.jsonl', '');
      const fileDate = new Date(dateStr + 'T00:00:00Z');
      if (fileDate.getTime() < cutoff) {
        fs.unlinkSync(path.join(DATA_DIR, f));
        console.log(`[prune] Deleted old data file: ${f}`);
      }
    }
  } catch (e) {
    console.error('[prune] Error:', e.message);
  }
}

function readHistory(rangeMs) {
  ensureDataDir();
  const now = Date.now();
  const since = now - rangeMs;
  const results = [];

  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      const dateStr = f.replace('.jsonl', '');
      const fileDate = new Date(dateStr + 'T23:59:59Z');
      if (fileDate.getTime() < since) continue;

      const content = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
      const lines = content.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const snap = JSON.parse(line);
          if (snap.ts >= since) results.push(snap);
        } catch { /* skip malformed lines */ }
      }
    }
  } catch { /* no data yet */ }

  return downsample(results, rangeMs);
}

function downsample(data, rangeMs) {
  const MAX_POINTS = 300;
  if (data.length <= MAX_POINTS) return data;
  const step = Math.ceil(data.length / MAX_POINTS);
  const out = [];
  for (let i = 0; i < data.length; i += step) {
    out.push(data[i]);
  }
  if (out[out.length - 1] !== data[data.length - 1]) {
    out.push(data[data.length - 1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collect a single snapshot
// ---------------------------------------------------------------------------

let latestSnapshot = null;

function collectSnapshot() {
  const cpu = getCpuUsage();
  const memory = getMemory();
  const disk = getDisk();
  const network = getNetwork();
  const chains = getElastosProcesses();

  const snapshot = {
    ts: Date.now(),
    cpu,
    memory,
    disk,
    network,
    chains,
  };

  latestSnapshot = snapshot;
  appendSnapshot(snapshot);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();

  const tokenFromQuery = req.query.token;
  const authHeader = req.headers.authorization;
  const tokenFromHeader = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (tokenFromQuery === AUTH_TOKEN || tokenFromHeader === AUTH_TOKEN) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized. Provide ?token=YOUR_TOKEN or Authorization: Bearer YOUR_TOKEN' });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use('/api', authMiddleware);

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (req, res) => {
  if (AUTH_TOKEN) {
    const tokenFromQuery = req.query.token;
    if (tokenFromQuery !== AUTH_TOKEN) {
      return res.status(401).send('Unauthorized. Access the dashboard using the URL provided during installation (includes your token).');
    }
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/current', (req, res) => {
  res.json(latestSnapshot || { ts: 0, message: 'No data collected yet. Wait 30 seconds.' });
});

app.get('/api/history', (req, res) => {
  const ranges = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  const range = ranges[req.query.range] || ranges['1h'];
  res.json(readHistory(range));
});

app.get('/api/specs', (req, res) => {
  res.json(SPECS);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

getCpuUsage();
if (IS_LINUX) readNetDev();

setTimeout(() => {
  console.log('[collector] First snapshot...');
  collectSnapshot();
}, 2000);

setInterval(() => {
  collectSnapshot();
}, COLLECT_INTERVAL_MS);

pruneOldFiles();
setInterval(pruneOldFiles, 24 * 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  const tokenParam = AUTH_TOKEN ? `?token=${AUTH_TOKEN}` : '';
  console.log(`[server] Elastos Node Monitor running at http://0.0.0.0:${PORT}${tokenParam}`);
});
