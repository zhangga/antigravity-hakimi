'use strict';

/**
 * Dual-source silent background updater & module-boundary bridge for `dist/updater.js`.
 *
 * Replaces official Squirrel.Mac auto-updater inside `哈基米.app`:
 * - Completely disables Squirrel.Mac (eliminating hourly ad-hoc signature mismatch errors
 *   and preventing accidental overwrite with unpatched official `Antigravity.app`).
 * - Polls BOTH official Antigravity (`app-update.yml` -> `latest-arm64-mac.yml`) AND
 *   Hakimi GitHub `main` (`cli117/antigravity-hakimi`, with `compare/<sha>...main`
 *   developer local-commit protection).
 * - Runs full sandbox stage-builds silently in a background Node worker (`ELECTRON_RUN_AS_NODE=1`)
 *   and ONLY surfaces a topbar ready prompt once every patch, integrity hash, and strict
 *   macOS codesign check passes.
 * - Keeps failed builds silent on the topbar while preserving structured diagnostics in
 *   Settings and cleaning up failed downloads / tarballs / staging dirs immediately.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const asarEngine = require('./asar-engine');
const builder = require('./hakimi-builder');
const upgradeHelper = require('./hakimi-upgrade-helper');

const INITIAL_CHECK_DELAY_MS = 12000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const UPDATER_CHANGED_CHANNEL = 'context-meter:hakimi-upgrade-changed';

const MenuUpdateStep = {
  CheckForUpdates: 'Check for Updates',
  CheckingForUpdates: 'Checking for Updates...',
  DownloadingUpdate: 'Downloading Update...',
  RestartToUpdate: 'Restart to Update',
};

function resolveElectron() {
  try {
    const mod = require('electron');
    if (mod && typeof mod === 'object') return mod;
  } catch {}
  return null;
}

function resolveCurrentBundlePath(options = {}) {
  if (options.targetAppPath) {
    const p = path.resolve(String(options.targetAppPath));
    if (!options.allowOfficialForTest) {
      asarEngine.assertNotOfficialAntigravityApp(p, '哈基米自更新目标');
    }
    return p;
  }
  const execPath = options.execPath || process.execPath || '';
  if (execPath) {
    const resolvedExec = path.resolve(execPath);
    const m = resolvedExec.replace(/\\/g, '/').match(/^(.+?\.app)\/Contents\/MacOS\/[^/]+$/);
    if (m && m[1]) {
      if (!asarEngine.isOfficialAntigravityPath(m[1]) || options.allowOfficialForTest) {
        return m[1];
      }
    }
    if (process.platform === 'win32' && resolvedExec.toLowerCase().endsWith('.exe')) {
      const dir = path.dirname(resolvedExec);
      if (
        fs.existsSync(path.join(dir, 'resources', 'app.asar')) &&
        (!asarEngine.isOfficialAntigravityPath(dir) || options.allowOfficialForTest)
      ) {
        return dir;
      }
    }
  }
  const fallback = asarEngine.getHakimiAppPath();
  if (!options.allowOfficialForTest) {
    asarEngine.assertNotOfficialAntigravityApp(fallback, '哈基米自更新目标');
  }
  return fallback;
}

function resolveWorkerRuntime(options = {}) {
  if (options.nodeBin) {
    return { bin: String(options.nodeBin), envExtra: options.nodeEnvExtra || {} };
  }
  // Prefer Electron's own embedded Node runtime (`ELECTRON_RUN_AS_NODE=1`) so we NEVER
  // depend on Homebrew / system `node` and can read scripts from `app.asar` when needed.
  if (process.versions && process.versions.electron) {
    return {
      bin: options.execPath || process.execPath,
      envExtra: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return {
    bin: options.execPath || process.execPath,
    envExtra: {},
  };
}

function runStageBuildInChildWorker(spec, options = {}) {
  if (typeof options.stageBuildImpl === 'function') {
    return Promise.resolve(options.stageBuildImpl(spec, options));
  }
  const workerScript =
    spec.patcherRoot && fs.existsSync(path.join(spec.patcherRoot, 'payload', 'dist', 'hakimi-builder.js'))
      ? path.join(spec.patcherRoot, 'payload', 'dist', 'hakimi-builder.js')
      : path.join(__dirname, 'hakimi-builder.js');

  const scratchDir = path.dirname(path.resolve(spec.stageDir));
  fs.mkdirSync(scratchDir, { recursive: true });
  const specPath = path.join(scratchDir, `stage-spec-${Date.now()}-${process.pid}.json`);
  const resultPath = path.join(scratchDir, `stage-result-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

  const runtime = resolveWorkerRuntime(options);
  const spawnImpl = options.spawnImpl || spawn;

  return new Promise((resolve) => {
    let stderr = '';
    const child = spawnImpl(
      runtime.bin,
      [workerScript, 'stage-build', '--spec', specPath, '--result-out', resultPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...runtime.envExtra },
      }
    );

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, options.stageBuildTimeoutMs || 180000);
    if (typeof timer.unref === 'function') timer.unref();

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '').slice(0, 2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      upgradeHelper.unlinkIfExists(specPath);
      upgradeHelper.unlinkIfExists(resultPath);
      resolve({ ok: false, failedStage: 'worker-spawn', error: err?.message || String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        if (fs.existsSync(resultPath)) {
          parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        }
      } catch {}
      upgradeHelper.unlinkIfExists(specPath);
      upgradeHelper.unlinkIfExists(resultPath);
      if (parsed && typeof parsed === 'object') {
        resolve(parsed);
      } else {
        resolve({
          ok: false,
          failedStage: 'worker-exit',
          error: (stderr || '').trim() || `沙盒构建子进程异常退出 (code=${code})`,
        });
      }
    });
  });
}

function createHakimiUpdater(defaultOptions = {}) {
  let initialized = false;
  let periodicTimer = null;
  let initialTimer = null;
  let inFlightCheck = null;
  let coldInstallInFlight = false;
  let autoCheckEnabled = true;
  let livePhase = 'idle'; // 'idle' | 'checking' | 'staging'
  let lastRuntimeError = null;
  let lastLatestOfficial = null;
  let lastLatestHakimi = null;
  let lastCheckedAt = null;
  const listeners = new Set();

  const getOpts = (override = {}) => ({ ...defaultOptions, ...override });

  function getPersistedState(opts = {}) {
    const paths = builder.getUpdaterPaths(opts);
    const readRes = upgradeHelper.readJsonFileSafe(paths.statePath, null);
    if (readRes.ok && readRes.data && typeof readRes.data === 'object') {
      return readRes.data;
    }
    return {
      schemaVersion: 1,
      staged: null,
      incompatible: null,
      lastCheckedAt: null,
      lastSwappedAt: null,
    };
  }

  function savePersistedState(nextState, opts = {}) {
    const paths = builder.getUpdaterPaths(opts);
    upgradeHelper.writeJsonFileAtomic(paths.statePath, nextState, 0o600);
  }

  function isValidStagedEntry(staged, installed) {
    if (!staged || !staged.stagedAppPath || !fs.existsSync(staged.stagedAppPath)) return false;
    const sameAg =
      Boolean(installed?.antigravityVersion) &&
      staged.targetAntigravityVersion === installed.antigravityVersion;
    const sameCommit =
      !staged.targetHakimiCommit ||
      (installed?.hakimiCommit &&
        staged.targetHakimiCommit.toLowerCase() === installed.hakimiCommit.toLowerCase());
    if (sameAg && sameCommit) return false;
    return true;
  }

  function buildStatusSnapshot(override = {}) {
    const opts = getOpts(override);
    const supported = (opts.platform || process.platform) === 'darwin';
    const paths = builder.getUpdaterPaths(opts);
    let targetAppPath = '';
    try {
      targetAppPath = resolveCurrentBundlePath(opts);
    } catch {
      targetAppPath = '';
    }
    const installed = opts.installedMeta || (targetAppPath ? builder.readInstalledBuildMeta(targetAppPath) : null);
    const persisted = getPersistedState(opts);
    const validStaged = isValidStagedEntry(persisted.staged, installed) ? persisted.staged : null;
    const cleanBase = builder.readCleanBaseMeta(paths.cleanBaseDir);
    const lastUpgradeResultRes = upgradeHelper.readJsonFileSafe(
      upgradeHelper.getUpgradeResultPath({ stateDir: paths.stateDir }),
      null
    );
    const lastUpgradeResult = lastUpgradeResultRes.ok ? lastUpgradeResultRes.data : null;

    let status = 'idle';
    if (!supported) {
      status = 'unsupported';
    } else if (validStaged) {
      status = 'ready';
    } else if (livePhase === 'checking' || livePhase === 'staging') {
      status = livePhase;
    } else if (persisted.incompatible) {
      status = 'incompatible';
    } else if (
      lastLatestHakimi &&
      ['local_unpushed', 'local_ahead', 'diverged'].includes(lastLatestHakimi.status)
    ) {
      status = 'local_dev';
    } else if (lastRuntimeError) {
      status = 'error';
    }

    return {
      ok: true,
      supported,
      status,
      ready: status === 'ready',
      busy: livePhase === 'checking' || livePhase === 'staging',
      coldInstalling: coldInstallInFlight,
      installed,
      latestOfficial: lastLatestOfficial,
      latestHakimi: lastLatestHakimi,
      staged: validStaged
        ? {
            targetAntigravityVersion: validStaged.targetAntigravityVersion,
            targetHakimiVersion: validStaged.targetHakimiVersion || null,
            targetHakimiCommit: validStaged.targetHakimiCommit || null,
            targetHakimiCommitShort:
              validStaged.targetHakimiCommitShort ||
              (validStaged.targetHakimiCommit ? validStaged.targetHakimiCommit.slice(0, 7) : null),
            antigravityChanged: Boolean(validStaged.antigravityChanged),
            hakimiChanged: Boolean(validStaged.hakimiChanged),
            usingCustomIcon: Boolean(validStaged.usingCustomIcon),
            builtAt: validStaged.builtAt || null,
          }
        : null,
      incompatible: persisted.incompatible || null,
      cleanBaseCache: cleanBase
        ? { version: cleanBase.version, fileName: cleanBase.fileName }
        : null,
      lastCheckedAt: lastCheckedAt || persisted.lastCheckedAt || null,
      lastError: lastRuntimeError,
      lastUpgradeResult,
    };
  }

  function updateNativeMenuState(snapshot) {
    const electron = resolveElectron();
    if (!electron?.Menu || typeof electron.Menu.getApplicationMenu !== 'function') return;
    try {
      const menu = electron.Menu.getApplicationMenu();
      const item = menu?.getMenuItemById?.('check-for-updates');
      if (!item) return;
      if (snapshot.status === 'ready') {
        item.label = MenuUpdateStep.RestartToUpdate;
        item.enabled = true;
      } else if (snapshot.busy) {
        item.label = MenuUpdateStep.CheckingForUpdates;
        item.enabled = false;
      } else {
        item.label = MenuUpdateStep.CheckForUpdates;
        item.enabled = true;
      }
    } catch {}
  }

  function notifyStatusChange(override = {}) {
    const snap = buildStatusSnapshot(override);
    updateNativeMenuState(snap);

    for (const fn of listeners) {
      try { fn(snap); } catch {}
    }

    // Broadcast to local (non-SSH) Hub windows via dedicated Hakimi IPC channel
    try {
      const utils = require('./utils');
      const ssh = require('./meter-ssh');
      const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
      for (const win of wins) {
        if (!win || win.isDestroyed?.()) continue;
        if (ssh.getRemoteBackendForWindow(win)) continue;
        const wc = typeof utils.getHubWebContents === 'function' ? utils.getHubWebContents(win) : win.webContents;
        if (wc && !wc.isDestroyed?.() && !ssh.getRemoteBackendForSender(wc)) {
          wc.send(UPDATER_CHANGED_CHANNEL, snap);
        }
      }
    } catch {}

    return snap;
  }

  /**
   * Resolve a verified clean official Antigravity.app source for `targetAgVer`.
   * Returns `{ sourceAppPath, downloadedZipPath, sha512, sourceKind }`.
   */
  async function prepareCleanOfficialSource({
    targetAgVer,
    officialManifest,
    targetAppPath,
    ephemeralTmpDir,
    opts,
  }) {
    const paths = builder.getUpdaterPaths(opts);

    // 1. Check read-only local official /Applications/Antigravity.app (or custom officialAppPath)
    const officialCandidates = opts.officialAppPath
      ? [path.resolve(String(opts.officialAppPath))]
      : ['/Applications/Antigravity.app.orig', '/Applications/Antigravity.app'];
    for (const cand of officialCandidates) {
      if (!fs.existsSync(cand)) continue;
      const ver = builder.readBundleShortVersion(path.join(cand, 'Contents', 'Info.plist'));
      if (ver && ver === targetAgVer) {
        if (opts.skipGoogleSignatureCheck !== true && process.platform === 'darwin') {
          try {
            builder.verifyOfficialGoogleBundleSignature(cand, opts);
          } catch {
            continue;
          }
        }
        return {
          sourceAppPath: cand,
          downloadedZipPath: null,
          sha512: null,
          sourceKind: 'official-local',
        };
      }
    }

    // 2. Check single-slot clean-base cache zip matching `targetAgVer`
    const cleanMeta = builder.readCleanBaseMeta(paths.cleanBaseDir);
    if (cleanMeta && cleanMeta.version === targetAgVer && fs.existsSync(cleanMeta.zipPath)) {
      const extractDir = path.join(ephemeralTmpDir, `official-${targetAgVer}`);
      const extractedApp = builder.extractOfficialZipAndVerify(cleanMeta.zipPath, extractDir, opts);
      return {
        sourceAppPath: extractedApp,
        downloadedZipPath: null,
        sha512: cleanMeta.sha512 || null,
        sourceKind: 'clean-base-cache',
      };
    }

    // 3. Acquire from official feed manifest (reuses verified pending zip or downloads over HTTPS)
    if (officialManifest && officialManifest.version === targetAgVer) {
      let downloadManifest = officialManifest;
      if (!downloadManifest.url || !downloadManifest.sha512) {
        try {
          const fullManifest = await builder.fetchOfficialLatestManifest({
            ...opts,
            appBundlePath: targetAppPath || opts.targetAppPath,
            currentVersion: undefined,
            requireDownload: true,
          });
          if (fullManifest && fullManifest.version === targetAgVer && fullManifest.url && fullManifest.sha512) {
            downloadManifest = fullManifest;
          }
        } catch {}
      }
      if (downloadManifest.url && downloadManifest.sha512) {
        const tmpZipPath = path.join(ephemeralTmpDir, `Antigravity-${targetAgVer}.zip`);
        const acquired = await builder.acquireOfficialVerifiedZip(downloadManifest, tmpZipPath, opts);
        const extractDir = path.join(ephemeralTmpDir, `official-${targetAgVer}`);
        const extractedApp = builder.extractOfficialZipAndVerify(acquired.zipPath, extractDir, opts);
        const isEphemeralZip = path.resolve(acquired.zipPath) === path.resolve(tmpZipPath);
        return {
          sourceAppPath: extractedApp,
          downloadedZipPath: isEphemeralZip ? acquired.zipPath : null,
          sha512: acquired.sha512,
          sourceKind: 'official-feed',
        };
      }
    }

    throw new Error(`找不到 v${targetAgVer} 对应的干净官方底包，无法在保持版本不降级的前提下重建`);
  }

  async function attemptStageForTarget({
    targetAgVer,
    targetHakimiSha,
    targetHakimiCommitDate,
    needDownloadHakimi,
    officialManifest,
    installed,
    targetAppPath,
    ephemeralTmpDir,
    cachedPatcherRoot,
    opts,
  }) {
    const paths = builder.getUpdaterPaths(opts);
    let patcherRoot = cachedPatcherRoot || null;
    if (needDownloadHakimi && !patcherRoot) {
      patcherRoot = await builder.downloadAndExtractHakimiTarball(
        {
          sha: targetHakimiSha,
          destTmpDir: path.join(ephemeralTmpDir, `hakimi-${targetHakimiSha.slice(0, 10)}`),
        },
        opts
      );
    }

    const officialSrc = await prepareCleanOfficialSource({
      targetAgVer,
      officialManifest,
      targetAppPath,
      ephemeralTmpDir,
      opts,
    });

    const stageId = `build-${targetAgVer}-${String(targetHakimiSha || 'local').slice(0, 7)}-${Date.now()}`;
    const stageDir = path.join(paths.stagingDir, stageId);

    const buildRes = await runStageBuildInChildWorker(
      {
        sourceAppPath: officialSrc.sourceAppPath,
        targetInstalledAppPath: targetAppPath,
        patcherRoot,
        stageDir,
        antigravityVersion: targetAgVer,
        hakimiCommit: targetHakimiSha || installed?.hakimiCommit || null,
        hakimiCommitDate: targetHakimiCommitDate || installed?.hakimiCommitDate || null,
        gitDirty: false,
        sourceKind: officialSrc.sourceKind,
        preserveCustomIcon: true,
      },
      opts
    );

    if (!buildRes || !buildRes.ok) {
      return {
        ok: false,
        failedStage: buildRes?.failedStage || 'stage-build',
        error: buildRes?.error || '沙盒试构建失败',
        patcherRoot,
      };
    }

    // Move newly downloaded official zip into stageDir for atomic single-slot promotion on swap
    let cleanBasePromotion = null;
    if (officialSrc.downloadedZipPath && fs.existsSync(officialSrc.downloadedZipPath)) {
      const stagedZipPath = path.join(stageDir, `clean-base-${targetAgVer}.zip`);
      try {
        fs.renameSync(officialSrc.downloadedZipPath, stagedZipPath);
      } catch (err) {
        if (err && err.code === 'EXDEV') {
          fs.copyFileSync(officialSrc.downloadedZipPath, stagedZipPath);
          upgradeHelper.unlinkIfExists(officialSrc.downloadedZipPath);
        } else {
          throw err;
        }
      }
      cleanBasePromotion = {
        stagedZipPath,
        cleanBaseDir: paths.cleanBaseDir,
        version: targetAgVer,
        sha512: officialSrc.sha512 || '',
        verifiedAt: new Date().toISOString(),
        nativeCacheDir: paths.nativeCacheDir,
      };
    }

    // Remove any older superseded staging directories (keep only this brand-new verified build)
    if (fs.existsSync(paths.stagingDir)) {
      try {
        for (const name of fs.readdirSync(paths.stagingDir)) {
          if (name === stageId) continue;
          const oldFull = path.join(paths.stagingDir, name);
          asarEngine.assertNotOfficialAntigravityApp(oldFull, '清理旧沙盒');
          fs.rmSync(oldFull, { recursive: true, force: true });
        }
      } catch {}
    }

    const stagedEntry = {
      stagingRootDir: stageDir,
      stagedAppPath: buildRes.stagedAppPath,
      targetAntigravityVersion: targetAgVer,
      targetHakimiVersion: buildRes.hakimiVersion || null,
      targetHakimiCommit: buildRes.hakimiCommit || targetHakimiSha || null,
      targetHakimiCommitShort: (buildRes.hakimiCommit || targetHakimiSha || '').slice(0, 7) || null,
      antigravityChanged: Boolean(installed?.antigravityVersion && targetAgVer !== installed.antigravityVersion),
      hakimiChanged: Boolean(
        needDownloadHakimi &&
          targetHakimiSha &&
          (!installed?.hakimiCommit ||
            targetHakimiSha.toLowerCase() !== installed.hakimiCommit.toLowerCase())
      ),
      usingCustomIcon: Boolean(buildRes.usingCustomIcon),
      asarSha256: buildRes.asarSha256 || null,
      builtAt: new Date().toISOString(),
      cleanBasePromotion,
    };

    return { ok: true, stagedEntry, patcherRoot };
  }

  async function checkAndStageUpgrade(runOptions = {}) {
    if (inFlightCheck) return inFlightCheck;
    const opts = getOpts(runOptions);

    if ((opts.platform || process.platform) !== 'darwin') {
      return buildStatusSnapshot(opts);
    }

    const run = (async () => {
      const paths = builder.getUpdaterPaths(opts);
      const targetAppPath = resolveCurrentBundlePath(opts);
      const installed = opts.installedMeta || builder.readInstalledBuildMeta(targetAppPath);
      const persisted = getPersistedState(opts);
      const manual = Boolean(opts.manual);
      const forceMainSync = Boolean(opts.forceMainSync);

      livePhase = 'checking';
      lastRuntimeError = null;
      notifyStatusChange(opts);

      const [officialOutcome, hakimiOutcome] = await Promise.allSettled([
        builder.fetchOfficialLatestManifest({
          ...opts,
          appBundlePath: targetAppPath,
          currentVersion: installed?.antigravityVersion || undefined,
        }),
        builder.checkHakimiMainUpdate({
          ...opts,
          installedCommit: installed?.hakimiCommit || null,
        }),
      ]);

      const official = officialOutcome.status === 'fulfilled' ? officialOutcome.value : null;
      const hakimi = hakimiOutcome.status === 'fulfilled' ? hakimiOutcome.value : null;
      lastCheckedAt = new Date().toISOString();

      if (official) {
        lastLatestOfficial = { version: official.version, releaseDate: official.releaseDate || '' };
      }
      if (hakimi) {
        lastLatestHakimi = {
          status: hakimi.status,
          sha: hakimi.latestSha,
          short: hakimi.latestShort,
          aheadBy: hakimi.aheadBy ?? null,
          commitMessage: hakimi.commitMessage || '',
          commitDate: hakimi.commitDate || '',
        };
      }

      if (!official && !hakimi) {
        const err1 = officialOutcome.status === 'rejected' ? officialOutcome.reason?.message : '';
        const err2 = hakimiOutcome.status === 'rejected' ? hakimiOutcome.reason?.message : '';
        lastRuntimeError = [err1, err2].filter(Boolean).join('；') || '检查更新网络请求失败';
        savePersistedState({ ...persisted, lastCheckedAt }, opts);
        livePhase = 'idle';
        return notifyStatusChange(opts);
      }

      const hasOfficialUpdate = Boolean(
        official?.version &&
          installed?.antigravityVersion &&
          builder.compareSemver(official.version, installed.antigravityVersion) > 0
      );
      const hasHakimiUpdate = Boolean(
        hakimi?.latestSha &&
          (hakimi.updateAvailable ||
            (forceMainSync &&
              (!installed?.hakimiCommit ||
                hakimi.latestSha.toLowerCase() !== installed.hakimiCommit.toLowerCase())))
      );

      // Desired target pair
      const desiredAgVer = hasOfficialUpdate ? official.version : installed?.antigravityVersion;
      const desiredHakimiSha = hasHakimiUpdate ? hakimi.latestSha : installed?.hakimiCommit || null;

      // Nothing to update
      if (!hasOfficialUpdate && !hasHakimiUpdate) {
        savePersistedState({ ...persisted, lastCheckedAt }, opts);
        livePhase = 'idle';
        return notifyStatusChange(opts);
      }

      // Already staged & verified for this exact target pair
      if (
        isValidStagedEntry(persisted.staged, installed) &&
        persisted.staged.targetAntigravityVersion === desiredAgVer &&
        (!desiredHakimiSha ||
          String(persisted.staged.targetHakimiCommit || '').toLowerCase() === desiredHakimiSha.toLowerCase())
      ) {
        savePersistedState({ ...persisted, lastCheckedAt }, opts);
        livePhase = 'idle';
        return notifyStatusChange(opts);
      }

      // Skip already-tested incompatible official version unless manual retry OR Hakimi main advanced
      const effectiveTestCommit = desiredHakimiSha || hakimi?.latestSha || 'local';
      const matchesKnownIncompatible = Boolean(
        !manual &&
          !forceMainSync &&
          hasOfficialUpdate &&
          persisted.incompatible &&
          persisted.incompatible.antigravityVersion === official.version &&
          String(persisted.incompatible.testedHakimiCommit || '').toLowerCase() ===
            String(effectiveTestCommit).toLowerCase()
      );

      if (matchesKnownIncompatible && !hasHakimiUpdate) {
        savePersistedState({ ...persisted, lastCheckedAt }, opts);
        livePhase = 'idle';
        return notifyStatusChange(opts);
      }

      livePhase = 'staging';
      notifyStatusChange(opts);

      const ephemeralTmpDir = path.join(paths.tmpDir, `run-${Date.now()}-${process.pid}`);
      fs.mkdirSync(ephemeralTmpDir, { recursive: true });
      let cachedPatcherRoot = null;
      let nextPersisted = { ...persisted, lastCheckedAt };

      try {
        // Primary attempt: if new official is not already skipped, build target (new AG + latest/current Hakimi)
        if (hasOfficialUpdate && !matchesKnownIncompatible) {
          const primaryRes = await attemptStageForTarget({
            targetAgVer: official.version,
            targetHakimiSha: desiredHakimiSha,
            targetHakimiCommitDate: hasHakimiUpdate ? hakimi?.commitDate : installed?.hakimiCommitDate,
            needDownloadHakimi: hasHakimiUpdate,
            officialManifest: official,
            installed,
            targetAppPath,
            ephemeralTmpDir,
            cachedPatcherRoot,
            opts,
          });
          cachedPatcherRoot = primaryRes.patcherRoot || cachedPatcherRoot;

          if (primaryRes.ok) {
            nextPersisted = {
              ...nextPersisted,
              staged: primaryRes.stagedEntry,
              incompatible: null,
            };
            savePersistedState(nextPersisted, opts);
            livePhase = 'idle';
            return notifyStatusChange(opts);
          }

          // Primary attempt failed (upstream Antigravity breaking change or patch failure):
          // Record structured diagnostics & clean up failed artifacts (staging already cleaned)
          nextPersisted = {
            ...nextPersisted,
            incompatible: {
              antigravityVersion: official.version,
              testedHakimiCommit: effectiveTestCommit,
              testedHakimiCommitShort: String(effectiveTestCommit).slice(0, 7),
              failedStage: primaryRes.failedStage || 'stage-build',
              error: primaryRes.error || '补丁适配失败',
              testedAt: new Date().toISOString(),
            },
          };
          savePersistedState(nextPersisted, opts);

          // Fallback: if Hakimi itself also has an update, still allow Hakimi-only update on current AG version!
          if (!hasHakimiUpdate) {
            livePhase = 'idle';
            return notifyStatusChange(opts);
          }
        }

        // Hakimi-only stage-build on current installed Antigravity version
        if (hasHakimiUpdate && installed?.antigravityVersion) {
          const hakimiOnlyRes = await attemptStageForTarget({
            targetAgVer: installed.antigravityVersion,
            targetHakimiSha: hakimi.latestSha,
            targetHakimiCommitDate: hakimi.commitDate,
            needDownloadHakimi: true,
            officialManifest: official,
            installed,
            targetAppPath,
            ephemeralTmpDir,
            cachedPatcherRoot,
            opts,
          });

          if (hakimiOnlyRes.ok) {
            nextPersisted = {
              ...nextPersisted,
              staged: hakimiOnlyRes.stagedEntry,
            };
            savePersistedState(nextPersisted, opts);
          } else {
            lastRuntimeError = `哈基米自更新试构建失败 (${hakimiOnlyRes.failedStage}): ${hakimiOnlyRes.error}`;
          }
        }
      } catch (err) {
        lastRuntimeError = err?.message || String(err);
      } finally {
        // STRICT DISK GC: ALWAYS wipe ephemeral Hakimi tarball, extracted source, and failed zip!
        try {
          if (fs.existsSync(ephemeralTmpDir)) {
            asarEngine.assertNotOfficialAntigravityApp(ephemeralTmpDir, '清理临时构建目录');
            fs.rmSync(ephemeralTmpDir, { recursive: true, force: true });
          }
        } catch {}
        livePhase = 'idle';
      }

      return notifyStatusChange(opts);
    })();

    inFlightCheck = run.finally(() => {
      inFlightCheck = null;
    });
    return inFlightCheck;
  }

  function installStagedUpgrade(override = {}) {
    const opts = getOpts(override);
    if ((opts.platform || process.platform) !== 'darwin') {
      return { ok: false, supported: false, error: '自动更新仅支持 macOS 哈基米.app' };
    }
    if (coldInstallInFlight) {
      return { ok: false, supported: true, error: '正在执行重启更新，请稍候…' };
    }

    const paths = builder.getUpdaterPaths(opts);
    let targetAppPath;
    try {
      targetAppPath = resolveCurrentBundlePath(opts);
    } catch (err) {
      return { ok: false, supported: true, error: err?.message || '无法定位目标应用路径' };
    }

    const installed = opts.installedMeta || builder.readInstalledBuildMeta(targetAppPath);
    const persisted = getPersistedState(opts);
    const staged = isValidStagedEntry(persisted.staged, installed) ? persisted.staged : null;
    if (!staged) {
      return { ok: false, supported: true, error: '当前没有已通过校验的待安装更新包' };
    }

    try {
      upgradeHelper.verifyStagedBundleReady(staged.stagedAppPath);
    } catch (err) {
      return { ok: false, supported: true, error: err?.message || '更新包校验失败' };
    }

    const runtimeDir = upgradeHelper.getRuntimeDir({ stateDir: paths.stateDir });
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

    const helperSrcPath = path.join(__dirname, 'hakimi-upgrade-helper.js');
    const stagedHelperPath = path.join(runtimeDir, upgradeHelper.UPGRADE_HELPER_FILE_NAME);
    fs.writeFileSync(stagedHelperPath, fs.readFileSync(helperSrcPath, 'utf8'), { encoding: 'utf8', mode: 0o700 });

    const homeDir = opts.homeDir ? path.resolve(String(opts.homeDir)) : os.homedir();
    const userDataDir = opts.userDataDir
      ? path.resolve(String(opts.userDataDir))
      : upgradeHelper.getDefaultUserDataDir(process.platform, process.env, homeDir);

    const job = {
      targetAppPath,
      stagedAppPath: staged.stagedAppPath,
      stagingRootDir: staged.stagingRootDir,
      targetAntigravityVersion: staged.targetAntigravityVersion,
      targetHakimiCommit: staged.targetHakimiCommit || null,
      cleanBasePromotion: staged.cleanBasePromotion || null,
      updaterStatePath: paths.statePath,
      stateDir: paths.stateDir,
      userDataDir,
      homeDir,
      parentPid: process.pid,
      createdAt: new Date().toISOString(),
    };

    const jobFilePath = path.join(runtimeDir, `hakimi-upgrade-job-${Date.now()}-${process.pid}.json`);
    const writeJob = upgradeHelper.writeJsonFileAtomic(jobFilePath, job, 0o600);
    if (!writeJob.ok) {
      return { ok: false, supported: true, error: writeJob.error || '写入冷更新任务失败' };
    }

    const runtime = resolveWorkerRuntime(opts);
    const spawnImpl = opts.spawnImpl || spawn;
    const logPath = path.join(runtimeDir, upgradeHelper.UPGRADE_LOG_FILE_NAME);
    let logFd = 'ignore';
    try {
      logFd = fs.openSync(logPath, 'a', 0o600);
    } catch {
      logFd = 'ignore';
    }

    try {
      const child = spawnImpl(runtime.bin, [stagedHelperPath, '--job', jobFilePath], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, ...runtime.envExtra },
      });
      if (child && typeof child.unref === 'function') child.unref();

      coldInstallInFlight = true;
      notifyStatusChange(opts);

      if (opts.quitAfterHandoff !== false) {
        const delayMs = Number.isFinite(opts.quitDelayMs) ? opts.quitDelayMs : 120;
        const doQuit = () => {
          try {
            const meterMain = require('./meter-main');
            meterMain.setAppQuitting(true);
          } catch {}
          try {
            const collector = require('./meter-collector');
            collector.flushPricingLedger();
          } catch {}
          const electron = resolveElectron();
          if (electron?.app && typeof electron.app.quit === 'function') {
            electron.app.quit();
          }
        };
        if (delayMs <= 0) doQuit();
        else setTimeout(doQuit, delayMs);
      }

      return {
        ok: true,
        supported: true,
        coldInstalling: true,
        helperPid: child?.pid || null,
        targetAppPath,
        targetAntigravityVersion: staged.targetAntigravityVersion,
        targetHakimiCommit: staged.targetHakimiCommit || null,
      };
    } catch (err) {
      return { ok: false, supported: true, error: err?.message || '启动冷更新进程失败' };
    } finally {
      if (typeof logFd === 'number') {
        try { fs.closeSync(logFd); } catch {}
      }
    }
  }

  function startAutoSchedule(opts = {}) {
    if (periodicTimer || initialTimer) return;
    const initDelay = Number.isFinite(opts.initialDelayMs) ? opts.initialDelayMs : INITIAL_CHECK_DELAY_MS;
    const intervalMs = Number.isFinite(opts.checkIntervalMs) ? opts.checkIntervalMs : CHECK_INTERVAL_MS;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      if (!autoCheckEnabled) return;
      void checkAndStageUpgrade({ manual: false });
      periodicTimer = setInterval(() => {
        if (autoCheckEnabled) void checkAndStageUpgrade({ manual: false });
      }, intervalMs);
      if (typeof periodicTimer.unref === 'function') periodicTimer.unref();
    }, initDelay);
    if (typeof initialTimer.unref === 'function') initialTimer.unref();
  }

  function stopAutoSchedule() {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  function initialize(isHeadless = false, settingsService = null, override = {}) {
    if (initialized) return;
    initialized = true;
    const opts = getOpts(override);

    // Run non-blocking startup orphan GC immediately
    try {
      builder.cleanupOrphanUpdaterArtifacts({
        stateDir: opts.stateDir,
        homeDir: opts.homeDir,
        nativeCacheDir: opts.nativeCacheDir,
        targetAppPath: (() => {
          try { return resolveCurrentBundlePath(opts); } catch { return ''; }
        })(),
      });
    } catch {}

    updateNativeMenuState(buildStatusSnapshot(opts));

    if (isHeadless) return;

    const enableSchedule = (enabled) => {
      autoCheckEnabled = enabled !== false;
      if (autoCheckEnabled) startAutoSchedule(opts);
      else stopAutoSchedule();
    };

    if (settingsService && typeof settingsService.getSetting === 'function') {
      Promise.resolve(settingsService.getSetting('autoCheckForUpdates'))
        .then((val) => enableSchedule(val !== false))
        .catch(() => enableSchedule(true));
      if (typeof settingsService.onSettingChanged === 'function') {
        try {
          settingsService.onSettingChanged('autoCheckForUpdates', (val) => enableSchedule(val !== false));
        } catch {}
      }
    } else {
      enableSchedule(true);
    }
  }

  /**
   * Drop-in module-boundary replacement for official `dist/updater.js`.
   * Always keeps native `updater:state-changed` at `idle` so Squirrel.Mac and the
   * phantom native top-right button stay completely silent, while preserving macOS
   * menu bar integration and host status APIs.
   */
  function createNativeUpdaterBridge() {
    const idleState = { type: 'idle' };

    const checkForUpdates = (isManual = false) => {
      void checkAndStageUpgrade({ manual: Boolean(isManual) }).then((snap) => {
        if (!isManual) return;
        const electron = resolveElectron();
        if (!electron?.dialog) return;
        if (snap.status === 'ready') {
          const agPart = snap.staged?.antigravityChanged
            ? `Antigravity v${snap.installed?.antigravityVersion || '?'} → v${snap.staged.targetAntigravityVersion}`
            : `Antigravity v${snap.staged?.targetAntigravityVersion || snap.installed?.antigravityVersion || '?'}`;
          const hkPart = snap.staged?.hakimiChanged
            ? `哈基米 ${snap.installed?.hakimiCommitShort || '旧版'} → ${snap.staged.targetHakimiCommitShort || '新版'}`
            : '';
          void electron.dialog
            .showMessageBox({
              type: 'info',
              title: '哈基米更新已就绪',
              message: [agPart, hkPart].filter(Boolean).join(' · '),
              detail: '新版本已在后台完成补丁与签名校验，是否立即重启并应用更新？',
              buttons: ['立即重启并更新', '稍后'],
              defaultId: 0,
              cancelId: 1,
            })
            .then((r) => {
              if (r && r.response === 0) {
                installStagedUpgrade();
              }
            })
            .catch(() => {});
        } else if (snap.status === 'incompatible') {
          void electron.dialog
            .showMessageBox({
              type: 'warning',
              title: '新版 Antigravity 暂未适配',
              message: `检测到官方 v${snap.incompatible?.antigravityVersion || '?'}，但后台试构建未通过`,
              detail: `失败阶段：${snap.incompatible?.failedStage || 'unknown'}\n原因：${snap.incompatible?.error || '未知'}\n当前运行版本未受任何影响，可在「设置 → 自动更新」查看详情。`,
              buttons: ['知道了'],
            })
            .catch(() => {});
        } else if (snap.status === 'idle' || snap.status === 'local_dev') {
          void electron.dialog
            .showMessageBox({
              type: 'info',
              title: '检查更新',
              message: snap.status === 'local_dev' ? '当前运行的是本地开发构建，已是最新' : '当前已是最新版本',
              buttons: ['好'],
            })
            .catch(() => {});
        }
      });
    };

    const quitAndInstall = async () => {
      installStagedUpgrade();
    };

    const updateActions = {
      [MenuUpdateStep.CheckForUpdates]: () => checkForUpdates(true),
      [MenuUpdateStep.CheckingForUpdates]: undefined,
      [MenuUpdateStep.DownloadingUpdate]: undefined,
      [MenuUpdateStep.RestartToUpdate]: () => void quitAndInstall(),
    };

    return {
      MenuUpdateStep,
      updateActions,
      setAutoUpdateChecking(enabled) {
        autoCheckEnabled = Boolean(enabled);
        if (autoCheckEnabled) startAutoSchedule();
        else stopAutoSchedule();
      },
      broadcastState() {
        // Intentionally suppress native Squirrel/AppUpdateButton state broadcasts
      },
      getLastState() {
        return idleState;
      },
      initAutoUpdater(isHeadless, settingsService) {
        initialize(Boolean(isHeadless), settingsService);
      },
      checkForUpdates,
      quitAndInstall,
      getHostUpdateStatus() {
        const snap = buildStatusSnapshot();
        const cur = snap.installed?.antigravityVersion || resolveElectron()?.app?.getVersion?.() || '0.0.0';
        const readyVer = snap.status === 'ready' ? snap.staged?.targetAntigravityVersion : null;
        return {
          currentVersion: cur,
          latestVersion: readyVer || cur,
          updateAvailable: Boolean(snap.status === 'ready'),
        };
      },
      applyHostUpdate() {
        const snap = buildStatusSnapshot();
        if (snap.status === 'ready') {
          const res = installStagedUpgrade();
          return Boolean(res && res.ok);
        }
        void checkAndStageUpgrade({ manual: false });
        return true;
      },
    };
  }

  return {
    getStatus: buildStatusSnapshot,
    checkAndStageUpgrade,
    installStagedUpgrade,
    initialize,
    stopAutoSchedule,
    onStatusChange(fn) {
      if (typeof fn === 'function') listeners.add(fn);
      return () => listeners.delete(fn);
    },
    createNativeUpdaterBridge,
  };
}

let singletonUpdater = null;
function getDefaultUpdater() {
  if (!singletonUpdater) {
    singletonUpdater = createHakimiUpdater();
  }
  return singletonUpdater;
}

module.exports = {
  UPDATER_CHANGED_CHANNEL,
  MenuUpdateStep,
  resolveCurrentBundlePath,
  resolveWorkerRuntime,
  createHakimiUpdater,
  getDefaultUpdater,
  createNativeUpdaterBridge() {
    return getDefaultUpdater().createNativeUpdaterBridge();
  },
};
