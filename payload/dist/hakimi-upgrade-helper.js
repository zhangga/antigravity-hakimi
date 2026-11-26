#!/usr/bin/env node
'use strict';

/**
 * Self-contained detached cold-swap worker for 哈基米.app atomic self-upgrades.
 *
 * IMPORTANT:
 * - Uses ONLY Node.js built-in modules (`fs`, `os`, `path`, `child_process`) so it
 *   can be extracted from `app.asar` and executed via `ELECTRON_RUN_AS_NODE=1` or
 *   standalone `node` after the running `哈基米.app` has completely exited.
 * - Strictly refuses to touch official `/Applications/Antigravity.app` or `.orig`.
 * - Enforces zero-survivor exit barrier, cleans stale `SingletonLock`, swaps bundles
 *   atomically on the same APFS volume with `.prev` rollback on failure, immediately
 *   cleans `.prev` / staging / old clean-base zips on success, and relaunches with
 *   a sanitized environment (`open -n`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const OFFICIAL_BUNDLE_NAMES = new Set(['antigravity.app', 'antigravity.app.orig']);
const OFFICIAL_WIN_DIR_NAMES = new Set(['antigravity', 'antigravity.orig']);
const UPGRADE_HELPER_FILE_NAME = 'hakimi-upgrade-helper.js';
const UPGRADE_LOCK_FILE_NAME = 'hakimi-upgrade-cold.lock';
const UPGRADE_RESULT_FILE_NAME = 'hakimi-upgrade-last-result.json';
const UPGRADE_LOG_FILE_NAME = 'hakimi-upgrade-cold.log';
const LSREGISTER_BIN =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const RELAUNCH_STRIP_ENV_KEYS = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'NODE_OPTIONS',
  'ELECTRON_OZONE_PLATFORM_HINT',
  'DEV_URL',
];

function getDefaultStateDir(platform = process.platform, env = process.env, homeDir = os.homedir()) {
  const override = env.AG_METER_STATE_DIR || env.HAKIMI_STATE_DIR || env.ANTIGRAVITY_METER_STATE_DIR;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'AntigravityContextMeter');
  }
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'AntigravityContextMeter');
  }
  return path.join(homeDir, '.local', 'state', 'AntigravityContextMeter');
}

function getDefaultUserDataDir(platform = process.platform, env = process.env, homeDir = os.homedir()) {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Antigravity');
  }
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Antigravity');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'Antigravity');
}

function resolveWithExistingAncestor(targetPath) {
  const abs = path.resolve(String(targetPath || ''));
  const pending = [];
  let cur = abs;
  while (true) {
    try {
      if (fs.existsSync(cur)) {
        const real = fs.realpathSync(cur);
        return pending.length ? path.join(real, ...pending.reverse()) : real;
      }
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    pending.push(path.basename(cur));
    cur = parent;
  }
}

function matchesOfficialBundlePath(candidatePath) {
  const rawPosix = String(candidatePath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const resolvedPosix = path.resolve(String(candidatePath || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const forms = new Set([rawPosix, resolvedPosix]);
  for (const f of [...forms]) {
    const withoutDrive = f.replace(/^[a-z]:(?=\/)/, '');
    if (withoutDrive !== f) forms.add(withoutDrive);
  }
  for (const normalized of forms) {
    if (
      normalized === '/applications/antigravity.app' ||
      normalized.startsWith('/applications/antigravity.app/') ||
      normalized === '/applications/antigravity.app.orig' ||
      normalized.startsWith('/applications/antigravity.app.orig/')
    ) {
      return true;
    }
    const parts = normalized.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (OFFICIAL_BUNDLE_NAMES.has(part)) return true;
      if (
        OFFICIAL_WIN_DIR_NAMES.has(part) &&
        i > 0 &&
        (parts[i - 1] === 'programs' ||
          parts[i - 1] === 'program files' ||
          parts[i - 1] === 'program files (x86)')
      ) {
        return true;
      }
    }
  }
  return false;
}

function isOfficialAntigravityBundle(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  if (matchesOfficialBundlePath(targetPath)) return true;
  const real = resolveWithExistingAncestor(targetPath);
  return matchesOfficialBundlePath(real);
}

function assertNotOfficialBundle(targetPath, actionDesc) {
  if (isOfficialAntigravityBundle(targetPath)) {
    throw new Error(`安全拦截：禁止对官方原版 Antigravity.app 执行${actionDesc || '修改'}: ${targetPath}`);
  }
}

function getRuntimeDir(options = {}) {
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : getDefaultStateDir();
  return path.join(stateDir, 'runtime');
}

function getUpgradeLockPath(options = {}) {
  return path.join(getRuntimeDir(options), UPGRADE_LOCK_FILE_NAME);
}

function getUpgradeResultPath(options = {}) {
  return path.join(getRuntimeDir(options), UPGRADE_RESULT_FILE_NAME);
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, data: fallback };
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return { ok: false, data: fallback };
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, data: fallback };
  }
}

function writeJsonFileAtomic(filePath, data, mode = 0o600) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '写入文件失败' };
  }
}

function unlinkIfExists(filePath) {
  try {
    if (fs.existsSync(filePath) || fs.lstatSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {}
  return false;
}

function rmDirSafe(dirPath) {
  if (!dirPath) return false;
  assertNotOfficialBundle(dirPath, '删除目录');
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function appendUpgradeLog(stateDir, msg) {
  try {
    const logPath = path.join(getRuntimeDir({ stateDir }), UPGRADE_LOG_FILE_NAME);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

function listPsProcesses(execImpl = execFileSync) {
  const out = execImpl('ps', ['-ax', '-o', 'pid=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', LC_TIME: 'C' },
  });
  const rows = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({ pid, command: m[2] });
  }
  return rows;
}

function findRunningTargetPids(targetAppPath, mode = 'all', options = {}) {
  if (!targetAppPath) return [];
  const execImpl = options.execFileSync || execFileSync;
  const resolvedApp = path.resolve(String(targetAppPath));
  const prefixes = new Set([resolvedApp.replace(/\/+$/, '') + '/']);
  const execs = new Set([path.join(resolvedApp, 'Contents', 'MacOS', 'Antigravity')]);
  try {
    const realApp = fs.realpathSync(resolvedApp);
    prefixes.add(realApp.replace(/\/+$/, '') + '/');
    execs.add(path.join(realApp, 'Contents', 'MacOS', 'Antigravity'));
  } catch {}
  try {
    const realExec = fs.realpathSync(path.join(resolvedApp, 'Contents', 'MacOS', 'Antigravity'));
    execs.add(realExec);
  } catch {}

  const selfPids = new Set([process.pid, ...(Array.isArray(options.excludePids) ? options.excludePids : [])]);
  let rows = [];
  try {
    rows = listPsProcesses(execImpl);
  } catch {
    return [];
  }

  const pids = [];
  for (const row of rows) {
    if (selfPids.has(row.pid)) continue;
    const cmd = row.command;
    let isMain = false;
    for (const ex of execs) {
      if (cmd === ex || cmd.startsWith(ex + ' ')) {
        isMain = true;
        break;
      }
    }
    let isUnderApp = false;
    for (const pref of prefixes) {
      if (cmd.startsWith(pref)) {
        isUnderApp = true;
        break;
      }
    }
    if (mode === 'main' ? isMain : (isMain || isUnderApp)) {
      pids.push(row.pid);
    }
  }
  return pids;
}

function sleepMs(ms) {
  if (ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}

function safeKillPid(pid, signal, killImpl = process.kill) {
  try {
    killImpl(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid, killImpl = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code !== 'ESRCH');
  }
}

function stopTargetAppProcesses(targetAppPath, options = {}) {
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 100;
  const initialGraceMs = Number.isFinite(options.initialGraceMs) ? options.initialGraceMs : 2500;
  const mainTermMs = Number.isFinite(options.mainTermMs) ? options.mainTermMs : 2500;
  const allTermMs = Number.isFinite(options.allTermMs) ? options.allTermMs : 1500;
  const killWaitMs = Number.isFinite(options.killWaitMs) ? options.killWaitMs : 2500;
  const killImpl = options.killImpl || process.kill;
  const sleepImpl = options.sleepImpl || sleepMs;
  const findPids = options.findPidsImpl || ((m) => findRunningTargetPids(targetAppPath, m, options));

  const waitUntilZero = (budgetMs) => {
    const steps = Math.max(1, Math.ceil(budgetMs / Math.max(10, pollIntervalMs)));
    for (let i = 0; i < steps; i++) {
      const rem = findPids('all');
      if (rem.length === 0) return [];
      sleepImpl(pollIntervalMs);
    }
    return findPids('all');
  };

  let rem = findPids('all');
  if (rem.length === 0) return { ok: true, remaining: [] };

  rem = waitUntilZero(initialGraceMs);
  if (rem.length === 0) return { ok: true, remaining: [] };

  const mainPids = findPids('main');
  if (mainPids.length > 0) {
    for (const pid of mainPids) safeKillPid(pid, 'SIGTERM', killImpl);
    rem = waitUntilZero(mainTermMs);
    if (rem.length === 0) return { ok: true, remaining: [] };
  }

  for (const pid of rem) safeKillPid(pid, 'SIGTERM', killImpl);
  rem = waitUntilZero(allTermMs);
  if (rem.length === 0) return { ok: true, remaining: [] };

  const killSteps = Math.max(1, Math.ceil(killWaitMs / Math.max(10, pollIntervalMs)));
  for (let i = 0; i < killSteps; i++) {
    rem = findPids('all');
    if (rem.length === 0) return { ok: true, remaining: [] };
    for (const pid of rem) safeKillPid(pid, 'SIGKILL', killImpl);
    sleepImpl(pollIntervalMs);
  }

  rem = findPids('all');
  if (rem.length > 0) {
    return {
      ok: false,
      remaining: rem,
      error: `等待旧进程退出超时，仍有残留进程 (PID: ${rem.join(', ')})，请手动退出应用后重试`,
    };
  }
  return { ok: true, remaining: [] };
}

function cleanupStaleSingletonLockDir(userDataDir, killImpl = process.kill) {
  const dir = userDataDir ? path.resolve(String(userDataDir)) : getDefaultUserDataDir();
  const lockPath = path.join(dir, 'SingletonLock');
  let st;
  try {
    st = fs.lstatSync(lockPath);
  } catch {
    return { cleaned: false, reason: 'no_lock', dir };
  }
  if (!st || !st.isSymbolicLink()) {
    return { cleaned: false, reason: 'no_lock', dir };
  }
  let target = '';
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return { cleaned: false, reason: 'unreadable_lock', dir };
  }
  const match = String(target).match(/-(\d+)$/);
  if (!match) return { cleaned: false, reason: 'unrecognized_target', dir };
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { cleaned: false, reason: 'unrecognized_target', dir };
  }
  if (isPidAlive(pid, killImpl)) {
    return { cleaned: false, reason: 'owner_alive', pid, dir };
  }
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {}
  }
  return { cleaned: true, pid, dir };
}

function acquireUpgradeLock(options = {}) {
  const lockPath = getUpgradeLockPath(options);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    fs.closeSync(fd);
    return { ok: true, lockPath };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const existing = readJsonFileSafe(lockPath, null);
      const stale = (() => {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 120000) return true;
        } catch {
          return true;
        }
        const ownerPid = Number(existing?.data?.pid || 0);
        if (ownerPid > 0 && !isPidAlive(ownerPid, options.killImpl)) return true;
        return false;
      })();
      if (stale) {
        unlinkIfExists(lockPath);
        try {
          const fd = fs.openSync(lockPath, 'wx', 0o600);
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
          fs.closeSync(fd);
          return { ok: true, lockPath };
        } catch {}
      }
      return { ok: false, error: '已有更新替换任务正在执行，请稍候' };
    }
    return { ok: false, error: err?.message || '获取更新互斥锁失败' };
  }
}

function releaseUpgradeLock(options = {}) {
  unlinkIfExists(getUpgradeLockPath(options));
}

function buildCleanRelaunchEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of RELAUNCH_STRIP_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function relaunchTargetApp(targetAppPath, options = {}) {
  if (!targetAppPath) return { ok: false, error: '未指定要重新启动的应用路径' };
  const spawnImpl = options.spawnImpl || spawn;
  const cleanEnv = buildCleanRelaunchEnv(options.env || process.env);
  try {
    const child = spawnImpl('/usr/bin/open', ['-n', targetAppPath], {
      detached: true,
      stdio: 'ignore',
      env: cleanEnv,
    });
    if (child && typeof child.unref === 'function') child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '重新启动应用失败' };
  }
}

function verifyStagedBundleReady(stagedAppPath) {
  if (!stagedAppPath || !fs.existsSync(stagedAppPath)) {
    throw new Error(`找不到已准备好的更新包: ${stagedAppPath || '(空)'}`);
  }
  const required = [
    path.join(stagedAppPath, 'Contents', 'Info.plist'),
    path.join(stagedAppPath, 'Contents', 'MacOS', 'Antigravity'),
    path.join(stagedAppPath, 'Contents', 'Resources', 'app.asar'),
  ];
  for (const reqPath of required) {
    if (!fs.existsSync(reqPath)) {
      throw new Error(`更新包结构不完整，缺少 ${path.relative(stagedAppPath, reqPath)}`);
    }
  }
}

function moveBundleSameVolumeSafe(srcPath, destPath, { execImpl = execFileSync, renameImpl = fs.renameSync } = {}) {
  assertNotOfficialBundle(srcPath, '移动源包');
  assertNotOfficialBundle(destPath, '覆盖目标包');
  try {
    renameImpl(srcPath, destPath);
    return;
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
  }
  // Cross-device fallback: copy into sibling incoming path first, then caller renames atomically
  execImpl('/usr/bin/ditto', [srcPath, destPath], { stdio: 'pipe' });
  rmDirSafe(srcPath);
}

/**
 * Atomic same-volume bundle swap with automatic `.prev` rollback on any failure.
 */
function swapStagedBundleAtomically({ targetAppPath, stagedAppPath, prevBackupPath }, options = {}) {
  const execImpl = options.execFileSync || execFileSync;
  const renameImpl = options.renameSync || fs.renameSync;
  const targetAbs = path.resolve(String(targetAppPath || ''));
  const stagedAbs = path.resolve(String(stagedAppPath || ''));
  const targetDir = path.dirname(targetAbs);
  const baseName = path.basename(targetAbs);
  const prevAbs = prevBackupPath
    ? path.resolve(String(prevBackupPath))
    : path.join(targetDir, `.${baseName}.prev.${process.pid}`);
  const incomingAbs = path.join(targetDir, `.${baseName}.incoming.${process.pid}`);

  assertNotOfficialBundle(targetAbs, '替换目标应用');
  assertNotOfficialBundle(stagedAbs, '读取沙盒应用');
  assertNotOfficialBundle(prevAbs, '创建旧版备份');
  assertNotOfficialBundle(incomingAbs, '准备同盘暂存目录');

  verifyStagedBundleReady(stagedAbs);

  if (fs.existsSync(prevAbs)) rmDirSafe(prevAbs);
  if (fs.existsSync(incomingAbs)) rmDirSafe(incomingAbs);

  // Move staged bundle onto the exact target filesystem FIRST (while target is still intact!)
  let readyToRenamePath = stagedAbs;
  try {
    const targetDirStat = fs.statSync(targetDir);
    const stagedStat = fs.statSync(stagedAbs);
    if (targetDirStat.dev !== stagedStat.dev) {
      execImpl('/usr/bin/ditto', [stagedAbs, incomingAbs], { stdio: 'pipe' });
      readyToRenamePath = incomingAbs;
    }
  } catch {
    // Fallback to renameSync with EXDEV handling
  }

  let movedTargetToPrev = false;
  const hadExistingTarget = fs.existsSync(targetAbs);
  try {
    if (hadExistingTarget) {
      renameImpl(targetAbs, prevAbs);
      movedTargetToPrev = true;
    }
    try {
      renameImpl(readyToRenamePath, targetAbs);
    } catch (renameErr) {
      if (renameErr && renameErr.code === 'EXDEV' && readyToRenamePath !== incomingAbs) {
        // Restore target before cross-device copy if possible, or copy to incoming then swap
        if (movedTargetToPrev && fs.existsSync(prevAbs) && !fs.existsSync(targetAbs)) {
          renameImpl(prevAbs, targetAbs);
          movedTargetToPrev = false;
        }
        execImpl('/usr/bin/ditto', [stagedAbs, incomingAbs], { stdio: 'pipe' });
        readyToRenamePath = incomingAbs;
        if (hadExistingTarget) {
          renameImpl(targetAbs, prevAbs);
          movedTargetToPrev = true;
        }
        renameImpl(incomingAbs, targetAbs);
      } else {
        throw renameErr;
      }
    }
  } catch (swapErr) {
    let rolledBack = false;
    if (movedTargetToPrev && fs.existsSync(prevAbs) && !fs.existsSync(targetAbs)) {
      try {
        renameImpl(prevAbs, targetAbs);
        rolledBack = true;
      } catch {}
    }
    if (fs.existsSync(incomingAbs)) rmDirSafe(incomingAbs);
    const err = new Error(
      `原子替换应用包失败${rolledBack ? '（已自动回滚旧版）' : ''}: ${swapErr?.message || String(swapErr)}`
    );
    err.rolledBack = rolledBack;
    throw err;
  }

  // Success: immediately remove `.prev` backup and any leftover incoming dir
  if (movedTargetToPrev && fs.existsSync(prevAbs)) {
    rmDirSafe(prevAbs);
  }
  if (fs.existsSync(incomingAbs)) {
    rmDirSafe(incomingAbs);
  }
  if (readyToRenamePath === incomingAbs && fs.existsSync(stagedAbs)) {
    rmDirSafe(stagedAbs);
  }

  // Best-effort macOS quarantine strip, mtime touch, and LaunchServices re-registration
  if (options.skipMacRegistration !== true && process.platform === 'darwin') {
    try { execImpl('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', targetAbs], { stdio: 'ignore' }); } catch {}
    try {
      const now = new Date();
      fs.utimesSync(targetAbs, now, now);
    } catch {}
    try {
      if (fs.existsSync(LSREGISTER_BIN)) {
        execImpl(LSREGISTER_BIN, ['-f', targetAbs], { stdio: 'ignore' });
      }
    } catch {}
  }

  return { ok: true, targetAppPath: targetAbs, cleanedPrev: movedTargetToPrev };
}

/**
 * Promote newly verified clean official zip into the single-slot cache directory
 * and delete all older/duplicate zip files immediately.
 */
function promoteSingleSlotCleanBase(promotion, options = {}) {
  if (!promotion || !promotion.stagedZipPath || !promotion.cleanBaseDir || !promotion.version) {
    return { promoted: false };
  }
  const stagedZip = path.resolve(String(promotion.stagedZipPath));
  const cleanBaseDir = path.resolve(String(promotion.cleanBaseDir));
  const version = String(promotion.version).replace(/[^0-9A-Za-z._-]/g, '');
  if (!version || !fs.existsSync(stagedZip)) return { promoted: false };

  fs.mkdirSync(cleanBaseDir, { recursive: true });
  const targetFileName = `Antigravity-${version}.zip`;
  const targetZip = path.join(cleanBaseDir, targetFileName);
  const metaPath = path.join(cleanBaseDir, 'clean-base-meta.json');

  if (stagedZip !== targetZip) {
    try {
      fs.renameSync(stagedZip, targetZip);
    } catch (err) {
      if (err && err.code === 'EXDEV') {
        fs.copyFileSync(stagedZip, targetZip);
        unlinkIfExists(stagedZip);
      } else {
        throw err;
      }
    }
  }

  writeJsonFileAtomic(
    metaPath,
    {
      version,
      fileName: targetFileName,
      sha512: promotion.sha512 || '',
      verifiedAt: promotion.verifiedAt || new Date().toISOString(),
    },
    0o600
  );

  // Enforce strict single-slot invariant: remove any older/other *.zip in cleanBaseDir
  const removedOld = [];
  try {
    for (const entry of fs.readdirSync(cleanBaseDir)) {
      if (entry.endsWith('.zip') && entry !== targetFileName) {
        if (unlinkIfExists(path.join(cleanBaseDir, entry))) {
          removedOld.push(entry);
        }
      }
    }
  } catch {}

  // Also clean duplicate native pending cache zip when official Antigravity.app is not running
  const nativeCacheDir = promotion.nativeCacheDir ? path.resolve(String(promotion.nativeCacheDir)) : '';
  if (nativeCacheDir && fs.existsSync(nativeCacheDir)) {
    const officialRunning =
      findRunningTargetPids('/Applications/Antigravity.app', 'all', options).length > 0;
    if (!officialRunning) {
      unlinkIfExists(path.join(nativeCacheDir, 'pending', 'Antigravity.zip'));
      unlinkIfExists(path.join(nativeCacheDir, 'pending', 'update-info.json'));
      unlinkIfExists(path.join(nativeCacheDir, 'update.zip'));
    }
  }

  return { promoted: true, targetZip, removedOld };
}

function executeColdUpgradeJob(job, options = {}) {
  const stateDir = job?.stateDir ? path.resolve(job.stateDir) : getDefaultStateDir();
  const homeDir = job?.homeDir ? path.resolve(job.homeDir) : os.homedir();
  const userDataDir = job?.userDataDir
    ? path.resolve(job.userDataDir)
    : getDefaultUserDataDir(process.platform, process.env, homeDir);
  const targetAppPath = job?.targetAppPath ? path.resolve(job.targetAppPath) : '';
  const stagedAppPath = job?.stagedAppPath ? path.resolve(job.stagedAppPath) : '';
  const stagingRootDir = job?.stagingRootDir ? path.resolve(job.stagingRootDir) : '';
  const shouldRelaunch = options.relaunch !== false && Boolean(targetAppPath);

  if (
    (targetAppPath && !options.allowOfficialForTest && isOfficialAntigravityBundle(targetAppPath)) ||
    (stagedAppPath && !options.allowOfficialForTest && isOfficialAntigravityBundle(stagedAppPath))
  ) {
    return { ok: false, error: '安全拦截：禁止对官方原版 Antigravity.app 执行冷切替换' };
  }

  const commonOpts = { ...options, stateDir, userDataDir, homeDir };
  const jobKind = typeof job?.jobKind === 'string' && job.jobKind.trim() ? job.jobKind.trim() : 'upgrade';
  const resultFilePath =
    job?.resultPath && typeof job.resultPath === 'string'
      ? path.resolve(job.resultPath)
      : getUpgradeResultPath({ stateDir });

  const finalize = (result, { suppressRelaunch = false } = {}) => {
    const record = {
      ...result,
      jobKind,
      ...(job?.iconMode ? { iconMode: job.iconMode } : {}),
      targetAntigravityVersion: job?.targetAntigravityVersion || null,
      targetHakimiCommit: job?.targetHakimiCommit || null,
      completedAt: new Date().toISOString(),
    };
    writeJsonFileAtomic(resultFilePath, record, 0o600);
    releaseUpgradeLock({ stateDir });
    if (shouldRelaunch && !suppressRelaunch) {
      if (options.sleepImpl) options.sleepImpl(350);
      else sleepMs(350);
      const relaunchRes = relaunchTargetApp(targetAppPath, options);
      appendUpgradeLog(stateDir, `relaunch ${targetAppPath}: ok=${relaunchRes.ok}`);
      record.relaunched = relaunchRes.ok;
      if (!relaunchRes.ok && !record.error) {
        record.error = relaunchRes.error;
      }
    }
    return record;
  };

  const lockRes = acquireUpgradeLock({ stateDir, killImpl: options.killImpl });
  if (!lockRes.ok) {
    return { ok: false, error: lockRes.error };
  }

  appendUpgradeLog(
    stateDir,
    `start cold ${jobKind} target=${targetAppPath} ag=${job?.targetAntigravityVersion || '?'} commit=${job?.targetHakimiCommit || '?'}`
  );

  try {
    // 1. Wait for running 哈基米.app + language_server + sidecars zero-survivor exit barrier
    if (targetAppPath && options.skipStop !== true) {
      const stopRes = stopTargetAppProcesses(targetAppPath, commonOpts);
      if (!stopRes.ok) {
        appendUpgradeLog(stateDir, `stop failed: ${stopRes.error}`);
        const mainAlive = options.findPidsImpl
          ? options.findPidsImpl('main').length > 0
          : findRunningTargetPids(targetAppPath, 'main', commonOpts).length > 0;
        return finalize({ ok: false, error: stopRes.error }, { suppressRelaunch: mainAlive });
      }
      cleanupStaleSingletonLockDir(userDataDir, options.killImpl || process.kill);
    }

    // 2. Atomic same-volume bundle swap with automatic `.prev` rollback
    const swapRes = swapStagedBundleAtomically(
      {
        targetAppPath,
        stagedAppPath,
        prevBackupPath: job?.prevBackupPath || '',
      },
      options
    );

    // 3. Promote verified clean-base zip to single slot & clear older zips
    let cleanBaseRes = { promoted: false };
    try {
      if (job?.cleanBasePromotion) {
        cleanBaseRes = promoteSingleSlotCleanBase(job.cleanBasePromotion, commonOpts);
      }
    } catch (cbErr) {
      appendUpgradeLog(stateDir, `clean-base promotion warning: ${cbErr?.message || String(cbErr)}`);
    }

    // 4. Immediately clean staging root dir and clear staged state in updater/state.json
    if (stagingRootDir && fs.existsSync(stagingRootDir)) {
      rmDirSafe(stagingRootDir);
    }
    if (job?.updaterStatePath) {
      const st = readJsonFileSafe(job.updaterStatePath, null);
      if (st.ok && st.data && typeof st.data === 'object') {
        const nextState = {
          ...st.data,
          staged: null,
          incompatible: null,
          lastSwappedAt: new Date().toISOString(),
        };
        writeJsonFileAtomic(job.updaterStatePath, nextState, 0o600);
      }
    }

    appendUpgradeLog(stateDir, `swap success -> ${targetAppPath}`);
    return finalize({
      ok: true,
      swapped: true,
      cleanedPrev: swapRes.cleanedPrev,
      cleanBasePromoted: cleanBaseRes.promoted,
    });
  } catch (err) {
    const errMsg = err?.message || '更新替换过程发生异常';
    appendUpgradeLog(stateDir, `error: ${errMsg}`);
    return finalize({ ok: false, error: errMsg, rolledBack: Boolean(err?.rolledBack) });
  }
}

function runCli(argv = process.argv.slice(2)) {
  const jobIdx = argv.indexOf('--job');
  const jobPath = jobIdx >= 0 ? argv[jobIdx + 1] : '';
  if (!jobPath || !fs.existsSync(jobPath)) {
    process.exitCode = 1;
    return;
  }
  const readRes = readJsonFileSafe(jobPath, null);
  unlinkIfExists(jobPath);
  if (!readRes.ok || !readRes.data) {
    process.exitCode = 1;
    return;
  }
  const res = executeColdUpgradeJob(readRes.data);
  if (!res.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  UPGRADE_HELPER_FILE_NAME,
  UPGRADE_LOCK_FILE_NAME,
  UPGRADE_RESULT_FILE_NAME,
  UPGRADE_LOG_FILE_NAME,
  RELAUNCH_STRIP_ENV_KEYS,
  getDefaultStateDir,
  getDefaultUserDataDir,
  isOfficialAntigravityBundle,
  assertNotOfficialBundle,
  getRuntimeDir,
  getUpgradeLockPath,
  getUpgradeResultPath,
  readJsonFileSafe,
  writeJsonFileAtomic,
  unlinkIfExists,
  rmDirSafe,
  findRunningTargetPids,
  stopTargetAppProcesses,
  cleanupStaleSingletonLockDir,
  acquireUpgradeLock,
  releaseUpgradeLock,
  buildCleanRelaunchEnv,
  relaunchTargetApp,
  verifyStagedBundleReady,
  moveBundleSameVolumeSafe,
  swapStagedBundleAtomically,
  promoteSingleSlotCleanBase,
  executeColdUpgradeJob,
};
