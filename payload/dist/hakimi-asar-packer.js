'use strict';

/**
 * Self-contained Hakimi ASAR packer shared by:
 * - `scripts/pack-hakimi-asar.js` (CLI & repo builds)
 * - `payload/dist/hakimi-builder.js` (in-app self-update stage builds)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assertNotOfficialAntigravityApp,
  readAsarHeader,
  computeAsarHeaderSha256,
  builtinAsar,
} = require('./asar-engine');

const {
  WINDOW_LOAD_ANCHOR_RE,
  validateSyntax,
  generateMeterUtilsCode,
  generateMeterPreloadCode,
  generateMarkdownPreloadCode,
  generateChinesePreloadCode,
  generateUpdaterWrapperSource,
  isUpdaterWrappedSource,
  cleanUtilsSource,
  cleanPreloadSource,
  cleanSshBootstrapSource,
  injectSshBootstrapSource,
  cleanRemoteManagerSource,
  injectRemoteManagerSource,
  verifyCleanStructure,
} = require('./modular-installer');

const {
  DEFAULT_CONFIG,
  normalizeClientLanguage,
  getModulesConfigPath,
  loadModulesConfig,
  saveModulesConfig,
  inspectDiskModules,
} = require('./modules-config');

const PAYLOAD_FILES = [
  'asar-engine.js',
  'binary-utils.js',
  'hakimi-asar-packer.js',
  'hakimi-builder.js',
  'hakimi-icon-manager.js',
  'hakimi-upgrade-helper.js',
  'hakimi-updater.js',
  'local-api.js',
  'meter-account-cold-helper.js',
  'meter-account-switcher.js',
  'meter-cli-unlock.js',
  'meter-collector.js',
  'meter-core.js',
  'meter-enhance.js',
  'meter-main.js',
  'meter-region-unlock.js',
  'meter-renderer.js',
  'meter-ssh.js',
  'meter-storage.js',
  'modular-installer.js',
  'modules-config.js',
  path.join('i18n', 'zh-CN.json'),
  path.join('i18n', 'i18n-runtime.js'),
];

function replaceUniqueExact(source, search, replacement, label) {
  const parts = source.split(search);
  if (parts.length !== 2) {
    throw new Error(`Expected exact unique anchor for ${label} (matches=${parts.length - 1})`);
  }
  return parts[0] + replacement + parts[1];
}

function replaceUniqueRegex(source, regex, replacer, label) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const globalRe = new RegExp(regex.source, flags);
  const matches = source.match(globalRe);
  if (!matches || matches.length !== 1) {
    throw new Error(`Expected unique regex anchor for ${label} (matches=${matches ? matches.length : 0})`);
  }
  return source.replace(regex, replacer);
}

function collectAsarEntries(node, prefix = '', dirs = new Set(), files = new Map()) {
  if (!node || !node.files) return { dirs, files };
  for (const name of Object.keys(node.files)) {
    const child = node.files[name];
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child && child.files) {
      if (child.unpacked === true) {
        throw new Error(`Directory entry unexpectedly marked unpacked in dest ASAR: ${rel}`);
      }
      dirs.add(rel);
      collectAsarEntries(child, rel, dirs, files);
    } else {
      files.set(rel, child || {});
    }
  }
  return { dirs, files };
}

function verifyHeaderMetadataPreserved(
  srcAsar,
  destAsar,
  skipFiles = new Set([
    'dist/utils.js',
    'dist/preload.js',
    'dist/updater.js',
    'dist/remote/bootstrapScript.js',
    'dist/remote/remoteManager.js',
  ])
) {
  const srcParsed = readAsarHeader(srcAsar);
  const destParsed = readAsarHeader(destAsar);

  const srcCollected = collectAsarEntries(srcParsed.header);
  const destCollected = collectAsarEntries(destParsed.header);

  for (const [rel, srcNode] of srcCollected.files.entries()) {
    const destNode = destCollected.files.get(rel);
    if (!destNode) {
      throw new Error(`Missing source file in packed ASAR: ${rel}`);
    }
    if (skipFiles.has(rel)) {
      continue;
    }
    if (srcNode.link) {
      if (destNode.link !== srcNode.link) {
        throw new Error(`Symlink mismatch for ${rel}: expected ${srcNode.link}, got ${destNode.link}`);
      }
      continue;
    }
    if (Boolean(destNode.unpacked) !== Boolean(srcNode.unpacked)) {
      throw new Error(
        `Unpacked flag mismatch for ${rel}: expected ${Boolean(srcNode.unpacked)}, got ${Boolean(destNode.unpacked)}`
      );
    }
    if (Boolean(destNode.executable) !== Boolean(srcNode.executable)) {
      throw new Error(
        `Executable flag mismatch for ${rel}: expected ${Boolean(srcNode.executable)}, got ${Boolean(destNode.executable)}`
      );
    }
  }
}

function packHakimiAsar(rawOpts = {}) {
  const srcAsar = path.resolve(String(rawOpts.srcAsar || ''));
  const destAsar = path.resolve(String(rawOpts.destAsar || ''));
  const payloadDistDir = rawOpts.payloadDistDir
    ? path.resolve(String(rawOpts.payloadDistDir))
    : __dirname;

  if (!srcAsar || !fs.existsSync(srcAsar)) {
    throw new Error(`Source ASAR not found: ${srcAsar}`);
  }
  assertNotOfficialAntigravityApp(destAsar, 'pack ASAR');

  const hasExplicitLang = Boolean(rawOpts.hasExplicitLang);
  const clientLang = rawOpts.clientLang || 'zh-CN';
  const forceConfig = Boolean(rawOpts.forceConfig);
  const skipConfig = Boolean(rawOpts.skipConfig);

  const prevEnvStateDir = process.env.AG_METER_STATE_DIR;
  if (rawOpts.stateDir) {
    process.env.AG_METER_STATE_DIR = path.resolve(rawOpts.stateDir);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-asar-'));
  try {
    const srcHeader = readAsarHeader(srcAsar).header;
    const srcCollected = collectAsarEntries(srcHeader);
    const srcExecutablePaths = new Set();
    for (const [rel, node] of srcCollected.files.entries()) {
      if (node && node.executable) {
        srcExecutablePaths.add(rel);
      }
    }

    builtinAsar.extractAll(srcAsar, workDir);

    // 1. Clean & inject dist/utils.js
    const utilsPath = path.join(workDir, 'dist', 'utils.js');
    if (!fs.existsSync(utilsPath)) {
      throw new Error('Extracted ASAR missing dist/utils.js');
    }
    const rawUtils = fs.readFileSync(utilsPath, 'utf8');
    let utils = cleanUtilsSource(rawUtils);
    if (!verifyCleanStructure(utils)) {
      throw new Error('cleanUtilsSource failed verifyCleanStructure check on dist/utils.js');
    }

    const hooks = generateMeterUtilsCode();
    utils = replaceUniqueRegex(
      utils,
      /function createWindow\([^)]*\)\s*\{/,
      (m) => m + hooks.storageFallback,
      'createWindow'
    );
    utils = replaceUniqueRegex(
      utils,
      WINDOW_LOAD_ANCHOR_RE,
      (m) => `${hooks.windowLoadHook}${m}`,
      'win.loadURL/loadHubWindowUrl'
    );
    utils = replaceUniqueExact(
      utils,
      '        wins[0].focus();',
      `        wins[0].focus();${hooks.focusHook}`,
      'wins[0].focus'
    );
    utils = replaceUniqueExact(
      utils,
      '        createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);',
      `        const _mWin = createWindow(\`\${constants_1.WINDOW_ORIGIN}:\${port}/\`);${hooks.createHook}`,
      'showOrCreateWindow'
    );

    if (!validateSyntax(utils, 'dist/utils.js')) {
      throw new Error('Syntax validation failed for injected dist/utils.js');
    }
    if (!verifyCleanStructure(cleanUtilsSource(utils))) {
      throw new Error('Round-trip cleanUtilsSource failed verifyCleanStructure check');
    }
    fs.writeFileSync(utilsPath, utils, 'utf8');

    // 2. Clean & inject dist/preload.js
    const preloadPath = path.join(workDir, 'dist', 'preload.js');
    if (!fs.existsSync(preloadPath)) {
      throw new Error('Extracted ASAR missing dist/preload.js');
    }
    const rawPreload = fs.readFileSync(preloadPath, 'utf8');
    let preload = cleanPreloadSource(rawPreload);
    const dictContent = fs.readFileSync(path.join(payloadDistDir, 'i18n', 'zh-CN.json'), 'utf8');
    const parsedDict = JSON.parse(dictContent);
    if (!parsedDict || typeof parsedDict !== 'object' || !parsedDict.exact || Object.keys(parsedDict.exact).length === 0) {
      throw new Error('i18n/zh-CN.json is empty or missing exact dictionary entries');
    }
    const runtimeContent = fs.readFileSync(path.join(payloadDistDir, 'i18n', 'i18n-runtime.js'), 'utf8');
    preload +=
      generateMeterPreloadCode() +
      generateMarkdownPreloadCode() +
      generateChinesePreloadCode(dictContent, runtimeContent);

    if (!validateSyntax(preload, 'dist/preload.js')) {
      throw new Error('Syntax validation failed for injected dist/preload.js');
    }
    if (!validateSyntax(cleanPreloadSource(preload), 'dist/preload.js (cleaned)')) {
      throw new Error('Syntax validation failed for round-trip cleaned dist/preload.js');
    }
    fs.writeFileSync(preloadPath, preload, 'utf8');

    // 2.5 Clean & inject Remote SSH hooks when present
    const sshBootstrapPath = path.join(workDir, 'dist', 'remote', 'bootstrapScript.js');
    if (fs.existsSync(sshBootstrapPath)) {
      const rawBootstrap = fs.readFileSync(sshBootstrapPath, 'utf8');
      const injectedBootstrap = injectSshBootstrapSource(rawBootstrap);
      if (!validateSyntax(injectedBootstrap, 'dist/remote/bootstrapScript.js')) {
        throw new Error('Syntax validation failed for injected dist/remote/bootstrapScript.js');
      }
      if (!validateSyntax(cleanSshBootstrapSource(injectedBootstrap), 'dist/remote/bootstrapScript.js (cleaned)')) {
        throw new Error('Syntax validation failed for round-trip cleaned dist/remote/bootstrapScript.js');
      }
      fs.writeFileSync(sshBootstrapPath, injectedBootstrap, 'utf8');
    }

    const remoteManagerPath = path.join(workDir, 'dist', 'remote', 'remoteManager.js');
    if (fs.existsSync(remoteManagerPath)) {
      const rawManager = fs.readFileSync(remoteManagerPath, 'utf8');
      const injectedManager = injectRemoteManagerSource(rawManager);
      if (!validateSyntax(injectedManager, 'dist/remote/remoteManager.js')) {
        throw new Error('Syntax validation failed for injected dist/remote/remoteManager.js');
      }
      if (!validateSyntax(cleanRemoteManagerSource(injectedManager), 'dist/remote/remoteManager.js (cleaned)')) {
        throw new Error('Syntax validation failed for round-trip cleaned dist/remote/remoteManager.js');
      }
      fs.writeFileSync(remoteManagerPath, injectedManager, 'utf8');
    }

    // 2.6 Module-boundary wrapper for dist/updater.js (disables Squirrel.Mac & hands over to hakimi-updater)
    const updaterPath = path.join(workDir, 'dist', 'updater.js');
    if (fs.existsSync(updaterPath)) {
      const rawUpdater = fs.readFileSync(updaterPath, 'utf8');
      const origBackupPath = path.join(workDir, 'dist', 'updater.orig.js');
      if (!isUpdaterWrappedSource(rawUpdater) && !fs.existsSync(origBackupPath)) {
        fs.writeFileSync(origBackupPath, rawUpdater, 'utf8');
      }
      const wrappedUpdater = generateUpdaterWrapperSource();
      if (!validateSyntax(wrappedUpdater, 'dist/updater.js')) {
        throw new Error('Syntax validation failed for wrapped dist/updater.js');
      }
      fs.writeFileSync(updaterPath, wrappedUpdater, 'utf8');
    }

    // 3. Copy payload files into workDir/dist (using Buffer read/write so virtual app.asar sources work reliably)
    for (const rel of PAYLOAD_FILES) {
      const srcFile = path.join(payloadDistDir, rel);
      if (!fs.existsSync(srcFile)) {
        throw new Error(`Missing payload file: ${srcFile}`);
      }
      const destFile = path.join(workDir, 'dist', rel);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      const buf = fs.readFileSync(srcFile);
      fs.writeFileSync(destFile, buf);

      if (rel.endsWith('.js')) {
        const jsCode = buf.toString('utf8');
        const cleanJs = jsCode.startsWith('#!') ? '//' + jsCode.slice(2) : jsCode;
        if (!validateSyntax(cleanJs, `dist/${rel}`)) {
          throw new Error(`Syntax validation failed for payload file: dist/${rel}`);
        }
      }
    }

    // 3.5 Optional custom Dock icon (512x512 PNG at app.asar root)
    if (rawOpts.iconPng) {
      const customIconPath = path.resolve(String(rawOpts.iconPng));
      if (!fs.existsSync(customIconPath) || !fs.statSync(customIconPath).isFile()) {
        throw new Error(`Custom icon PNG not found: ${rawOpts.iconPng}`);
      }
      const destIconPng = path.join(workDir, 'icon.png');
      fs.writeFileSync(destIconPng, fs.readFileSync(customIconPath));
      fs.chmodSync(destIconPng, 0o644);
    }

    // 4. Repack ASAR while preserving metadata without duplicating .unpacked
    builtinAsar.createPackageWithOptions(workDir, destAsar, {
      unpackDir: '**/chrome-devtools-mcp',
      skipUnpackedWrite: true,
      preserveExecutable: srcExecutablePaths,
    });

    verifyHeaderMetadataPreserved(srcAsar, destAsar);

    const inspect = inspectDiskModules(destAsar);
    if (
      !inspect.found ||
      !inspect.meterReady ||
      !inspect.markdownFixReady ||
      !inspect.chineseReady ||
      inspect.chineseStatus !== 'ready' ||
      (inspect.updaterSupported && !inspect.updaterReady)
    ) {
      throw new Error(`Packed ASAR failed inspectDiskModules check: ${JSON.stringify(inspect)}`);
    }

    const sha256 = computeAsarHeaderSha256(destAsar);
    if (rawOpts.hashOut) {
      const hashOutPath = path.resolve(rawOpts.hashOut);
      fs.mkdirSync(path.dirname(hashOutPath), { recursive: true });
      fs.writeFileSync(hashOutPath, `${sha256}\n`, 'utf8');
    }

    let configPath = null;
    if (!skipConfig) {
      configPath = getModulesConfigPath();
      const cfgExists = fs.existsSync(configPath);
      const cfg = cfgExists
        ? loadModulesConfig()
        : JSON.parse(JSON.stringify(DEFAULT_CONFIG));

      let dirty = !cfgExists || forceConfig;
      if (!cfgExists || forceConfig || hasExplicitLang) {
        cfg.modules.chinese.language = normalizeClientLanguage(clientLang);
        cfg.modules.chinese.enabled = cfg.modules.chinese.language !== 'en';
        dirty = true;
      }
      if (dirty) {
        cfg.modules.chinese.lastUpdated = new Date().toISOString();
        saveModulesConfig(cfg);
      }
    }

    return {
      ok: true,
      destAsar,
      sha256,
      inspect,
      configPath,
    };
  } finally {
    if (rawOpts.stateDir) {
      if (prevEnvStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
      else process.env.AG_METER_STATE_DIR = prevEnvStateDir;
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  PAYLOAD_FILES,
  packHakimiAsar,
  verifyHeaderMetadataPreserved,
};
