#!/usr/bin/env node
'use strict';

/**
 * Windows standalone builder for Hakimi (`%LOCALAPPDATA%\Programs\Hakimi`).
 *
 * Security & Isolation Invariants:
 * - Strictly read-only on official `%LOCALAPPDATA%\Programs\Antigravity` (or `--from`).
 * - Verifies `assertNotOfficialAntigravityApp()` on every mutating target path.
 * - Checks Electron Fuses (`EnableEmbeddedAsarIntegrityValidation`) before staging.
 * - Supports `--stage-only` sandbox builds that never touch installed apps,
 *   shortcuts, user config, or running processes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD_DIST = path.join(ROOT, 'payload', 'dist');

const asarEngine = require(path.join(PAYLOAD_DIST, 'asar-engine'));
const modulesConfig = require(path.join(PAYLOAD_DIST, 'modules-config'));
const { packHakimiAsar } = require(path.join(ROOT, 'scripts', 'pack-hakimi-asar'));

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'utf8');
const FUSE_NAMES = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
];

const RELAUNCH_STRIP_ENV_KEYS = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'NODE_OPTIONS',
  'ELECTRON_OZONE_PLATFORM_HINT',
  'DEV_URL',
];

const SKIP_COPY_ROOT_FILES = new Set([
  'uninstall antigravity.exe',
]);

function inspectElectronFuses(exePath) {
  const resolved = path.resolve(String(exePath || ''));
  if (!fs.existsSync(resolved)) {
    return { found: false, reason: `Executable not found: ${resolved}`, flags: {} };
  }
  const buf = fs.readFileSync(resolved);
  const idx = buf.indexOf(FUSE_SENTINEL);
  if (idx < 0) {
    return { found: false, reason: 'Electron fuse sentinel not found', flags: {} };
  }
  const version = buf[idx + FUSE_SENTINEL.length];
  const count = buf[idx + FUSE_SENTINEL.length + 1];
  const flags = {};
  for (let i = 0; i < count; i++) {
    const b = buf[idx + FUSE_SENTINEL.length + 2 + i];
    const name = FUSE_NAMES[i] || `fuse${i}`;
    flags[name] = b === 0x31 ? true : b === 0x30 ? false : b;
  }
  return { found: true, version, count, flags };
}

function resolveOfficialSourceDir(explicitFrom) {
  if (explicitFrom) {
    const resolved = path.resolve(String(explicitFrom));
    if (!fs.existsSync(resolved)) {
      throw new Error(`指定的官方 Antigravity 目录不存在: ${resolved}`);
    }
    return resolved;
  }
  const detected = asarEngine.getDefaultOfficialAppPath('win32');
  if (!fs.existsSync(detected)) {
    throw new Error(
      `未检测到本机 Windows 官方 Antigravity 安装目录（默认: ${detected}），请先安装原版或通过 --from <目录> 指定`
    );
  }
  return detected;
}

function validateOfficialSourceDir(srcDir) {
  const exePath = path.join(srcDir, 'Antigravity.exe');
  const asarPath = path.join(srcDir, 'resources', 'app.asar');
  if (!fs.existsSync(exePath)) {
    throw new Error(`源目录缺少 Antigravity.exe: ${exePath}`);
  }
  if (!fs.existsSync(asarPath)) {
    throw new Error(`源目录缺少 resources\\app.asar: ${asarPath}`);
  }
  return { exePath, asarPath };
}

function copyDirectoryFiltered(srcDir, destDir, isRoot = true) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (isRoot && SKIP_COPY_ROOT_FILES.has(entry.name.toLowerCase())) {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryFiltered(srcPath, destPath, false);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      try {
        fs.symlinkSync(target, destPath);
      } catch {
        // Fallback for Windows without symlink privilege: copy resolved target
        const st = fs.statSync(srcPath);
        if (st.isDirectory()) copyDirectoryFiltered(srcPath, destPath, false);
        else if (st.isFile()) fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

function getRepoGitCommit(repoRoot = ROOT) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

function getRepoGithubRemoteInfo(repoRoot = ROOT) {
  try {
    const remoteUrl = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    const branch = execFileSync('git', ['-C', repoRoot, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
    if (!m) return {};
    return {
      githubOwner: m[1],
      githubRepo: m[2],
      githubBranch: branch || 'main',
    };
  } catch {
    return {};
  }
}

function getRepoPackageVersion(repoRoot = ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return pkg?.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function findRunningWinPidsUnderRoot(targetRoot, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return [];
  if (!targetRoot) return [];
  const absRoot = path.resolve(String(targetRoot));
  asarEngine.assertNotOfficialAntigravityApp(absRoot, 'inspect running processes');

  const execImpl = options.execFileSync || execFileSync;
  const normPrefix = absRoot.replace(/[\\/]+$/, '').toLowerCase() + '\\';
  const psScript = [
    '$procs = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath;',
    'if ($procs) { $procs | ConvertTo-Json -Compress } else { "[]" }',
  ].join(' ');

  try {
    const out = execImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const trimmed = String(out || '').trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const hits = [];
    for (const p of list) {
      if (!p || !p.ExecutablePath) continue;
      const exeNorm = path.resolve(String(p.ExecutablePath)).toLowerCase();
      if (exeNorm.startsWith(normPrefix)) {
        const pid = Number(p.ProcessId);
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
          hits.push({
            pid,
            ppid: Number(p.ParentProcessId) || 0,
            name: String(p.Name || ''),
            executablePath: String(p.ExecutablePath),
          });
        }
      }
    }
    return hits;
  } catch {
    return [];
  }
}

function sleepSync(ms) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  const arr = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) {
    const rem = Math.min(200, end - Date.now());
    if (rem > 0) Atomics.wait(arr, 0, 0, rem);
  }
}

function stopWinProcessesUnderRoot(targetRoot, options = {}) {
  const absRoot = path.resolve(String(targetRoot));
  asarEngine.assertNotOfficialAntigravityApp(absRoot, 'terminate processes');

  const findImpl = options.findRunningPids || ((r) => findRunningWinPidsUnderRoot(r, options));
  const execImpl = options.execFileSync || execFileSync;
  const sleepImpl = options.sleepSync || sleepSync;
  const gracefulTimeoutMs = Number(options.gracefulTimeoutMs || 6000);
  const forceTimeoutMs = Number(options.forceTimeoutMs || 5000);

  const initial = findImpl(absRoot);
  if (initial.length === 0) {
    return { ok: true, hadRunning: false, terminatedPids: [] };
  }

  const terminated = new Set();

  // 1. Ask top-level Electron windows under targetRoot to close gracefully
  const mainPids = initial
    .filter((p) => String(p.name).toLowerCase() === 'antigravity.exe')
    .map((p) => p.pid);
  if (mainPids.length > 0 && (options.platform || process.platform) === 'win32') {
    const pidCsv = mainPids.join(',');
    try {
      execImpl(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Get-Process -Id ${pidCsv} -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`,
        ],
        { stdio: 'ignore', timeout: 4000, windowsHide: true }
      );
    } catch {}
  }

  const gracefulDeadline = Date.now() + gracefulTimeoutMs;
  while (Date.now() < gracefulDeadline) {
    const alive = findImpl(absRoot);
    if (alive.length === 0) {
      for (const p of initial) terminated.add(p.pid);
      return { ok: true, hadRunning: true, terminatedPids: [...terminated] };
    }
    sleepImpl(250);
  }

  // 2. Force-terminate remaining processes strictly inside targetRoot
  const remaining = findImpl(absRoot);
  for (const p of remaining) {
    try {
      execImpl('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 4000,
        windowsHide: true,
      });
      terminated.add(p.pid);
    } catch {
      try {
        process.kill(p.pid, 'SIGKILL');
        terminated.add(p.pid);
      } catch {}
    }
  }

  const forceDeadline = Date.now() + forceTimeoutMs;
  while (Date.now() < forceDeadline) {
    const alive = findImpl(absRoot);
    if (alive.length === 0) {
      return { ok: true, hadRunning: true, terminatedPids: [...terminated] };
    }
    sleepImpl(250);
  }

  const survivors = findImpl(absRoot);
  return {
    ok: survivors.length === 0,
    hadRunning: true,
    terminatedPids: [...terminated],
    survivors,
    error: survivors.length > 0 ? `仍有 ${survivors.length} 个目标进程未退出 (PID: ${survivors.map((s) => s.pid).join(', ')})` : null,
  };
}

function renameWithRetry(fromPath, toPath, options = {}) {
  const maxWaitMs = Number(options.maxWaitMs || 10000);
  const sleepImpl = options.sleepSync || sleepSync;
  const renameImpl = options.renameSync || fs.renameSync;
  const start = Date.now();
  let delay = 150;
  while (true) {
    try {
      renameImpl(fromPath, toPath);
      return;
    } catch (err) {
      const retryable = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (!retryable || Date.now() - start >= maxWaitMs) {
        throw err;
      }
      sleepImpl(delay);
      delay = Math.min(1000, Math.round(delay * 1.5));
    }
  }
}

function swapDirectoryWithRollback(stageDir, destDir, options = {}) {
  const absStage = path.resolve(String(stageDir));
  const absDest = path.resolve(String(destDir));
  asarEngine.assertNotOfficialAntigravityApp(absStage, 'move staging directory');
  asarEngine.assertNotOfficialAntigravityApp(absDest, 'replace target directory');

  fs.mkdirSync(path.dirname(absDest), { recursive: true });
  const hadExisting = fs.existsSync(absDest);
  const prevBackup = `${absDest}.prev.${process.pid}.${Date.now()}`;

  if (hadExisting) {
    renameWithRetry(absDest, prevBackup, options);
  }

  try {
    renameWithRetry(absStage, absDest, options);
  } catch (err) {
    let rolledBack = false;
    if (hadExisting && fs.existsSync(prevBackup) && !fs.existsSync(absDest)) {
      try {
        renameWithRetry(prevBackup, absDest, { ...options, maxWaitMs: 4000 });
        rolledBack = true;
      } catch {}
    }
    err.rolledBack = rolledBack;
    throw err;
  }

  let cleanedPrev = true;
  if (hadExisting && fs.existsSync(prevBackup)) {
    try {
      fs.rmSync(prevBackup, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      cleanedPrev = false;
    }
  }
  return { ok: true, swapped: true, hadExisting, cleanedPrev, prevBackup: cleanedPrev ? null : prevBackup };
}

function packPngFramesToIco(frames) {
  // Standard Windows ICO container with embedded PNG frames (Vista/Win7/Win10/Win11)
  // frames: Array<{ size: number, png: Buffer }>
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('ICO 帧列表为空');
  }
  const count = frames.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1 (ICO)
  header.writeUInt16LE(count, 4);

  let offset = header.length;
  for (let i = 0; i < count; i++) {
    const { size, png } = frames[i];
    const dim = size >= 256 ? 0 : size & 0xff;
    const base = 6 + i * 16;
    header.writeUInt8(dim, base + 0); // width (0 means 256)
    header.writeUInt8(dim, base + 1); // height (0 means 256)
    header.writeUInt8(0, base + 2); // color count
    header.writeUInt8(0, base + 3); // reserved
    header.writeUInt16LE(1, base + 4); // color planes
    header.writeUInt16LE(32, base + 6); // bits per pixel
    header.writeUInt32LE(png.length, base + 8); // bytes in resource
    header.writeUInt32LE(offset, base + 12); // offset
    offset += png.length;
  }
  return Buffer.concat([header, ...frames.map((f) => f.png)]);
}

function buildWindowsIconAssets(iconInputPath, outDir, options = {}) {
  const srcPath = path.resolve(String(iconInputPath || ''));
  if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
    throw new Error(`找不到自定义图标文件: ${srcPath}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const icoOutPath = path.join(outDir, 'hakimi.ico');
  const pngOutPath = path.join(outDir, 'hakimi-icon-512.png');

  const rawBuf = fs.readFileSync(srcPath);
  const isIco = rawBuf.length >= 6 && rawBuf.readUInt16LE(0) === 0 && rawBuf.readUInt16LE(2) === 1;
  if (isIco) {
    fs.writeFileSync(icoOutPath, rawBuf);
    return { icoPath: icoOutPath, pngPath: null, format: 'ico' };
  }

  const execImpl = options.execFileSync || execFileSync;
  const esc = (s) => String(s).replace(/'/g, "''");
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    `$src = [System.Drawing.Image]::FromFile('${esc(srcPath)}')`,
    'try {',
    '  $side = [Math]::Min($src.Width, $src.Height)',
    '  $sx = [int][Math]::Floor(($src.Width - $side) / 2)',
    '  $sy = [int][Math]::Floor(($src.Height - $side) / 2)',
    '  $cropRect = New-Object System.Drawing.Rectangle($sx, $sy, $side, $side)',
    '  $out = @{}',
    '  foreach ($sz in @(512, 256, 48, 32)) {',
    '    $bmp = New-Object System.Drawing.Bitmap($sz, $sz)',
    '    $g = [System.Drawing.Graphics]::FromImage($bmp)',
    '    try {',
    '      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
    '      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
    '      $g.Clear([System.Drawing.Color]::Transparent)',
    '      $dstRect = New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)',
    '      $g.DrawImage($src, $dstRect, $cropRect, [System.Drawing.GraphicsUnit]::Pixel)',
    '    } finally { $g.Dispose() }',
    '    $ms = New-Object System.IO.MemoryStream',
    '    try {',
    '      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '      $out[[string]$sz] = [Convert]::ToBase64String($ms.ToArray())',
    '    } finally { $ms.Dispose(); $bmp.Dispose() }',
    '  }',
    '  $out | ConvertTo-Json -Compress',
    '} finally { $src.Dispose() }',
  ].join('\n');
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const stdout = execImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  );
  const parsed = JSON.parse(String(stdout || '').trim());
  const png512 = Buffer.from(parsed['512'], 'base64');
  const icoBuf = packPngFramesToIco([
    { size: 256, png: Buffer.from(parsed['256'], 'base64') },
    { size: 48, png: Buffer.from(parsed['48'], 'base64') },
    { size: 32, png: Buffer.from(parsed['32'], 'base64') },
  ]);
  fs.writeFileSync(icoOutPath, icoBuf);
  fs.writeFileSync(pngOutPath, png512);
  return { icoPath: icoOutPath, pngPath: pngOutPath, format: 'converted' };
}

function createWindowsShortcuts(destDir, options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    return { created: [] };
  }
  const absDest = path.resolve(destDir);
  const exePath = path.join(absDest, 'Antigravity.exe');
  const customIco = path.join(absDest, 'resources', 'hakimi.ico');
  const iconLocation = options.iconPath && fs.existsSync(options.iconPath)
    ? `${path.resolve(options.iconPath)},0`
    : fs.existsSync(customIco)
      ? `${customIco},0`
      : `${exePath},0`;
  const shortcutName = options.shortcutName || '哈基米.lnk';
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const startMenuDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const desktopDir = path.join(os.homedir(), 'Desktop');

  const targets = [path.join(startMenuDir, shortcutName)];
  if (options.desktopShortcut !== false && fs.existsSync(desktopDir)) {
    targets.push(path.join(desktopDir, shortcutName));
  }

  const created = [];
  const psEscape = (s) => String(s).replace(/'/g, "''");
  const lines = ['$ws = New-Object -ComObject WScript.Shell;'];
  for (const lnk of targets) {
    fs.mkdirSync(path.dirname(lnk), { recursive: true });
    lines.push(
      `$s = $ws.CreateShortcut('${psEscape(lnk)}');`,
      `$s.TargetPath = '${psEscape(exePath)}';`,
      `$s.WorkingDirectory = '${psEscape(absDest)}';`,
      `$s.IconLocation = '${psEscape(iconLocation)}';`,
      `$s.Description = 'Antigravity Hakimi (Standalone)';`,
      '$s.Save();'
    );
  }
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', lines.join(' ')],
      { stdio: 'pipe', timeout: 8000, windowsHide: true }
    );
    created.push(...targets.filter((p) => fs.existsSync(p)));
  } catch (err) {
    return { created, error: err?.message || String(err) };
  }
  return { created, iconLocation };
}

function buildCleanLaunchEnv(baseEnv = process.env) {
  const clean = { ...baseEnv };
  for (const k of RELAUNCH_STRIP_ENV_KEYS) {
    delete clean[k];
  }
  return clean;
}

function launchWinApp(destDir, options = {}) {
  const exePath = path.join(path.resolve(destDir), 'Antigravity.exe');
  asarEngine.assertNotOfficialAntigravityApp(exePath, 'launch target app');
  const spawnImpl = options.spawn || spawn;
  const child = spawnImpl(exePath, [], {
    cwd: path.resolve(destDir),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: buildCleanLaunchEnv(options.env || process.env),
  });
  if (typeof child.unref === 'function') child.unref();
  return { launched: true, exePath, pid: child.pid || null };
}

function buildHakimiWin(rawOpts = {}) {
  const log = rawOpts.quiet ? () => {} : (msg) => console.log(msg);
  const stageOnly = Boolean(rawOpts.stageOnly);
  const keepStage = Boolean(rawOpts.keepStage);
  const autoRestart = stageOnly ? false : rawOpts.autoRestart !== false;
  const createShortcut = stageOnly ? false : rawOpts.createShortcut !== false;
  const clientLang = rawOpts.clientLang || 'zh-CN';
  const hasExplicitLang = Boolean(rawOpts.hasExplicitLang);

  const srcDir = resolveOfficialSourceDir(rawOpts.from);
  const { exePath: srcExe, asarPath: srcAsar } = validateOfficialSourceDir(srcDir);

  const destDir = path.resolve(rawOpts.dest || asarEngine.getDefaultHakimiAppPath('win32'));
  asarEngine.assertNotOfficialAntigravityApp(destDir, 'install Hakimi');

  const fuses = inspectElectronFuses(srcExe);
  if (fuses.found && fuses.flags.enableEmbeddedAsarIntegrityValidation === true && !rawOpts.allowIntegrityFuse) {
    throw new Error(
      '检测到当前官方 Antigravity.exe 开启了 EnableEmbeddedAsarIntegrityValidation=1，直接替换 app.asar 会触发启动校验失败；请升级打包工具支持 PE 资源哈希更新或确认后再操作'
    );
  }

  const antigravityVersion = modulesConfig.readAppVersion(srcDir) || 'unknown';
  const hakimiVersion = getRepoPackageVersion();
  const hakimiCommit = getRepoGitCommit();
  const ghInfo = getRepoGithubRemoteInfo();

  // Stage on the same volume as destDir (when installing) or os.tmpdir() (when stageOnly)
  const stageParent = stageOnly ? os.tmpdir() : path.dirname(destDir);
  fs.mkdirSync(stageParent, { recursive: true });
  const stageDir = path.join(stageParent, `.hakimi-win-stage-${process.pid}-${Date.now()}`);
  asarEngine.assertNotOfficialAntigravityApp(stageDir, 'stage Hakimi build');

  let stageSucceeded = false;
  try {
    log(`==> [1/5] 只读源检测: ${srcDir} (Antigravity v${antigravityVersion})`);
    if (fuses.found) {
      log(
        `    Electron Fuses: RunAsNode=${Number(Boolean(fuses.flags.runAsNode))}, ` +
          `AsarIntegrity=${Number(Boolean(fuses.flags.enableEmbeddedAsarIntegrityValidation))}`
      );
    }

    log(`==> [2/5] 复制官方运行环境到沙盒目录: ${stageDir}`);
    copyDirectoryFiltered(srcDir, stageDir, true);

    // Ensure renderer bundle exists
    const rendererBundlePath = path.join(PAYLOAD_DIST, 'meter-renderer.js');
    if (!fs.existsSync(rendererBundlePath)) {
      log('==> 构建前端渲染器 bundle...');
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.js')], {
        cwd: ROOT,
        stdio: 'inherit',
      });
    }

    // Optional custom icon (--icon <img|ico>) or carryover from existing Hakimi install
    let iconPngForAsar = null;
    let usingCustomIcon = false;
    const stageIcoPath = path.join(stageDir, 'resources', 'hakimi.ico');
    const iconTmpDir = path.join(stageDir, '.hakimi-icon-tmp');
    try {
      if (rawOpts.icon) {
        log(`==> 处理自定义应用图标: ${rawOpts.icon}`);
        const assets = buildWindowsIconAssets(rawOpts.icon, iconTmpDir);
        fs.copyFileSync(assets.icoPath, stageIcoPath);
        iconPngForAsar = assets.pngPath;
        usingCustomIcon = true;
      } else if (!rawOpts.restoreIcon && fs.existsSync(path.join(destDir, 'resources', 'hakimi.ico'))) {
        fs.copyFileSync(path.join(destDir, 'resources', 'hakimi.ico'), stageIcoPath);
        usingCustomIcon = true;
        try {
          const curAsar = path.join(destDir, 'resources', 'app.asar');
          if (fs.existsSync(curAsar)) {
            fs.mkdirSync(iconTmpDir, { recursive: true });
            const carryPng = path.join(iconTmpDir, 'carry-icon.png');
            fs.writeFileSync(carryPng, asarEngine.builtinAsar.extractFile(curAsar, 'icon.png'));
            iconPngForAsar = carryPng;
          }
        } catch {}
      }

      log('==> [3/5] 注入增强模块并重打包 resources\\app.asar');
      const stageAsar = path.join(stageDir, 'resources', 'app.asar');
      var packRes = packHakimiAsar({
        srcAsar,
        destAsar: stageAsar,
        stateDir: rawOpts.stateDir,
        clientLang,
        hasExplicitLang,
        iconPng: iconPngForAsar,
        forceConfig: Boolean(rawOpts.forceConfig),
        skipConfig: stageOnly || Boolean(rawOpts.skipConfig),
      });
    } finally {
      if (fs.existsSync(iconTmpDir)) {
        try { fs.rmSync(iconTmpDir, { recursive: true, force: true }); } catch {}
      }
    }
    const stageAsar = path.join(stageDir, 'resources', 'app.asar');

    const buildMeta = {
      schemaVersion: 1,
      platform: 'win32',
      arch: process.arch,
      antigravityVersion,
      hakimiVersion,
      hakimiCommit,
      hakimiCommitShort: hakimiCommit ? hakimiCommit.slice(0, 7) : null,
      sourceKind: 'official-local',
      sourceDir: srcDir,
      asarHeaderSha256: packRes.sha256,
      fuses: fuses.found ? fuses.flags : null,
      builtAt: new Date().toISOString(),
      ...ghInfo,
    };
    fs.writeFileSync(
      path.join(stageDir, 'resources', 'hakimi-build-meta.json'),
      JSON.stringify(buildMeta, null, 2),
      'utf8'
    );

    // Verify packed modules inside staging directory
    const inspect = modulesConfig.inspectDiskModules(stageAsar);
    if (!inspect.found || !inspect.meterReady || !inspect.chineseReady || !inspect.markdownFixReady) {
      throw new Error(`沙盒产物模块校验失败: ${JSON.stringify(inspect)}`);
    }

    log(`==> [4/5] 沙盒校验通过 (ASAR SHA-256: ${packRes.sha256.slice(0, 12)}…)`);

    if (stageOnly) {
      stageSucceeded = true;
      log(`==> [5/5] --stage-only 完成，未触碰目标目录与运行进程`);
      return {
        ok: true,
        stageOnly: true,
        stageDir: keepStage ? stageDir : null,
        keptStage: keepStage,
        srcDir,
        destDir,
        antigravityVersion,
        hakimiVersion,
        hakimiCommit,
        asarHeaderSha256: packRes.sha256,
        fuses,
        inspect,
      };
    }

    // Stop only existing processes under destDir
    log(`==> [5/5] 检查并安装独立副本: ${destDir}`);
    const stopRes = stopWinProcessesUnderRoot(destDir);
    if (!stopRes.ok) {
      throw new Error(stopRes.error || '无法关闭运行中的 Hakimi 进程，请手动退出后重试');
    }

    if (stopRes.hadRunning) {
      modulesConfig.cleanupStaleSingletonLock();
    }

    const swapRes = swapDirectoryWithRollback(stageDir, destDir);
    stageSucceeded = true; // stageDir has moved into destDir

    let shortcutRes = { created: [] };
    if (createShortcut) {
      shortcutRes = createWindowsShortcuts(destDir, {
        desktopShortcut: rawOpts.desktopShortcut !== false,
      });
    }

    let launchRes = { launched: false };
    if (autoRestart) {
      log(`==> 启动独立客户端: ${path.join(destDir, 'Antigravity.exe')}`);
      launchRes = launchWinApp(destDir);
    }

    log('==> Windows 独立构建完成！');
    log(`    独立目录: ${destDir}`);
    log(`    官方原版: ${srcDir} (只读源，零修改)`);
    if (shortcutRes.created.length > 0) {
      log(`    快捷方式: ${shortcutRes.created.join(', ')}`);
    }

    return {
      ok: true,
      stageOnly: false,
      srcDir,
      destDir,
      antigravityVersion,
      hakimiVersion,
      hakimiCommit,
      asarHeaderSha256: packRes.sha256,
      fuses,
      inspect,
      hadRunning: stopRes.hadRunning,
      swap: swapRes,
      shortcuts: shortcutRes,
      launch: launchRes,
    };
  } finally {
    if ((!stageSucceeded || (stageOnly && !keepStage)) && fs.existsSync(stageDir)) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {}
    }
  }
}

function parseCliArgs(argv) {
  const opts = {
    from: null,
    dest: null,
    stateDir: null,
    icon: null,
    restoreIcon: false,
    clientLang: 'zh-CN',
    hasExplicitLang: false,
    stageOnly: false,
    keepStage: false,
    autoRestart: true,
    createShortcut: true,
    desktopShortcut: true,
    forceConfig: false,
    skipConfig: false,
    allowIntegrityFuse: false,
    json: false,
    quiet: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from' && argv[i + 1]) opts.from = argv[++i];
    else if (arg === '--dest' && argv[i + 1]) opts.dest = argv[++i];
    else if (arg === '--state-dir' && argv[i + 1]) opts.stateDir = argv[++i];
    else if (arg === '--icon' && argv[i + 1]) opts.icon = argv[++i];
    else if (arg === '--restore-icon') opts.restoreIcon = true;
    else if (arg === '--client-lang' && argv[i + 1]) {
      opts.clientLang = argv[++i];
      opts.hasExplicitLang = true;
    } else if (arg === '--stage-only') opts.stageOnly = true;
    else if (arg === '--keep-stage') opts.keepStage = true;
    else if (arg === '--no-restart' || arg === '--no-launch') opts.autoRestart = false;
    else if (arg === '--no-shortcut') opts.createShortcut = false;
    else if (arg === '--no-desktop-shortcut') opts.desktopShortcut = false;
    else if (arg === '--force-config') opts.forceConfig = true;
    else if (arg === '--skip-config') opts.skipConfig = true;
    else if (arg === '--allow-integrity-fuse') opts.allowIntegrityFuse = true;
    else if (arg === '--json') {
      opts.json = true;
      opts.quiet = true;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/build-hakimi-win.js [options]

Options:
  --from <dir>             只读官方 Antigravity 目录 (默认自动检测 %LOCALAPPDATA%\\Programs\\Antigravity)
  --dest <dir>             输出独立副本目录 (默认 %LOCALAPPDATA%\\Programs\\Hakimi)
  --icon <file>            自定义应用图标（PNG/JPG/BMP/ICO），自动生成多尺寸 .ico 绑定快捷方式与窗口图标
  --restore-icon           恢复使用官方默认图标（清除沿用的自定义图标）
  --stage-only             仅在临时沙盒构建与校验，不改动目标目录与运行中进程
  --keep-stage             配合 --stage-only 保留临时沙盒目录供检查
  --client-lang <lang>     客户端界面语言 (zh-CN | en，默认 zh-CN)
  --no-restart             构建完成后不自动启动/重启
  --no-shortcut            不创建开始菜单与桌面快捷方式
  --no-desktop-shortcut    仅创建开始菜单快捷方式，不创建桌面图标
  --json                   输出结构化 JSON 结果
  -h, --help               显示帮助`);
}

if (require.main === module) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    const res = buildHakimiWin(opts);
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    }
  } catch (err) {
    console.error(`ERROR: ${err?.message || String(err)}`);
    process.exit(1);
  }
}

module.exports = {
  FUSE_SENTINEL,
  FUSE_NAMES,
  inspectElectronFuses,
  resolveOfficialSourceDir,
  validateOfficialSourceDir,
  copyDirectoryFiltered,
  findRunningWinPidsUnderRoot,
  stopWinProcessesUnderRoot,
  renameWithRetry,
  swapDirectoryWithRollback,
  packPngFramesToIco,
  buildWindowsIconAssets,
  createWindowsShortcuts,
  buildCleanLaunchEnv,
  launchWinApp,
  buildHakimiWin,
  parseCliArgs,
};
