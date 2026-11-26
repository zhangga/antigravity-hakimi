'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getStateDir,
  findAsarPath,
  builtinAsar,
  assertNotOfficialAntigravityApp,
  getHakimiAppPath,
  getDefaultOfficialAppPath,
  getAsarPathForApp,
} = require('./asar-engine');

const SCHEMA_VERSION = '0.8.3';
const PROJECT_VERSION = '0.8.3';

const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  modules: {
    meter: {
      enabled: true,
    },
    chinese: {
      enabled: true,
      language: 'zh-CN', // 'zh-CN' | 'en'
      desktopOnly: true,
      lastUpdated: null,
    },
  },
};

function normalizeClientLanguage(val, enabledHint) {
  const s = String(val || '').trim().toLowerCase();
  if (s === 'zh-cn' || s === 'zh' || s === 'zh-hans' || s === 'cn') return 'zh-CN';
  if (s === 'en' || s === 'english' || s === 'en-us') return 'en';
  if (enabledHint === false) return 'en';
  return 'zh-CN';
}

function getModulesConfigPath() {
  return path.join(getStateDir(), 'modules.json');
}

function loadModulesConfig() {
  const cfgPath = getModulesConfigPath();
  const current = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && parsed.modules) {
        current.modules.meter = Object.assign(
          {},
          DEFAULT_CONFIG.modules.meter,
          parsed.modules.meter || {}
        );
        const rawChinese = parsed.modules.chinese || {};
        current.modules.chinese = {
          enabled: true,
          language: normalizeClientLanguage(rawChinese.language, rawChinese.enabled),
          desktopOnly: true,
          lastUpdated: rawChinese.lastUpdated || null,
        };
        current.modules.chinese.enabled = current.modules.chinese.language === 'zh-CN';
        return current;
      }
    } catch {}
  }

  saveModulesConfig(current);
  return current;
}

function saveModulesConfig(cfg) {
  const cfgPath = getModulesConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const sanitized = {
    schemaVersion: SCHEMA_VERSION,
    modules: {
      meter: {
        enabled: cfg?.modules?.meter?.enabled !== false,
      },
      chinese: {
        enabled: cfg?.modules?.chinese?.enabled !== false && cfg?.modules?.chinese?.language !== 'en',
        language: normalizeClientLanguage(
          cfg?.modules?.chinese?.language,
          cfg?.modules?.chinese?.enabled
        ),
        desktopOnly: true,
        lastUpdated: cfg?.modules?.chinese?.lastUpdated || null,
      },
    },
  };
  const tmpPath = `${cfgPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(sanitized, null, 2), 'utf8');
  fs.renameSync(tmpPath, cfgPath);
  return sanitized;
}

async function acquireFileLock(lockName = 'modules-install.lock', timeoutMs = 15000) {
  const lockDir = path.join(getStateDir(), '.locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, lockName);
  const start = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        } catch {}
      };
    } catch (e) {
      if (e.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 60000) {
            try {
              fs.unlinkSync(lockFile);
              continue;
            } catch {}
          }
        } catch {}
        if (Date.now() - start > timeoutMs) {
          throw new Error(`无法获取模块安装互斥锁 (${lockFile})，可能存在另一安装进程正在执行`);
        }
        await new Promise((r) => setTimeout(r, 200));
      } else {
        throw e;
      }
    }
  }
}

function inspectDiskModules(customPath = null) {
  const { TAGS } = require('./modular-installer');
  let asarPath = null;
  try {
    if (customPath) assertNotOfficialAntigravityApp(customPath, 'inspect ASAR');
    asarPath = findAsarPath(customPath);
  } catch (e) {
    return {
      found: false,
      asarPath: null,
      meter: false,
      meterReady: false,
      chinese: false,
      chineseReady: false,
      chineseGate: false,
      chineseStatus: 'unknown',
      chineseReason: e.message,
    };
  }

  if (!asarPath || !fs.existsSync(asarPath)) {
    return {
      found: false,
      asarPath: null,
      meter: false,
      meterReady: false,
      chinese: false,
      chineseReady: false,
      chineseGate: false,
      chineseStatus: 'unknown',
      chineseReason: '未找到 哈基米.app app.asar',
    };
  }

  let utilsStr = '';
  let preloadStr = '';
  let entries = [];
  try {
    utilsStr = builtinAsar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
    preloadStr = builtinAsar.extractFile(asarPath, 'dist/preload.js').toString('utf8');
    entries = builtinAsar.listPackage(asarPath);
  } catch (e) {
    return {
      found: false,
      asarPath,
      meter: false,
      meterReady: false,
      chinese: false,
      chineseReady: false,
      chineseGate: false,
      chineseStatus: 'unknown',
      chineseReason: '读取或解构 ASAR 归档异常: ' + e.message,
    };
  }

  const meterInjected = utilsStr.includes(TAGS.METER_UTILS_START) || utilsStr.includes('installContextMeter');
  const meterPreload = preloadStr.includes(TAGS.METER_PRELOAD_START) || preloadStr.includes('contextMeterAPI');
  const meterFilesOk = entries.includes('/dist/meter-main.js') && entries.includes('/dist/meter-core.js');
  const meterReady = meterInjected && meterPreload && meterFilesOk;
  const markdownFixReady =
    preloadStr.includes(TAGS.MARKDOWN_PRELOAD_START) && preloadStr.includes(TAGS.MARKDOWN_PRELOAD_END);

  const chineseHasTags = preloadStr.includes(TAGS.CHINESE_START) && preloadStr.includes(TAGS.CHINESE_END);
  let chineseStatus = 'not_injected';
  let chineseReady = false;
  let chineseReason = null;

  if (!chineseHasTags) {
    chineseStatus = 'not_injected';
    chineseReady = false;
    chineseReason = '磁盘尚未注入汉化脚本代码';
  } else {
    const hasDictData =
      preloadStr.includes('__AGY_I18N_DATA__') &&
      (preloadStr.includes('_dictData') || preloadStr.includes('context-meter:get-i18n-dict-sync'));
    const hasRuntimeEngine =
      preloadStr.includes('createI18nEngine') ||
      preloadStr.includes('translateSingleUnit') ||
      preloadStr.includes('MutationObserver');
    const hasGateLogic =
      preloadStr.includes('chinese.enabled === false') && preloadStr.includes('modules.json');

    const dictMatch = preloadStr.match(/_dictData\s*=\s*(\{[\s\S]*?\});/);
    let dictNonEmpty = false;
    if (dictMatch && dictMatch[1]) {
      dictNonEmpty = dictMatch[1].length > 500 && dictMatch[1].includes('"');
    } else if (entries.includes('/dist/i18n/zh-CN.json')) {
      try {
        const externalDictBuf = builtinAsar.extractFile(asarPath, 'dist/i18n/zh-CN.json');
        dictNonEmpty = externalDictBuf.length > 500 && externalDictBuf.includes('"exact"');
      } catch {}
    }

    if (!hasDictData || !dictNonEmpty) {
      chineseStatus = 'missing_resources';
      chineseReady = false;
      chineseReason = '磁盘已注入汉化标记，但汉化词库字典数据缺失或为空，无法实际生效';
    } else if (!hasRuntimeEngine) {
      chineseStatus = 'missing_resources';
      chineseReady = false;
      chineseReason = '磁盘已注入汉化标记，但汉化运行时引擎核心执行逻辑缺失';
    } else if (!hasGateLogic) {
      chineseStatus = 'missing_gate';
      chineseReady = false;
      chineseReason = '磁盘汉化代码缺少运行时配置门禁或有效配置路径，无法安全动态切换';
    } else {
      chineseStatus = 'ready';
      chineseReady = true;
      chineseReason = null;
    }
  }

  let sshBootstrapInjected = false;
  let sshManagerInjected = false;
  let sshFilesOk = entries.includes('/dist/meter-ssh.js');
  try {
    if (entries.includes('/dist/remote/bootstrapScript.js')) {
      const bootStr = builtinAsar.extractFile(asarPath, 'dist/remote/bootstrapScript.js').toString('utf8');
      sshBootstrapInjected = bootStr.includes(TAGS.SSH_BOOTSTRAP_START) && bootStr.includes(TAGS.SSH_BOOTSTRAP_END);
    }
    if (entries.includes('/dist/remote/remoteManager.js')) {
      const mgrStr = builtinAsar.extractFile(asarPath, 'dist/remote/remoteManager.js').toString('utf8');
      sshManagerInjected = mgrStr.includes(TAGS.SSH_MANAGER_START) && mgrStr.includes(TAGS.SSH_MANAGER_END);
    }
  } catch {}
  const sshSupported = entries.includes('/dist/remote/bootstrapScript.js');
  const sshReady = sshSupported ? (sshBootstrapInjected && sshManagerInjected && sshFilesOk) : sshFilesOk;

  const updaterSupported = entries.includes('/dist/updater.js');
  let updaterWrapped = false;
  try {
    if (updaterSupported) {
      const updStr = builtinAsar.extractFile(asarPath, 'dist/updater.js').toString('utf8');
      updaterWrapped = updStr.includes(TAGS.UPDATER_WRAPPER_START) && updStr.includes(TAGS.UPDATER_WRAPPER_END);
    }
  } catch {}
  const updaterFilesOk =
    entries.includes('/dist/hakimi-updater.js') &&
    entries.includes('/dist/hakimi-builder.js') &&
    entries.includes('/dist/hakimi-upgrade-helper.js') &&
    entries.includes('/dist/hakimi-asar-packer.js');
  const updaterReady = updaterSupported ? (updaterWrapped && updaterFilesOk) : updaterFilesOk;

  return {
    found: true,
    asarPath,
    meter: meterInjected,
    meterReady,
    markdownFixReady,
    chinese: chineseHasTags,
    chineseReady,
    chineseGate: chineseStatus === 'ready',
    chineseStatus,
    chineseReason,
    sshSupported,
    sshReady,
    updaterSupported,
    updaterReady,
  };
}

function readBundleShortVersion(plistPath) {
  if (!plistPath) return null;
  try {
    if (!fs.existsSync(plistPath)) return null;
    const xml = fs.readFileSync(plistPath, 'utf8');
    const m = xml.match(/<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function compareBundleSemver(a, b) {
  const parse = (raw) => {
    const clean = String(raw || '').trim().replace(/^v/i, '');
    if (!clean) return { nums: [], pre: '' };
    const [core, ...preParts] = clean.split('-');
    const nums = core.split('.').map((n) => {
      const v = Number.parseInt(n, 10);
      return Number.isFinite(v) ? v : 0;
    });
    return { nums, pre: preParts.join('-') };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] || 0;
    const nb = pb.nums[i] || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

function readAppVersion(appPathOrPlist) {
  if (!appPathOrPlist) return null;
  const target = String(appPathOrPlist);
  try {
    if (target.toLowerCase().endsWith('.plist')) {
      return readBundleShortVersion(target);
    }
    if (!fs.existsSync(target)) return null;
    const st = fs.statSync(target);
    if (st.isFile()) {
      if (target.toLowerCase().endsWith('.asar')) {
        const pkg = JSON.parse(builtinAsar.extractFile(target, 'package.json').toString('utf8'));
        return pkg?.version ? String(pkg.version).trim() : null;
      }
      if (target.toLowerCase().endsWith('.json')) {
        const meta = JSON.parse(fs.readFileSync(target, 'utf8'));
        const ver = meta?.antigravityVersion || meta?.version;
        return ver ? String(ver).trim() : null;
      }
      return readBundleShortVersion(target);
    }
    // Directory: check macOS Info.plist first, then Windows/Linux app.asar package.json, then build meta
    const plistPath = path.join(target, 'Contents', 'Info.plist');
    if (fs.existsSync(plistPath)) {
      const v = readBundleShortVersion(plistPath);
      if (v) return v;
    }
    const asarCandidates = [
      getAsarPathForApp(target),
      path.join(target, 'resources', 'app.asar'),
      path.join(target, 'Contents', 'Resources', 'app.asar'),
    ];
    for (const asarFile of asarCandidates) {
      if (fs.existsSync(asarFile)) {
        try {
          const pkg = JSON.parse(builtinAsar.extractFile(asarFile, 'package.json').toString('utf8'));
          if (pkg?.version) return String(pkg.version).trim();
        } catch {}
      }
    }
    const metaCandidates = [
      path.join(target, 'resources', 'hakimi-build-meta.json'),
      path.join(target, 'Contents', 'Resources', 'hakimi-build-meta.json'),
    ];
    for (const metaFile of metaCandidates) {
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          if (meta?.antigravityVersion) return String(meta.antigravityVersion).trim();
        } catch {}
      }
    }
    return null;
  } catch {
    return null;
  }
}

function checkAppVersionSync(options = {}) {
  let officialVersion = null;
  let hakimiVersion = null;

  if (options.officialPlist || options.hakimiPlist) {
    const officialPlist =
      options.officialPlist ||
      (fs.existsSync('/Applications/Antigravity.app.orig/Contents/Info.plist')
        ? '/Applications/Antigravity.app.orig/Contents/Info.plist'
        : '/Applications/Antigravity.app/Contents/Info.plist');
    const hakimiPlist =
      options.hakimiPlist || path.join(getHakimiAppPath(), 'Contents', 'Info.plist');
    officialVersion = readBundleShortVersion(officialPlist);
    hakimiVersion = readBundleShortVersion(hakimiPlist);
  } else if (process.platform === 'darwin' && !options.officialApp && !options.hakimiApp) {
    const officialPlist = fs.existsSync('/Applications/Antigravity.app.orig/Contents/Info.plist')
      ? '/Applications/Antigravity.app.orig/Contents/Info.plist'
      : '/Applications/Antigravity.app/Contents/Info.plist';
    const hakimiPlist = path.join(getHakimiAppPath(), 'Contents', 'Info.plist');
    officialVersion = readBundleShortVersion(officialPlist);
    hakimiVersion = readBundleShortVersion(hakimiPlist);
  } else {
    const officialApp = options.officialApp || getDefaultOfficialAppPath();
    const hakimiApp = options.hakimiApp || getHakimiAppPath();
    officialVersion = readAppVersion(officialApp);
    hakimiVersion = readAppVersion(hakimiApp);
  }

  const cmp = officialVersion && hakimiVersion ? compareBundleSemver(officialVersion, hakimiVersion) : 0;

  return {
    officialVersion,
    hakimiVersion,
    outdated: Boolean(officialVersion && hakimiVersion && cmp > 0),
    hakimiAhead: Boolean(officialVersion && hakimiVersion && cmp < 0),
  };
}

function getDefaultUserDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Antigravity');
}

function cleanupStaleSingletonLock(userDataDir) {
  const dir = userDataDir ? path.resolve(String(userDataDir)) : getDefaultUserDataDir();
  if (process.platform === 'win32') {
    // On Windows, Chromium uses an OS-locked `lockfile` in userDataDir.
    // Unlinking fails with EBUSY/EPERM while any owning process is alive.
    const winLockPath = path.join(dir, 'lockfile');
    if (!fs.existsSync(winLockPath)) {
      return { cleaned: false, reason: 'no_lock', dir };
    }
    try {
      fs.unlinkSync(winLockPath);
      return { cleaned: true, pid: null, dir };
    } catch (err) {
      if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
        return { cleaned: false, reason: 'owner_alive', dir };
      }
      return { cleaned: false, reason: 'unreadable_lock', dir };
    }
  }
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
  if (!match) {
    return { cleaned: false, reason: 'unrecognized_target', target, dir };
  }
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { cleaned: false, reason: 'unrecognized_target', target, dir };
  }
  try {
    process.kill(pid, 0);
    return { cleaned: false, reason: 'owner_alive', pid, dir };
  } catch (err) {
    if (!err || err.code !== 'ESRCH') {
      return { cleaned: false, reason: 'owner_alive', pid, dir };
    }
  }
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {}
  }
  return { cleaned: true, pid, dir };
}

module.exports = {
  SCHEMA_VERSION,
  PROJECT_VERSION,
  DEFAULT_CONFIG,
  normalizeClientLanguage,
  getModulesConfigPath,
  loadModulesConfig,
  saveModulesConfig,
  acquireFileLock,
  inspectDiskModules,
  readBundleShortVersion,
  readAppVersion,
  compareBundleSemver,
  checkAppVersionSync,
  getDefaultUserDataDir,
  cleanupStaleSingletonLock,
};
