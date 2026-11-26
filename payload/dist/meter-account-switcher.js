'use strict';

/**
 * macOS Keychain Cold Account Switcher Orchestrator for 哈基米.app
 *
 * Security & Isolation Guarantees:
 * - Zero plaintext OAuth tokens on disk: saved credentials live strictly inside macOS
 *   Keychain (`antigravity-hakimi-accounts`); `account-profiles-v1.json` stores only
 *   non-sensitive metadata (`id`, `email`, `label`, `tierName`, timestamps, truncated fingerprint).
 * - Minimal in-memory secret exposure: status refreshes use metadata-only Keychain
 *   existence checks (`security find-generic-password` WITHOUT `-w`) instead of reading
 *   all saved plaintext tokens into memory.
 * - Strict cold switching: switching or preparing a new account runs pre-flight checks
 *   (including blocking if `agy` CLI is running), extracts and spawns the detached
 *   `meter-account-cold-helper.js` worker, and instructs Electron to quit cleanly.
 *   The helper waits until zero target processes survive, performs the atomic Keychain +
 *   account-residue swap (keeping `installation_id` and shared conversation history intact),
 *   and relaunches `哈基米.app` with a clean environment.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { getStateDir, getHakimiAppPath, assertNotOfficialAntigravityApp } = require('./asar-engine');
const coldHelper = require('./meter-account-cold-helper');

const {
  ACTIVE_KEYCHAIN_SERVICE,
  ACTIVE_KEYCHAIN_ACCOUNT,
  VAULT_KEYCHAIN_SERVICE,
  PROFILES_FILE_NAME,
  COLD_HELPER_FILE_NAME,
  COLD_LOG_FILE_NAME,
  isSupportedPlatform,
  getDefaultUserDataDir,
  isOfficialAntigravityBundle,
  shellEscapeForSecurity,
  createMacOsKeychainAdapter,
  createWindowsKeychainAdapter,
  createPlatformKeychainAdapter,
  computeTokenFingerprint,
  normalizeEmail,
  sanitizeProfileId,
  sanitizeDisplayLabel,
  sanitizeTierName,
  extractEmailHintFromSecret,
  extractTierHintFromSecret,
  readOnboardingStateFromAppStorage,
  readJsonFileSafe,
  writeJsonFileAtomic,
  getProfilesPath: getHelperProfilesPath,
  getRuntimeDir,
  getColdResultPath,
  loadProfilesRegistry: loadHelperProfilesRegistry,
  saveProfilesRegistry: saveHelperProfilesRegistry,
  findMatchingProfile,
  upsertProfileWithSecret,
  detectRunningAgyCliProcesses,
  cleanupAccountLocalResidue,
  executeColdAccountJob,
} = coldHelper;

function resolveStateDir(options = {}) {
  return options.stateDir ? path.resolve(options.stateDir) : getStateDir();
}

function getProfilesPath(options = {}) {
  return getHelperProfilesPath({ stateDir: resolveStateDir(options) });
}

function loadProfilesRegistry(options = {}) {
  return loadHelperProfilesRegistry({ stateDir: resolveStateDir(options) });
}

function saveProfilesRegistry(registry, options = {}) {
  return saveHelperProfilesRegistry(registry, { stateDir: resolveStateDir(options) });
}

function resolveKeychain(options = {}) {
  if (options.keychain && typeof options.keychain.get === 'function') {
    return options.keychain;
  }
  return createPlatformKeychainAdapter(options);
}

function ensureSupported(options = {}) {
  const plat = options.platform || process.platform;
  if (!isSupportedPlatform(plat)) {
    return {
      ok: false,
      supported: false,
      error: '账号快捷切换目前仅支持 macOS 系统钥匙串与 Windows 凭据管理器',
      profiles: [],
    };
  }
  return null;
}

function keychainHas(kc, service, account) {
  if (typeof kc.has === 'function') {
    return Boolean(kc.has(service, account));
  }
  return Boolean(kc.get(service, account));
}

function resolveTargetAppBundlePath(options = {}) {
  if (options.appBundlePath) {
    const p = path.resolve(String(options.appBundlePath));
    if (!options.allowOfficialForTest) {
      assertNotOfficialAntigravityApp(p, '账号冷切换重启目标');
    }
    return p;
  }
  // If running inside packaged Hakimi Electron main process:
  // macOS: <bundle>.app/Contents/MacOS/Antigravity -> <bundle>.app
  // Windows: <appDir>\Antigravity.exe -> <appDir>
  const execPath = options.execPath || process.execPath || '';
  if (execPath) {
    const resolvedExec = path.resolve(execPath);
    const macMatch = resolvedExec.replace(/\\/g, '/').match(/^(.+?\.app)\/Contents\/MacOS\/[^/]+$/);
    if (macMatch && macMatch[1]) {
      const detected = macMatch[1];
      if (!isOfficialAntigravityBundle(detected) || options.allowOfficialForTest) {
        return detected;
      }
    }
    if ((options.platform || process.platform) === 'win32' && resolvedExec.toLowerCase().endsWith('.exe')) {
      const dir = path.dirname(resolvedExec);
      if (
        fs.existsSync(path.join(dir, 'resources', 'app.asar')) &&
        (!isOfficialAntigravityBundle(dir) || options.allowOfficialForTest)
      ) {
        return dir;
      }
    }
  }
  const fallback = getHakimiAppPath();
  if (!options.allowOfficialForTest) {
    assertNotOfficialAntigravityApp(fallback, '账号冷切换重启目标');
  }
  return fallback;
}

function resolveNodeRuntime(options = {}) {
  if (options.nodeBin) {
    return { bin: String(options.nodeBin), envExtra: {} };
  }
  const plat = options.platform || process.platform;
  const pathEnv = String(process.env.PATH || '');
  const candidates = plat === 'win32'
    ? []
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node'];
  const nodeName = plat === 'win32' ? 'node.exe' : 'node';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, nodeName));
  }
  if (plat === 'win32' && process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { bin: candidate, envExtra: {} };
      }
    } catch {}
  }
  // Guaranteed fallback inside Electron: run Electron binary in Node mode
  return {
    bin: options.execPath || process.execPath,
    envExtra: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function readAndConsumeLastColdResult(options = {}) {
  const stateDir = resolveStateDir(options);
  const resPath = getColdResultPath({ stateDir });
  const readRes = readJsonFileSafe(resPath, null);
  if (!readRes.ok || !readRes.data) return null;
  if (options.consumeLastResult === true) {
    try {
      fs.unlinkSync(resPath);
    } catch {}
  }
  return readRes.data;
}

function getAccountsStatus(options = {}) {
  const unsupported = ensureSupported(options);
  if (unsupported) return unsupported;

  const stateDir = resolveStateDir(options);
  const kc = resolveKeychain(options);
  const registry = loadProfilesRegistry({ stateDir });

  // 1. Metadata-only active check first (avoids reading plaintext secret when live email matches)
  let hasActiveToken = false;
  try {
    hasActiveToken = keychainHas(kc, ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT);
  } catch (err) {
    return {
      ok: false,
      supported: true,
      error: err.message || '检查当前登录凭据失败',
      profiles: registry.profiles.map((p) => ({ ...p, isActive: false, vaultPresent: null })),
    };
  }

  let hintEmail = normalizeEmail(options.currentEmail);
  let hintTier = sanitizeTierName(options.currentTierName || '');
  let activeFingerprint = null;
  let activeProfile = hasActiveToken && hintEmail
    ? findMatchingProfile(registry.profiles, { currentEmail: hintEmail })
    : null;

  // Only read active slot secret once if needed to identify an unmapped/unlabelled active token
  if (hasActiveToken && (!hintEmail || !activeProfile)) {
    try {
      const activeSecret = kc.get(ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT);
      if (!activeSecret) {
        hasActiveToken = false;
      } else {
        activeFingerprint = computeTokenFingerprint(activeSecret);
        if (!hintEmail) hintEmail = extractEmailHintFromSecret(activeSecret);
        if (!hintTier) hintTier = extractTierHintFromSecret(activeSecret);
        activeProfile = findMatchingProfile(registry.profiles, {
          activeFingerprint,
          currentEmail: hintEmail,
        });
      }
    } catch (err) {
      return {
        ok: false,
        supported: true,
        error: err.message || '读取当前登录凭据失败',
        profiles: registry.profiles.map((p) => ({ ...p, isActive: false, vaultPresent: null })),
      };
    }
  }

  // Sync upgraded/more-specific live tier display name (e.g. Ultra 5x/20x) onto active saved profile
  const isMeaningfulTier = (v) => Boolean(v && v !== '未知' && v !== '未知套餐');
  if (activeProfile && isMeaningfulTier(hintTier) && activeProfile.tierName !== hintTier) {
    const idx = registry.profiles.findIndex((p) => p.id === activeProfile.id);
    if (idx >= 0) {
      registry.profiles[idx] = { ...registry.profiles[idx], tierName: hintTier };
      activeProfile = registry.profiles[idx];
      try {
        saveProfilesRegistry(registry, { stateDir });
      } catch {}
    }
  }

  // 2. Metadata-only Vault existence check (NO plaintext reads for saved profiles!)
  let vaultMap = null;
  if (typeof kc.hasMany === 'function' && registry.profiles.length > 0) {
    try {
      vaultMap = kc.hasMany(VAULT_KEYCHAIN_SERVICE, registry.profiles.map((p) => p.id));
    } catch {
      vaultMap = null;
    }
  }
  const profiles = registry.profiles.map((p) => {
    let vaultPresent = false;
    if (vaultMap && Object.prototype.hasOwnProperty.call(vaultMap, p.id)) {
      vaultPresent = Boolean(vaultMap[p.id]);
    } else {
      try {
        vaultPresent = keychainHas(kc, VAULT_KEYCHAIN_SERVICE, p.id);
      } catch {
        vaultPresent = false;
      }
    }
    const isActive = Boolean(activeProfile && activeProfile.id === p.id);
    return {
      ...p,
      isActive,
      vaultPresent,
    };
  });

  // 3. Detect running agy CLI processes that share ("gemini", "antigravity")
  const agyProcs = options.detectAgyCliImpl
    ? options.detectAgyCliImpl()
    : detectRunningAgyCliProcesses(options);
  const agyCliPids = Array.isArray(agyProcs) ? agyProcs.map((p) => p.pid) : [];

  const lastColdResult = readAndConsumeLastColdResult({
    stateDir,
    consumeLastResult: options.consumeLastResult === true,
  });

  return {
    ok: true,
    supported: true,
    hasActiveToken,
    activeFingerprint: activeFingerprint || activeProfile?.tokenFingerprint || null,
    activeEmail: hintEmail || activeProfile?.email || null,
    activeTierName: sanitizeTierName(hintTier || activeProfile?.tierName || ''),
    activeProfileId: activeProfile ? activeProfile.id : null,
    currentUnsaved: Boolean(hasActiveToken && !activeProfile),
    agyCliRunning: agyCliPids.length > 0,
    agyCliPids,
    lastColdResult,
    profiles,
  };
}

function saveCurrentAccount(payload = {}, options = {}) {
  const unsupported = ensureSupported(options);
  if (unsupported) return unsupported;

  const stateDir = resolveStateDir(options);
  const kc = resolveKeychain(options);
  const registry = loadProfilesRegistry({ stateDir });

  let activeSecret = null;
  try {
    activeSecret = kc.get(ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT);
  } catch (err) {
    return { ok: false, supported: true, error: err.message || '读取当前登录凭据失败' };
  }
  if (!activeSecret) {
    return { ok: false, supported: true, error: '当前未检测到已登录的账号凭据' };
  }

  try {
    const rawEmail = payload.email || payload.currentEmail || options.currentEmail || '';
    const normEmail = normalizeEmail(rawEmail) || extractEmailHintFromSecret(activeSecret);
    const userDataDir = options.userDataDir
      ? path.resolve(options.userDataDir)
      : getDefaultUserDataDir(process.platform, process.env, options.homeDir || os.homedir());
    const currentOnboarding = readOnboardingStateFromAppStorage(userDataDir);
    const onboardingMatches =
      Boolean(currentOnboarding.username) &&
      (!normEmail || normalizeEmail(currentOnboarding.username) === normEmail);
    const entry = upsertProfileWithSecret(registry, kc, activeSecret, {
      email: rawEmail,
      label: payload.label,
      tierName: payload.tierName || payload.currentTierName || options.currentTierName || '',
      ...(onboardingMatches
        ? {
            onboardingUsername: currentOnboarding.username,
            onboardingIsGcpTos: currentOnboarding.isGcpTos,
          }
        : {}),
    });
    const writeRes = saveProfilesRegistry(registry, { stateDir });
    if (!writeRes.ok) {
      return { ok: false, supported: true, error: writeRes.error || '保存账号列表元数据失败' };
    }
    return {
      ok: true,
      supported: true,
      profile: entry,
      status: getAccountsStatus({
        ...options,
        stateDir,
        currentEmail: entry.email,
        currentTierName: entry.tierName,
      }),
    };
  } catch (err) {
    return { ok: false, supported: true, error: err.message || '保存当前账号失败' };
  }
}

function checkAgyCliPreFlight(options = {}) {
  const agyProcs = options.detectAgyCliImpl
    ? options.detectAgyCliImpl()
    : detectRunningAgyCliProcesses(options);
  if (Array.isArray(agyProcs) && agyProcs.length > 0) {
    const pids = agyProcs.map((p) => p.pid);
    return {
      ok: false,
      supported: true,
      code: 'AGY_CLI_RUNNING',
      agyCliRunning: true,
      agyCliPids: pids,
      error: `检测到终端正在运行 agy CLI（PID: ${pids.join(', ')}），请先退出 agy 后再切换账号，避免并发抢写钥匙串`,
    };
  }
  return null;
}

function stageAndSpawnColdHelper(job, options = {}) {
  const stateDir = resolveStateDir(options);
  const runtimeDir = getRuntimeDir({ stateDir });
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const helperSrcPath = path.join(__dirname, 'meter-account-cold-helper.js');
  const stagedHelperPath = path.join(runtimeDir, COLD_HELPER_FILE_NAME);
  const helperCode = fs.readFileSync(helperSrcPath, 'utf8');
  fs.writeFileSync(stagedHelperPath, helperCode, { encoding: 'utf8', mode: 0o700 });

  const jobFilePath = path.join(runtimeDir, `cold-switch-job-${Date.now()}-${process.pid}.json`);
  const writeJob = writeJsonFileAtomic(jobFilePath, job, 0o600);
  if (!writeJob.ok) {
    throw new Error(writeJob.error || '写入冷切换任务清单失败');
  }

  const runtime = resolveNodeRuntime(options);
  const spawnImpl = options.spawnImpl || spawn;
  const logPath = path.join(runtimeDir, COLD_LOG_FILE_NAME);
  let logFd = 'ignore';
  try {
    logFd = fs.openSync(logPath, 'a', 0o600);
  } catch {
    logFd = 'ignore';
  }
  try {
    const child = spawnImpl(runtime.bin, [stagedHelperPath, '--job', jobFilePath], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...runtime.envExtra },
    });
    if (child && typeof child.unref === 'function') {
      child.unref();
    }
    return { ok: true, pid: child?.pid || null, stagedHelperPath, jobFilePath, runtimeBin: runtime.bin };
  } finally {
    if (typeof logFd === 'number') {
      try { fs.closeSync(logFd); } catch {}
    }
  }
}

/**
 * Initiate a strict cold account switch:
 * 1. Pre-flight validates platform, target profile, Vault presence (metadata-only), and no running `agy` CLI.
 * 2. Extracts & spawns detached `cold-switch-helper.js` (contains ZERO secrets in job JSON).
 * 3. Returns `{ ok: true, coldSwitching: true, ... }` so Electron main process immediately quits cleanly
 *    and lets the helper perform zero-survivor swap + clean relaunch.
 */
function startColdSwitchAccount(payload = {}, options = {}) {
  const unsupported = ensureSupported(options);
  if (unsupported) return unsupported;

  const agyBlocked = checkAgyCliPreFlight(options);
  if (agyBlocked) return agyBlocked;

  const targetId = sanitizeProfileId(payload.targetId || payload.id);
  if (!targetId) {
    return { ok: false, supported: true, error: '未指定目标账号' };
  }

  const stateDir = resolveStateDir(options);
  const kc = resolveKeychain(options);
  const registry = loadProfilesRegistry({ stateDir });
  const targetProfile = registry.profiles.find((p) => p.id === targetId);
  if (!targetProfile) {
    return { ok: false, supported: true, error: '未找到目标账号快照' };
  }

  try {
    if (!keychainHas(kc, VAULT_KEYCHAIN_SERVICE, targetId)) {
      return { ok: false, supported: true, error: '钥匙串中未找到目标账号的备份凭据，请重新登录后保存' };
    }
  } catch (err) {
    return { ok: false, supported: true, error: err.message || '检查目标账号钥匙串凭据失败' };
  }

  // Prevent no-op cold restart if already on target email
  const rawCurrentEmail = String(payload.currentEmail || options.currentEmail || '').trim();
  const currentEmail = normalizeEmail(rawCurrentEmail);
  if (currentEmail && (targetProfile.email === currentEmail || targetProfile.id === currentEmail)) {
    return { ok: false, supported: true, error: '当前已经登录该账号' };
  }

  let appBundlePath;
  try {
    appBundlePath = resolveTargetAppBundlePath(options);
  } catch (err) {
    return { ok: false, supported: true, error: err.message || '无法定位当前应用包路径' };
  }

  const homeDir = options.homeDir ? path.resolve(options.homeDir) : os.homedir();
  const userDataDir = options.userDataDir
    ? path.resolve(options.userDataDir)
    : getDefaultUserDataDir(process.platform, process.env, homeDir);
  const geminiDir = options.geminiDir
    ? path.resolve(options.geminiDir)
    : path.join(homeDir, '.gemini');

  const job = {
    action: 'switch',
    targetId,
    currentEmail: rawCurrentEmail || currentEmail,
    currentTierName: sanitizeTierName(payload.currentTierName || options.currentTierName || ''),
    appBundlePath,
    stateDir,
    userDataDir,
    geminiDir,
    homeDir,
    parentPid: process.pid,
    createdAt: new Date().toISOString(),
  };

  try {
    const spawned = stageAndSpawnColdHelper(job, { ...options, stateDir });
    return {
      ok: true,
      supported: true,
      coldSwitching: true,
      targetProfile,
      helperPid: spawned.pid,
      appBundlePath,
    };
  } catch (err) {
    return { ok: false, supported: true, error: err.message || '启动冷切换进程失败' };
  }
}

/**
 * Initiate a strict cold "Add New Account" flow:
 * 1. Pre-flight validates platform and blocks if `agy` CLI is running.
 * 2. Spawns detached helper to wait for zero-survivor exit, back up the outgoing active
 *    Keychain slot to Vault (without calling server-side AuthLogout), clear only the local
 *    active slot + account-scoped residue, and relaunch cleanly onto the official Google login screen.
 */
function startColdPrepareAddAccount(payload = {}, options = {}) {
  const unsupported = ensureSupported(options);
  if (unsupported) return unsupported;

  const agyBlocked = checkAgyCliPreFlight(options);
  if (agyBlocked) return agyBlocked;

  const stateDir = resolveStateDir(options);
  let appBundlePath;
  try {
    appBundlePath = resolveTargetAppBundlePath(options);
  } catch (err) {
    return { ok: false, supported: true, error: err.message || '无法定位当前应用包路径' };
  }

  const homeDir = options.homeDir ? path.resolve(options.homeDir) : os.homedir();
  const userDataDir = options.userDataDir
    ? path.resolve(options.userDataDir)
    : getDefaultUserDataDir(process.platform, process.env, homeDir);
  const geminiDir = options.geminiDir
    ? path.resolve(options.geminiDir)
    : path.join(homeDir, '.gemini');

  const job = {
    action: 'prepare-add',
    currentEmail: String(payload.currentEmail || options.currentEmail || '').trim(),
    currentTierName: sanitizeTierName(payload.currentTierName || options.currentTierName || ''),
    appBundlePath,
    stateDir,
    userDataDir,
    geminiDir,
    homeDir,
    parentPid: process.pid,
    createdAt: new Date().toISOString(),
  };

  try {
    const spawned = stageAndSpawnColdHelper(job, { ...options, stateDir });
    return {
      ok: true,
      supported: true,
      coldSwitching: true,
      helperPid: spawned.pid,
      appBundlePath,
    };
  } catch (err) {
    return { ok: false, supported: true, error: err.message || '启动新增账号冷切换进程失败' };
  }
}

function renameAccount(payload = {}, options = {}) {
  const unsupported = ensureSupported(options);
  if (unsupported) return unsupported;

  const targetId = sanitizeProfileId(payload.targetId || payload.id);
  if (!targetId) return { ok: false, supported: true, error: '未指定目标账号' };

  const stateDir = resolveStateDir(options);
  const registry = loadProfilesRegistry({ stateDir });
  const idx = registry.profiles.findIndex((p) => p.id === targetId);
  if (idx < 0) return { ok: false, supported: true, error: '未找到目标账号' };

  registry.profiles[idx] = {
    ...registry.profiles[idx],
    label: sanitizeDisplayLabel(payload.label || ''),
  };
  const writeRes = saveProfilesRegistry(registry, { stateDir });
  if (!writeRes.ok) {
    return { ok: false, supported: true, error: writeRes.error || '更新备注失败' };
  }
  return {
    ok: true,
    supported: true,
    profile: registry.profiles[idx],
    status: getAccountsStatus({ ...options, stateDir }),
  };
}

function removeAccount(payload = {}, options = {}) {
  const unsupported = ensureSupported(options);
  if (unsupported) return unsupported;

  const targetId = sanitizeProfileId(payload.targetId || payload.id);
  if (!targetId) return { ok: false, supported: true, error: '未指定要删除的账号' };

  const stateDir = resolveStateDir(options);
  const kc = resolveKeychain(options);
  const registry = loadProfilesRegistry({ stateDir });
  const exists = registry.profiles.some((p) => p.id === targetId);
  if (!exists) {
    return { ok: false, supported: true, error: '未找到该账号快照' };
  }

  try {
    // Only remove from Vault service; never touch active ("gemini", "antigravity") slot
    kc.delete(VAULT_KEYCHAIN_SERVICE, targetId);
  } catch (err) {
    return { ok: false, supported: true, error: err.message || '从钥匙串删除备份凭据失败' };
  }

  registry.profiles = registry.profiles.filter((p) => p.id !== targetId);
  const writeRes = saveProfilesRegistry(registry, { stateDir });
  if (!writeRes.ok) {
    return { ok: false, supported: true, error: writeRes.error || '更新账号列表失败' };
  }

  return {
    ok: true,
    supported: true,
    removedId: targetId,
    status: getAccountsStatus({ ...options, stateDir }),
  };
}

module.exports = {
  ACTIVE_KEYCHAIN_SERVICE,
  ACTIVE_KEYCHAIN_ACCOUNT,
  VAULT_KEYCHAIN_SERVICE,
  PROFILES_FILE_NAME,
  isSupportedPlatform,
  shellEscapeForSecurity,
  createMacOsKeychainAdapter,
  createWindowsKeychainAdapter,
  createPlatformKeychainAdapter,
  computeTokenFingerprint,
  extractEmailHintFromSecret,
  extractTierHintFromSecret,
  getProfilesPath,
  loadProfilesRegistry,
  saveProfilesRegistry,
  detectRunningAgyCliProcesses,
  cleanupAccountLocalResidue,
  resolveTargetAppBundlePath,
  resolveNodeRuntime,
  getAccountsStatus,
  saveCurrentAccount,
  startColdSwitchAccount,
  startColdPrepareAddAccount,
  executeColdAccountJob,
  renameAccount,
  removeAccount,
};
