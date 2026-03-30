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
const COLLECT_INTERVAL_MS = 3_000;
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
// System uptime
// ---------------------------------------------------------------------------

function getUptime() {
  if (!IS_LINUX) return { systemSec: os.uptime(), bootTime: Date.now() - os.uptime() * 1000 };
  try {
    const raw = fs.readFileSync('/proc/uptime', 'utf8');
    const sec = parseFloat(raw.split(' ')[0]);
    return { systemSec: sec, bootTime: Date.now() - sec * 1000 };
  } catch {
    return { systemSec: os.uptime(), bootTime: Date.now() - os.uptime() * 1000 };
  }
}

// ---------------------------------------------------------------------------
// CPU usage from /proc/stat (Linux) or os module (fallback)
// ---------------------------------------------------------------------------

let prevCpuTimes = null;

function readProcStat() {
  try {
    const content = fs.readFileSync('/proc/stat', 'utf8');
    const lines = content.split('\n');
    const aggregate = lines[0];
    const parts = aggregate.trim().split(/\s+/).slice(1).map(Number);
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
      buffersGB: 0, cachedGB: 0, swapTotalGB: 0, swapUsedGB: 0,
    };
  }

  try {
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = content.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? parseInt(m[1], 10) : 0;
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
//
// Chain binaries: matched by exact `comm` field from `ps -eo pid,ppid,rss,comm,args`
// Oracle scripts: matched by `crosschain_*.js` in args, comm = "node" or "MainThread"
// ESC oracle uses crosschain_oracle.js (not crosschain_esc.js)
// CPU: real-time via /proc/$PID/stat deltas (all threads aggregated)
// RAM: VmRSS from /proc/$PID/status
// I/O: /proc/$PID/io read_bytes/write_bytes deltas

const CHAIN_DEFS = [
  { id: 'ela',        name: 'ELA Mainchain',     matchComm: 'ela' },
  { id: 'esc',        name: 'ESC Sidechain',     matchComm: 'esc' },
  { id: 'esc-oracle', name: 'ESC Oracle',         matchArgs: 'crosschain_oracle.js' },
  { id: 'eid',        name: 'EID Sidechain',     matchComm: 'eid' },
  { id: 'eid-oracle', name: 'EID Oracle',         matchArgs: 'crosschain_eid.js' },
  { id: 'eco',        name: 'ECO Sidechain',     matchComm: 'eco' },
  { id: 'eco-oracle', name: 'ECO Oracle',         matchArgs: 'crosschain_eco.js' },
  { id: 'pg',         name: 'PG Sidechain',      matchComm: 'pg' },
  { id: 'pg-oracle',  name: 'PG Oracle',          matchArgs: 'crosschain_pg.js' },
  { id: 'arbiter',    name: 'Arbiter',            matchComm: 'arbiter' },
];

// ---------------------------------------------------------------------------
// Per-process CPU tracking via /proc/$PID/stat deltas
// /proc/$PID/stat aggregates all threads (thread_group_cputime)
// ---------------------------------------------------------------------------

let prevProcCpu = {};
let prevProcIO = {};
let CLK_TCK = 100;
try { CLK_TCK = parseInt(execSync('getconf CLK_TCK', { encoding: 'utf8' }).trim(), 10) || 100; } catch {}

function readProcCpuTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parenIdx = stat.lastIndexOf(')');
    if (parenIdx < 0) return null;
    const fields = stat.substring(parenIdx + 2).trim().split(/\s+/);
    if (fields.length < 20) return null;
    const utime = parseInt(fields[11], 10) || 0;
    const stime = parseInt(fields[12], 10) || 0;
    const starttime = parseInt(fields[19], 10) || 0;
    return { utime, stime, starttime, wallMs: Date.now() };
  } catch {
    return null;
  }
}

function calcProcCpuPercent(pid) {
  const curr = readProcCpuTime(pid);
  if (!curr) return { cpuRaw: 0, cpuSystem: 0 };

  const prev = prevProcCpu[pid];
  prevProcCpu[pid] = curr;

  if (!prev) return { cpuRaw: 0, cpuSystem: 0 };

  const dtSec = (curr.wallMs - prev.wallMs) / 1000;
  if (dtSec < 0.5) return { cpuRaw: 0, cpuSystem: 0 };

  const deltaTicks = (curr.utime - prev.utime) + (curr.stime - prev.stime);
  const cpuRaw = Math.round((deltaTicks / CLK_TCK) / dtSec * 100 * 100) / 100;
  const cpuSystem = Math.round(cpuRaw / SPECS.cpuCores * 100) / 100;
  return { cpuRaw, cpuSystem };
}

// ---------------------------------------------------------------------------
// Per-process I/O tracking via /proc/$PID/io deltas
// ---------------------------------------------------------------------------

function readProcIO(pid) {
  try {
    const content = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
    const get = (key) => {
      const m = content.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? parseInt(m[1], 10) : 0;
    };
    return { readBytes: get('read_bytes'), writeBytes: get('write_bytes'), wallMs: Date.now() };
  } catch {
    return null;
  }
}

function calcProcIO(pid) {
  const curr = readProcIO(pid);
  if (!curr) return { readMBps: 0, writeMBps: 0 };

  const prev = prevProcIO[pid];
  prevProcIO[pid] = curr;

  if (!prev) return { readMBps: 0, writeMBps: 0 };

  const dtSec = (curr.wallMs - prev.wallMs) / 1000;
  if (dtSec < 0.5) return { readMBps: 0, writeMBps: 0 };

  return {
    readMBps: Math.round((curr.readBytes - prev.readBytes) / dtSec / (1024 * 1024) * 100) / 100,
    writeMBps: Math.round((curr.writeBytes - prev.writeBytes) / dtSec / (1024 * 1024) * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Per-process metadata: uptime, thread count
// ---------------------------------------------------------------------------

function getProcMeta(pid) {
  if (!IS_LINUX) return { uptimeSec: 0, threads: 0 };

  let threads = 0;
  try {
    const statusContent = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const threadsMatch = statusContent.match(/^Threads:\s+(\d+)/m);
    threads = threadsMatch ? parseInt(threadsMatch[1], 10) : 1;
  } catch {}

  let uptimeSec = 0;
  try {
    const statContent = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parenIdx = statContent.lastIndexOf(')');
    if (parenIdx >= 0) {
      const fields = statContent.substring(parenIdx + 2).trim().split(/\s+/);
      if (fields.length >= 20) {
        const starttime = parseInt(fields[19], 10) || 0;
        const uptimeRaw = fs.readFileSync('/proc/uptime', 'utf8');
        const systemUptime = parseFloat(uptimeRaw.split(' ')[0]);
        uptimeSec = Math.round(Math.max(0, systemUptime - (starttime / CLK_TCK)));
      }
    }
  } catch {}

  return { uptimeSec, threads };
}

// ---------------------------------------------------------------------------
// Main process discovery + metrics
// ---------------------------------------------------------------------------

function getElastosProcesses() {
  const results = [];

  let psOut = '';
  try {
    psOut = execSync('ps -eo pid,ppid,rss,comm,args --no-headers', {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch {
    return CHAIN_DEFS.map(def => ({
      id: def.id, name: def.name, pid: null, cpu: 0, cpuRaw: 0,
      ramMB: 0, status: 'unknown', threads: 0, uptimeSec: 0,
      readMBps: 0, writeMBps: 0,
    }));
  }

  const processes = [];
  for (const line of psOut.trim().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    processes.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      rssKB: parseInt(m[3], 10) || 0,
      comm: m[4],
      args: m[5],
    });
  }

  const matched = new Set();

  for (const def of CHAIN_DEFS) {
    let found = false;

    for (const proc of processes) {
      if (matched.has(proc.pid)) continue;

      let isMatch = false;
      if (def.matchComm) {
        isMatch = proc.comm === def.matchComm;
      } else if (def.matchArgs) {
        isMatch = proc.args.includes(def.matchArgs) &&
                  (proc.comm === 'node' || proc.comm === 'MainThread');
      }

      if (isMatch) {
        matched.add(proc.pid);

        const { cpuRaw, cpuSystem } = IS_LINUX ? calcProcCpuPercent(proc.pid) : { cpuRaw: 0, cpuSystem: 0 };

        // Sum child processes' CPU + RAM (e.g., Node.js workers forked by oracle)
        let totalRamKB = 0;
        let childCpuRaw = 0;
        const pidGroup = [proc.pid];
        for (const child of processes) {
          if (child.ppid === proc.pid && !matched.has(child.pid)) {
            pidGroup.push(child.pid);
            matched.add(child.pid);
            if (IS_LINUX) {
              const childCpu = calcProcCpuPercent(child.pid);
              childCpuRaw += childCpu.cpuRaw;
            }
          }
        }

        // VmRSS from /proc for main + children
        for (const p of pidGroup) {
          try {
            const status = fs.readFileSync(`/proc/${p}/status`, 'utf8');
            const vmRss = status.match(/^VmRSS:\s+(\d+)/m);
            if (vmRss) totalRamKB += parseInt(vmRss[1], 10);
          } catch {
            const psProc = processes.find(x => x.pid === p);
            if (psProc) totalRamKB += psProc.rssKB;
          }
        }

        const finalCpuRaw = Math.round((cpuRaw + childCpuRaw) * 100) / 100;
        const finalCpuSystem = Math.round(finalCpuRaw / SPECS.cpuCores * 100) / 100;

        const io = IS_LINUX ? calcProcIO(proc.pid) : { readMBps: 0, writeMBps: 0 };
        const meta = IS_LINUX ? getProcMeta(proc.pid) : { uptimeSec: 0, threads: 0 };

        results.push({
          id: def.id,
          name: def.name,
          pid: proc.pid,
          cpu: finalCpuSystem,
          cpuRaw: finalCpuRaw,
          ramMB: Math.round(totalRamKB / 1024 * 10) / 10,
          status: 'running',
          threads: meta.threads,
          uptimeSec: meta.uptimeSec,
          readMBps: io.readMBps,
          writeMBps: io.writeMBps,
        });
        found = true;
        break;
      }
    }

    if (!found) {
      results.push({
        id: def.id, name: def.name, pid: null, cpu: 0, cpuRaw: 0,
        ramMB: 0, status: 'stopped', threads: 0, uptimeSec: 0,
        readMBps: 0, writeMBps: 0,
      });
    }
  }

  // Per-chain disk usage (from Elastos node directory)
  if (ELASTOS_NODE_DIR) {
    const diskCache = getChainDiskUsage();
    for (const r of results) {
      r.diskGB = diskCache[r.id] || 0;
    }
  }

  // Clean up stale PID entries
  const activePids = new Set(results.filter(r => r.pid).map(r => r.pid));
  for (const pid of Object.keys(prevProcCpu)) {
    if (!activePids.has(parseInt(pid, 10))) delete prevProcCpu[pid];
  }
  for (const pid of Object.keys(prevProcIO)) {
    if (!activePids.has(parseInt(pid, 10))) delete prevProcIO[pid];
  }

  return results;
}

// ---------------------------------------------------------------------------
// Per-chain disk usage (cached, updated once per hour)
// ---------------------------------------------------------------------------

let chainDiskCache = {};
let chainDiskLastUpdate = 0;
const CHAIN_DISK_INTERVAL_MS = 60 * 60 * 1000;

const CHAIN_DIR_NAMES = {
  'ela': 'ela', 'esc': 'esc', 'esc-oracle': 'esc-oracle',
  'eid': 'eid', 'eid-oracle': 'eid-oracle', 'eco': 'eco', 'eco-oracle': 'eco-oracle',
  'pg': 'pg', 'pg-oracle': 'pg-oracle', 'arbiter': 'arbiter',
};

function getChainDiskUsage() {
  const now = Date.now();
  if (now - chainDiskLastUpdate < CHAIN_DISK_INTERVAL_MS && Object.keys(chainDiskCache).length > 0) {
    return chainDiskCache;
  }

  const result = {};
  try {
    const duOut = execSync(`du -sk ${ELASTOS_NODE_DIR}/*/ 2>/dev/null || true`, {
      encoding: 'utf8',
      timeout: 60000,
    });
    for (const line of duOut.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const sizeKB = parseInt(parts[0], 10) || 0;
      const dirPath = parts[1].replace(/\/+$/, '');
      const dirName = path.basename(dirPath);

      for (const [chainId, chainDir] of Object.entries(CHAIN_DIR_NAMES)) {
        if (dirName === chainDir) {
          result[chainId] = Math.round(sizeKB / (1024 * 1024) * 100) / 100;
          break;
        }
      }
    }
    chainDiskCache = result;
    chainDiskLastUpdate = now;
    console.log('[disk] Updated per-chain disk usage:', result);
  } catch (e) {
    console.error('[disk] Failed to read chain disk usage:', e.message);
  }
  return result;
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

function readHistoryRaw(rangeMs) {
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
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const snap = JSON.parse(line);
          if (snap.ts >= since) results.push(snap);
        } catch {}
      }
    }
  } catch {}

  return results;
}

function downsample(snapshots, maxPoints) {
  if (snapshots.length <= maxPoints) return snapshots;
  const step = snapshots.length / maxPoints;
  const result = [];
  for (let i = 0; i < maxPoints; i++) {
    result.push(snapshots[Math.floor(i * step)]);
  }
  if (result[result.length - 1] !== snapshots[snapshots.length - 1]) {
    result.push(snapshots[snapshots.length - 1]);
  }
  return result;
}

function readHistory(rangeMs) {
  return downsample(readHistoryRaw(rangeMs), 400);
}

// ---------------------------------------------------------------------------
// Collect a single snapshot
// ---------------------------------------------------------------------------

let latestSnapshot = null;

function collectSnapshot() {
  let cpu, memory, disk, network, chains, uptime;
  try {
    cpu = getCpuUsage();
    memory = getMemory();
    disk = getDisk();
    network = getNetwork();
    chains = getElastosProcesses();
    uptime = getUptime();
  } catch (e) {
    console.error('[collector] FATAL: collectSnapshot crashed:', e.message, e.stack);
    return null;
  }

  // Resource attribution: chains vs rest of system
  const chainsCpuSystem = chains.reduce((s, c) => s + c.cpu, 0);
  const chainsRamMB = chains.reduce((s, c) => s + c.ramMB, 0);

  const snapshot = {
    ts: Date.now(),
    cpu,
    memory,
    disk,
    network,
    chains,
    uptime,
    attribution: {
      chainsCpuPct: Math.round(chainsCpuSystem * 10) / 10,
      otherCpuPct: Math.round(Math.max(0, cpu.percent - chainsCpuSystem) * 10) / 10,
      chainsRamGB: Math.round(chainsRamMB / 1024 * 100) / 100,
      otherRamGB: Math.round(Math.max(0, memory.usedGB - chainsRamMB / 1024) * 100) / 100,
    },
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

app.get('/api/export', (req, res) => {
  const ranges = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  const rangeKey = req.query.range || '24h';
  const rangeMs = ranges[rangeKey] || ranges['24h'];
  const format = req.query.format || 'json';

  const allData = readHistoryRaw(rangeMs);
  const tsData = downsample(allData, 5000);

  const hostname = os.hostname();
  const now = new Date();
  const current = latestSnapshot || {};
  const chains = current.chains || [];
  const runningCount = chains.filter(c => c.status === 'running').length;

  const chainIds = CHAIN_DEFS.map(d => d.id);

  let cpuValues = [], ramValues = [], diskValues = [];
  const chainPeaks = {};
  const chainAvgs = {};
  for (const snap of allData) {
    cpuValues.push(snap.cpu.percent);
    ramValues.push(snap.memory.usedGB);
    if (snap.disk) diskValues.push(snap.disk.usedGB);
    for (const c of (snap.chains || [])) {
      if (!chainPeaks[c.id]) { chainPeaks[c.id] = { peakCpu: 0, peakCpuRaw: 0, peakRamMB: 0 }; chainAvgs[c.id] = { cpuSum: 0, ramSum: 0, count: 0 }; }
      if (c.cpu > chainPeaks[c.id].peakCpu) chainPeaks[c.id].peakCpu = c.cpu;
      if ((c.cpuRaw || 0) > chainPeaks[c.id].peakCpuRaw) chainPeaks[c.id].peakCpuRaw = c.cpuRaw || 0;
      if (c.ramMB > chainPeaks[c.id].peakRamMB) chainPeaks[c.id].peakRamMB = c.ramMB;
      chainAvgs[c.id].cpuSum += c.cpu;
      chainAvgs[c.id].ramSum += c.ramMB;
      chainAvgs[c.id].count++;
    }
  }

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const peak = arr => arr.length ? Math.max(...arr) : 0;

  const report = {
    exportedAt: now.toISOString(),
    hostname,
    range: rangeKey,
    dataPoints: allData.length,
    timeSeriesPoints: tsData.length,
    specs: SPECS,
    system: {
      uptimeDays: current.uptime ? +(current.uptime.systemSec / 86400).toFixed(1) : 0,
      cpu: { currentPct: current.cpu ? current.cpu.percent : 0, avgPct: +avg(cpuValues).toFixed(2), peakPct: +peak(cpuValues).toFixed(2), loadAvg: current.cpu ? current.cpu.loadAvg : [] },
      ram: { currentGB: current.memory ? current.memory.usedGB : 0, avgGB: +avg(ramValues).toFixed(2), peakGB: +peak(ramValues).toFixed(2), totalGB: SPECS.ramGB, cachedGB: current.memory ? current.memory.cachedGB : 0 },
      disk: { currentGB: current.disk ? current.disk.usedGB : 0, totalGB: SPECS.diskGB, percentUsed: current.disk ? current.disk.percent : 0 },
    },
    chains: chains.map(c => {
      const pa = chainAvgs[c.id] || { cpuSum: 0, ramSum: 0, count: 1 };
      const pp = chainPeaks[c.id] || { peakCpu: 0, peakCpuRaw: 0, peakRamMB: 0 };
      return {
        id: c.id, name: c.name, status: c.status,
        cpu: { currentPct: c.cpu, peakPct: pp.peakCpu, avgPct: +(pa.cpuSum / pa.count).toFixed(3) },
        ramMB: c.ramMB, peakRamMB: pp.peakRamMB, avgRamMB: +(pa.ramSum / pa.count).toFixed(1),
        diskGB: c.diskGB || 0, threads: c.threads || 0,
        uptimeDays: c.uptimeSec ? +(c.uptimeSec / 86400).toFixed(1) : 0,
      };
    }),
    totals: {
      chainsRunning: runningCount, chainsTotal: chains.length,
      chainsCpuPct: current.attribution ? current.attribution.chainsCpuPct : 0,
      chainsRamGB: current.attribution ? current.attribution.chainsRamGB : 0,
      chainsDiskGB: +chains.reduce((s, c) => s + (c.diskGB || 0), 0).toFixed(2),
    },
  };

  if (format === 'csv') {
    const lines = [];
    lines.push('# Elastos Node Monitor — Full Export');
    lines.push(`# Hostname: ${hostname}`);
    lines.push(`# Exported: ${now.toISOString()}`);
    lines.push(`# Range: ${rangeKey} (${allData.length} total snapshots, ${tsData.length} in time series below)`);
    lines.push(`# Specs: ${SPECS.cpuCores} cores, ${SPECS.ramGB} GB RAM, ${SPECS.diskGB} GB Disk`);
    lines.push(`# System uptime: ${report.system.uptimeDays} days`);
    lines.push('');

    lines.push('section,metric,current,average,peak');
    lines.push(`system,cpu_pct,${report.system.cpu.currentPct},${report.system.cpu.avgPct},${report.system.cpu.peakPct}`);
    lines.push(`system,ram_gb,${report.system.ram.currentGB},${report.system.ram.avgGB},${report.system.ram.peakGB}`);
    lines.push(`system,disk_gb,${report.system.disk.currentGB},,${report.system.disk.totalGB}`);
    for (const c of report.chains) {
      lines.push(`chain,${c.id}_cpu_pct,${c.cpu.currentPct},${c.cpu.avgPct},${c.cpu.peakPct}`);
      lines.push(`chain,${c.id}_ram_mb,${c.ramMB},${c.avgRamMB},${c.peakRamMB}`);
      lines.push(`chain,${c.id}_disk_gb,${c.diskGB},,`);
      lines.push(`chain,${c.id}_status,${c.status},,`);
      lines.push(`chain,${c.id}_threads,${c.threads},,`);
      lines.push(`chain,${c.id}_uptime_days,${c.uptimeDays},,`);
    }
    lines.push('');

    // Build time-series columns dynamically from chain IDs
    const tsCols = ['timestamp', 'datetime', 'cpu_pct', 'ram_used_gb', 'ram_cached_gb', 'disk_used_gb', 'net_rx_mbps', 'net_tx_mbps'];
    for (const id of chainIds) { tsCols.push(`${id}_cpu`, `${id}_ram_mb`); }
    lines.push(tsCols.join(','));

    for (const snap of tsData) {
      const chainMap = {};
      for (const c of (snap.chains || [])) chainMap[c.id] = c;
      const row = [
        snap.ts,
        new Date(snap.ts).toISOString(),
        snap.cpu.percent,
        snap.memory.usedGB,
        snap.memory.cachedGB || 0,
        snap.disk ? snap.disk.usedGB : '',
        snap.network ? snap.network.rxMBps : 0,
        snap.network ? snap.network.txMBps : 0,
      ];
      for (const id of chainIds) {
        const c = chainMap[id];
        row.push(c ? c.cpu : 0);
        row.push(c ? c.ramMB : 0);
      }
      lines.push(row.join(','));
    }

    const csvBody = lines.join('\n');
    const filename = `elastos-monitor-${hostname}-${rangeKey}-${now.toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvBody);
  }

  // JSON: include time series
  report.timeSeries = tsData.map(snap => {
    const row = {
      ts: snap.ts,
      cpu: snap.cpu.percent,
      ramUsedGB: snap.memory.usedGB,
      ramCachedGB: snap.memory.cachedGB || 0,
      diskUsedGB: snap.disk ? snap.disk.usedGB : 0,
      netRxMBps: snap.network ? snap.network.rxMBps : 0,
      netTxMBps: snap.network ? snap.network.txMBps : 0,
    };
    for (const c of (snap.chains || [])) {
      row[`${c.id}_cpu`] = c.cpu;
      row[`${c.id}_ram`] = c.ramMB;
    }
    return row;
  });

  const filename = `elastos-monitor-${hostname}-${rangeKey}-${now.toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(report);
});

app.get('/api/diag', (req, res) => {
  const result = {
    platform: os.platform(),
    isLinux: IS_LINUX,
    clkTck: CLK_TCK,
    specs: SPECS,
    primedCpuCount: Object.keys(prevProcCpu).length,
    primedIOCount: Object.keys(prevProcIO).length,
    snapshotAge: latestSnapshot ? Date.now() - latestSnapshot.ts : null,
  };

  const chains = latestSnapshot ? latestSnapshot.chains : [];
  result.chains = chains.map(c => ({
    id: c.id,
    pid: c.pid,
    status: c.status,
    cpu: c.cpu,
    cpuRaw: c.cpuRaw,
    ramMB: c.ramMB,
    threads: c.threads,
    uptimeSec: c.uptimeSec,
    hasCpuBaseline: c.pid ? !!prevProcCpu[c.pid] : false,
    hasIOBaseline: c.pid ? !!prevProcIO[c.pid] : false,
  }));

  const testChain = chains.find(c => c.pid);
  if (testChain) {
    const pid = testChain.pid;
    result.procReadTest = {};
    try { fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); result.procReadTest.stat = true; }
    catch (e) { result.procReadTest.stat = false; result.procReadTest.statErr = e.code; }
    try { fs.readFileSync(`/proc/${pid}/status`, 'utf8'); result.procReadTest.status = true; }
    catch (e) { result.procReadTest.status = false; result.procReadTest.statusErr = e.code; }
    try { fs.readFileSync(`/proc/${pid}/io`, 'utf8'); result.procReadTest.io = true; }
    catch (e) { result.procReadTest.io = false; result.procReadTest.ioErr = e.code; }
  }

  res.json(result);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

getCpuUsage();
if (IS_LINUX) readNetDev();

// Prime per-process CPU + IO baselines so first real snapshot has valid deltas
if (IS_LINUX) {
  try {
    const psOut = execSync('ps -eo pid,ppid,rss,comm,args --no-headers', { encoding: 'utf8', timeout: 5000 });
    const matchedPids = [];
    for (const line of psOut.trim().split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const comm = m[4];
      const args = m[5];
      for (const def of CHAIN_DEFS) {
        if ((def.matchComm && comm === def.matchComm) ||
            (def.matchArgs && args.includes(def.matchArgs) && (comm === 'node' || comm === 'MainThread'))) {
          matchedPids.push({ pid, chain: def.id, comm });
          const baseline = readProcCpuTime(pid);
          if (baseline) {
            prevProcCpu[pid] = baseline;
          } else {
            console.warn(`[init] Could not read /proc/${pid}/stat for ${def.id} (comm=${comm})`);
          }
          const ioBaseline = readProcIO(pid);
          if (ioBaseline) {
            prevProcIO[pid] = ioBaseline;
          } else {
            console.warn(`[init] Could not read /proc/${pid}/io for ${def.id} (comm=${comm})`);
          }
          break;
        }
      }
    }
    console.log('[init] Matched chains:', matchedPids.map(p => `${p.chain}(${p.pid}/${p.comm})`).join(', '));
    console.log('[init] Primed CPU baselines for', Object.keys(prevProcCpu).length, '/', matchedPids.length, 'chain processes');
    console.log('[init] Primed I/O baselines for', Object.keys(prevProcIO).length, '/', matchedPids.length, 'chain processes');
  } catch (e) {
    console.error('[init] Failed to prime baselines:', e.message);
  }
}

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
