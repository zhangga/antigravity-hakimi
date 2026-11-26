#!/usr/bin/env node
'use strict';

/**
 * Shared Antigravity official-feed fetcher, GitHub main patcher fetcher,
 * single-slot clean-base cache manager, sandbox stage-builder, and orphan GC.
 *
 * Used by BOTH:
 * - In-app `hakimi-updater.js` (via `ELECTRON_RUN_AS_NODE=1` child worker or direct calls)
 * - CLI `build-hakimi.sh --fetch-latest`
 *
 * Security invariants:
 * - Never writes, patches, or signs `/Applications/Antigravity.app` or `.orig`.
 * - Verifies official Antigravity zip SHA-512 and Google LLC Developer ID code signature
 *   (`TeamIdentifier=EQHXZ8M8AV`, `Identifier=com.google.antigravity`) before staging.
 * - Enforces strict single-slot clean-base zip cache (at most 1 zip matching installed version).
 * - Immediately cleans ephemeral Hakimi source tarballs and failed staging directories.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const asarEngine = require('./asar-engine');
const upgradeHelper = require('./hakimi-upgrade-helper');

const DEFAULT_OFFICIAL_FEED_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/';
const GITHUB_OWNER = 'cli117';
const GITHUB_REPO = 'antigravity-hakimi';
const GITHUB_BRANCH = 'main';
const GOOGLE_TEAM_ID = 'EQHXZ8M8AV';
const GOOGLE_BUNDLE_ID = 'com.google.antigravity';
const GOOGLE_AUTHORITY = 'Developer ID Application: Google LLC (EQHXZ8M8AV)';
const BUILD_META_FILENAME = 'hakimi-build-meta.json';
const CLEAN_BASE_META_FILENAME = 'clean-base-meta.json';
const UPDATER_STATE_FILENAME = 'state.json';
const SHA40_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DOWNLOAD_HTTP_TIMEOUT_MS = 180000;

const FALLBACK_APP_ENTITLEMENTS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0"><dict/></plist>\n';

const FALLBACK_LS_ENTITLEMENTS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0"><dict>\n' +
  '<key>com.apple.security.cs.allow-jit</key><true/>\n' +
  '<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>\n' +
  '<key>com.apple.security.cs.disable-library-validation</key><true/>\n' +
  '</dict></plist>\n';

function getUpdaterPaths(options = {}) {
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : asarEngine.getStateDir();
  const homeDir = options.homeDir ? path.resolve(String(options.homeDir)) : os.homedir();
  const updaterDir = path.join(stateDir, 'updater');
  const cleanBaseDir = path.join(updaterDir, 'clean-base');
  const stagingDir = path.join(updaterDir, 'staging');
  const tmpDir = path.join(updaterDir, 'tmp');
  const statePath = path.join(updaterDir, UPDATER_STATE_FILENAME);
  const nativeCacheDir = options.nativeCacheDir
    ? path.resolve(String(options.nativeCacheDir))
    : path.join(homeDir, 'Library', 'Caches', 'com.google.antigravity');
  return {
    stateDir,
    homeDir,
    updaterDir,
    cleanBaseDir,
    stagingDir,
    tmpDir,
    statePath,
    nativeCacheDir,
  };
}

function compareSemver(a, b) {
  const parse = (raw) => {
    const clean = String(raw || '').trim().replace(/^v/i, '');
    if (!clean) return { nums: [], pre: '' };
    const [core, ...preParts] = clean.split('-');
    const nums = core.split('.').map((n) => {
      const parsed = Number.parseInt(n, 10);
      return Number.isFinite(parsed) ? parsed : 0;
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

function isAllowedOfficialUrl(rawUrl, feedUrl = DEFAULT_OFFICIAL_FEED_URL) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (
      host === 'storage.googleapis.com' ||
      host.endsWith('.googleapis.com') ||
      host.endsWith('.run.app') ||
      host.endsWith('.google.com')
    ) {
      return true;
    }
    try {
      const feedHost = new URL(feedUrl).hostname.toLowerCase();
      if (host === feedHost) return true;
    } catch {}
    return false;
  } catch {
    return false;
  }
}

function isAllowedGithubUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'api.github.com' || host === 'codeload.github.com' || host === 'github.com';
  } catch {
    return false;
  }
}

function stripYamlScalar(raw) {
  let v = String(raw || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

function parseAppUpdateYml(ymlText) {
  const out = { provider: 'generic', url: '', updaterCacheDirName: 'com.google.antigravity' };
  for (const rawLine of String(ymlText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = stripYamlScalar(line.slice(idx + 1));
    if (key === 'provider') out.provider = val;
    else if (key === 'url') out.url = val;
    else if (key === 'updaterCacheDirName') out.updaterCacheDirName = val;
  }
  return out;
}

function resolveOfficialFeedUrl(appBundlePath) {
  const candidates = [];
  if (appBundlePath) {
    candidates.push(path.join(path.resolve(String(appBundlePath)), 'Contents', 'Resources', 'app-update.yml'));
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app-update.yml'));
  }
  candidates.push(path.join(asarEngine.getHakimiAppPath(), 'Contents', 'Resources', 'app-update.yml'));
  candidates.push('/Applications/Antigravity.app/Contents/Resources/app-update.yml');

  for (const ymlPath of candidates) {
    try {
      if (fs.existsSync(ymlPath)) {
        const parsed = parseAppUpdateYml(fs.readFileSync(ymlPath, 'utf8'));
        if (parsed.url && isAllowedOfficialUrl(parsed.url, parsed.url)) {
          return parsed.url.endsWith('/') ? parsed.url : `${parsed.url}/`;
        }
      }
    } catch {}
  }
  return DEFAULT_OFFICIAL_FEED_URL;
}

function parseLatestMacYml(ymlText) {
  const result = {
    version: '',
    path: '',
    sha512: '',
    releaseDate: '',
    files: [],
  };
  let inFiles = false;
  let currentFile = null;

  for (const rawLine of String(ymlText || '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.match(/^(\s*)/)[1].length;
    const trimmed = rawLine.trim();

    if (indent === 0) {
      inFiles = false;
      currentFile = null;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = stripYamlScalar(trimmed.slice(idx + 1));
      if (key === 'files') {
        inFiles = true;
      } else if (key === 'version') {
        result.version = val;
      } else if (key === 'path') {
        result.path = val;
      } else if (key === 'sha512') {
        result.sha512 = val;
      } else if (key === 'releaseDate') {
        result.releaseDate = val;
      }
      continue;
    }

    if (inFiles) {
      if (trimmed.startsWith('- ')) {
        currentFile = {};
        result.files.push(currentFile);
        const rest = trimmed.slice(2).trim();
        const idx = rest.indexOf(':');
        if (idx > 0) {
          const k = rest.slice(0, idx).trim();
          const v = stripYamlScalar(rest.slice(idx + 1));
          currentFile[k] = k === 'size' ? Number(v) : v;
        }
      } else if (currentFile) {
        const idx = trimmed.indexOf(':');
        if (idx > 0) {
          const k = trimmed.slice(0, idx).trim();
          const v = stripYamlScalar(trimmed.slice(idx + 1));
          currentFile[k] = k === 'size' ? Number(v) : v;
        }
      }
    }
  }

  return result;
}

function resolveFileDownloadUrl(rawFileUrl, feedUrl) {
  const s = String(rawFileUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const base = feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`;
  return new URL(s.replace(/^\/+/, ''), base).toString();
}

function manifestHasZipEntry(manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  if (files.some((f) => f && typeof f.url === 'string' && /\.zip(?:$|\?)/i.test(f.url))) {
    return true;
  }
  return Boolean(manifest?.path && /\.zip(?:$|\?)/i.test(manifest.path));
}

function selectMacZipFromManifest(manifest, feedUrl, arch = process.arch) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const zipCandidates = files.filter((f) => f && typeof f.url === 'string' && /\.zip(?:$|\?)/i.test(f.url));
  let chosen = null;
  if (zipCandidates.length > 0) {
    if (arch === 'arm64') {
      chosen =
        zipCandidates.find((f) => /arm64|darwin-arm/i.test(f.url)) ||
        zipCandidates[0];
    } else {
      chosen =
        zipCandidates.find((f) => !/arm64|darwin-arm/i.test(f.url)) ||
        zipCandidates[0];
    }
  } else if (manifest?.path && /\.zip(?:$|\?)/i.test(manifest.path)) {
    chosen = { url: manifest.path, sha512: manifest.sha512 || '', size: 0 };
  }
  if (!chosen || !chosen.url) {
    throw new Error('官方更新清单中未找到 macOS ZIP 安装包');
  }
  const downloadUrl = resolveFileDownloadUrl(chosen.url, feedUrl);
  if (!isAllowedOfficialUrl(downloadUrl, feedUrl)) {
    throw new Error(`拦截非官方白名单下载地址: ${downloadUrl}`);
  }
  const sha512 = String(chosen.sha512 || manifest?.sha512 || '').trim();
  if (!sha512) {
    throw new Error('官方更新清单缺少 SHA-512 校验摘要');
  }
  return {
    version: String(manifest.version || '').trim(),
    url: downloadUrl,
    sha512,
    size: Number.isFinite(chosen.size) ? chosen.size : 0,
    releaseDate: manifest.releaseDate || '',
  };
}

function defaultHttpRequest(targetUrl, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_HTTP_TIMEOUT_MS;
  const maxRedirects = Number.isFinite(options.maxRedirects) ? options.maxRedirects : 5;
  const allowUrlFn = typeof options.allowUrlFn === 'function' ? options.allowUrlFn : null;

  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, redirectsLeft) => {
      if (allowUrlFn && !allowUrlFn(currentUrl)) {
        reject(new Error(`拦截非允许域名的请求地址: ${currentUrl}`));
        return;
      }
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        reject(new Error(`无效 URL: ${currentUrl}`));
        return;
      }
      if (parsed.protocol !== 'https:') {
        reject(new Error(`仅允许 HTTPS 请求: ${currentUrl}`));
        return;
      }

      const req = https.get(
        parsed,
        {
          headers: {
            'User-Agent': 'antigravity-hakimi-updater',
            ...(options.headers || {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            const nextUrl = new URL(res.headers.location, currentUrl).toString();
            doRequest(nextUrl, redirectsLeft - 1);
            return;
          }

          if (options.destFilePath) {
            if (status < 200 || status >= 300) {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                resolve({
                  status,
                  headers: res.headers,
                  text: Buffer.concat(chunks).toString('utf8').slice(0, 500),
                });
              });
              return;
            }
            const dest = path.resolve(options.destFilePath);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const tmp = `${dest}.dl.${process.pid}.${Date.now()}`;
            const hash = options.computeSha512 ? crypto.createHash('sha512') : null;
            const out = fs.createWriteStream(tmp);
            let bytes = 0;
            let settled = false;
            const fail = (err) => {
              if (settled) return;
              settled = true;
              try { out.destroy(); } catch {}
              try { fs.unlinkSync(tmp); } catch {}
              reject(err);
            };
            res.on('data', (chunk) => {
              bytes += chunk.length;
              if (hash) hash.update(chunk);
            });
            res.on('error', fail);
            out.on('error', fail);
            out.on('finish', () => {
              if (settled) return;
              settled = true;
              try {
                fs.renameSync(tmp, dest);
                resolve({
                  status,
                  headers: res.headers,
                  filePath: dest,
                  bytes,
                  sha512: hash ? hash.digest('base64') : null,
                });
              } catch (e) {
                try { fs.unlinkSync(tmp); } catch {}
                reject(e);
              }
            });
            res.pipe(out);
            return;
          }

          const maxBytes =
            Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.floor(options.maxBytes) : 0;
          const chunks = [];
          let totalBytes = 0;
          let settled = false;
          const finishBody = (truncated = false) => {
            if (settled) return;
            settled = true;
            const buf = Buffer.concat(chunks);
            resolve({
              status,
              headers: res.headers,
              text: buf.toString('utf8'),
              buffer: buf,
              truncated,
            });
          };
          const failBody = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
          };
          res.on('data', (c) => {
            if (settled) return;
            chunks.push(c);
            totalBytes += c.length;
            if (maxBytes && totalBytes >= maxBytes) {
              finishBody(true);
              try { res.destroy(); } catch {}
              try { req.destroy(); } catch {}
            }
          });
          res.on('error', failBody);
          res.on('end', () => finishBody(false));
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`网络请求超时 (${timeoutMs}ms): ${currentUrl}`));
      });
      req.on('error', (err) => {
        reject(err);
      });
    };

    doRequest(targetUrl, maxRedirects);
  });
}

function computeFileSha512Base64(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('base64')));
  });
}

async function fetchOfficialLatestManifest(options = {}) {
  const feedUrl = options.feedUrl || resolveOfficialFeedUrl(options.appBundlePath);
  const arch = options.arch || process.arch || 'arm64';
  const manifestUrl = new URL(`latest-${arch}-mac.yml`, feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`).toString();
  const httpImpl = options.httpRequest || defaultHttpRequest;
  const currentVersion = options.currentVersion ? String(options.currentVersion).trim() : '';
  const requireDownload = options.requireDownload === true;

  const requestManifest = async (includeCurrentVersion) => {
    const headers = {};
    if (includeCurrentVersion && currentVersion) {
      headers['x-app-version'] = currentVersion;
    }
    const res = await httpImpl(manifestUrl, {
      headers,
      timeoutMs: options.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS,
      allowUrlFn: (u) => isAllowedOfficialUrl(u, feedUrl),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`拉取官方更新清单失败 (HTTP ${res.status}): ${manifestUrl}`);
    }
    const parsed = parseLatestMacYml(res.text);
    if (!parsed.version) {
      throw new Error('官方更新清单缺少 version 字段');
    }
    return parsed;
  };

  const sentCurrentVersion = Boolean(currentVersion && !requireDownload);
  let parsed = await requestManifest(sentCurrentVersion);

  if (!manifestHasZipEntry(parsed)) {
    // Official manifest server omits `files:`/`path:` (returning only `version: X.Y.Z`) when
    // `x-app-version` matches or exceeds the latest release. Treat as cleanly up-to-date.
    if (sentCurrentVersion && compareSemver(parsed.version, currentVersion) <= 0) {
      return {
        version: String(parsed.version).trim(),
        url: '',
        sha512: '',
        size: 0,
        releaseDate: parsed.releaseDate || '',
        upToDate: true,
        feedUrl,
        manifestUrl,
      };
    }
    // If a newer version was returned without files while x-app-version was sent, retry once without it.
    if (sentCurrentVersion) {
      parsed = await requestManifest(false);
    }
  }

  const selected = selectMacZipFromManifest(parsed, feedUrl, arch);
  return {
    ...selected,
    upToDate: Boolean(currentVersion && compareSemver(selected.version, currentVersion) <= 0),
    feedUrl,
    manifestUrl,
  };
}

function readCleanBaseMeta(cleanBaseDir) {
  const metaPath = path.join(cleanBaseDir, CLEAN_BASE_META_FILENAME);
  const readRes = upgradeHelper.readJsonFileSafe(metaPath, null);
  if (!readRes.ok || !readRes.data || typeof readRes.data !== 'object') return null;
  const fileName = String(readRes.data.fileName || '');
  const zipPath = fileName ? path.join(cleanBaseDir, fileName) : '';
  if (!zipPath || !fs.existsSync(zipPath)) return null;
  return {
    ...readRes.data,
    zipPath,
  };
}

function enforceSingleSlotCleanBase({ cleanBaseDir, keepVersion = '', keepFileName = '' }) {
  const removed = [];
  if (!cleanBaseDir || !fs.existsSync(cleanBaseDir)) return { removed };
  const targetKeep = keepFileName || (keepVersion ? `Antigravity-${keepVersion}.zip` : '');
  try {
    for (const name of fs.readdirSync(cleanBaseDir)) {
      if (name.endsWith('.zip') && name !== targetKeep) {
        if (upgradeHelper.unlinkIfExists(path.join(cleanBaseDir, name))) {
          removed.push(name);
        }
      }
    }
    if (!targetKeep || !fs.existsSync(path.join(cleanBaseDir, targetKeep))) {
      upgradeHelper.unlinkIfExists(path.join(cleanBaseDir, CLEAN_BASE_META_FILENAME));
    }
  } catch {}
  return { removed };
}

/**
 * Acquire verified official zip into `destZipPath` (preferring existing verified single-slot
 * clean-base or native pending cache before downloading over HTTPS).
 */
async function acquireOfficialVerifiedZip(manifest, destZipPath, options = {}) {
  const paths = getUpdaterPaths(options);
  const httpImpl = options.httpRequest || defaultHttpRequest;
  const expectedSha = String(manifest?.sha512 || '').trim();
  if (!manifest?.url || !expectedSha) {
    throw new Error('缺少官方安装包 URL 或 SHA-512 校验值');
  }

  fs.mkdirSync(path.dirname(destZipPath), { recursive: true });

  // 1. Check existing single-slot clean-base cache
  const cleanMeta = readCleanBaseMeta(paths.cleanBaseDir);
  if (cleanMeta && cleanMeta.version === manifest.version && fs.existsSync(cleanMeta.zipPath)) {
    const actualSha = await computeFileSha512Base64(cleanMeta.zipPath);
    if (actualSha === expectedSha) {
      return { zipPath: cleanMeta.zipPath, sha512: actualSha, source: 'clean-base-cache', reused: true };
    }
  }

  // 2. Check existing native Electron updater pending cache (avoids duplicate 216MB download!)
  const nativeCandidates = [
    path.join(paths.nativeCacheDir, 'pending', 'Antigravity.zip'),
    path.join(paths.nativeCacheDir, 'update.zip'),
  ];
  for (const cand of nativeCandidates) {
    if (!fs.existsSync(cand)) continue;
    try {
      const actualSha = await computeFileSha512Base64(cand);
      if (actualSha === expectedSha) {
        const officialRunning =
          options.skipOfficialRunningCheck === true
            ? false
            : upgradeHelper.findRunningTargetPids('/Applications/Antigravity.app', 'all', options).length > 0;
        if (!officialRunning && options.consumeNativePending !== false) {
          try {
            fs.renameSync(cand, destZipPath);
          } catch (err) {
            if (err && err.code === 'EXDEV') {
              fs.copyFileSync(cand, destZipPath);
              upgradeHelper.unlinkIfExists(cand);
            } else {
              throw err;
            }
          }
          if (cand.includes(`${path.sep}pending${path.sep}`)) {
            upgradeHelper.unlinkIfExists(path.join(paths.nativeCacheDir, 'pending', 'update-info.json'));
          }
          return { zipPath: destZipPath, sha512: actualSha, source: 'native-cache-moved', reused: true };
        }
        fs.copyFileSync(cand, destZipPath);
        return { zipPath: destZipPath, sha512: actualSha, source: 'native-cache-copied', reused: true };
      }
    } catch {}
  }

  // 3. Download from official GCS/feed URL with streaming SHA-512 verification
  const dlRes = await httpImpl(manifest.url, {
    destFilePath: destZipPath,
    computeSha512: true,
    timeoutMs: options.downloadTimeoutMs || DOWNLOAD_HTTP_TIMEOUT_MS,
    allowUrlFn: (u) => isAllowedOfficialUrl(u, manifest.feedUrl || DEFAULT_OFFICIAL_FEED_URL),
  });
  if (dlRes.status < 200 || dlRes.status >= 300) {
    upgradeHelper.unlinkIfExists(destZipPath);
    throw new Error(`下载官方安装包失败 (HTTP ${dlRes.status})`);
  }
  const actualSha = dlRes.sha512 || (await computeFileSha512Base64(destZipPath));
  if (actualSha !== expectedSha) {
    upgradeHelper.unlinkIfExists(destZipPath);
    throw new Error('官方安装包 SHA-512 校验不匹配，已自动丢弃');
  }
  return { zipPath: destZipPath, sha512: actualSha, source: 'downloaded', reused: false };
}

function verifyOfficialGoogleBundleSignature(appPath, options = {}) {
  const execImpl = options.execFileSync || execFileSync;
  if (!appPath || !fs.existsSync(appPath)) {
    throw new Error(`官方应用包不存在: ${appPath}`);
  }
  try {
    execImpl('/usr/bin/codesign', ['--verify', '--strict', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err?.stderr ? String(err.stderr).trim() : '') || err?.message || String(err);
    throw new Error(`官方包 codesign --verify 失败: ${detail}`);
  }

  let infoOut = '';
  try {
    execImpl('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    infoOut = `${err?.stdout || ''}\n${err?.stderr || ''}`;
  }
  // codesign -dv writes to stderr even on exit code 0; capture via spawnSync-like wrapper or 2>&1
  if (!infoOut) {
    const { spawnSync } = require('child_process');
    const r = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
    infoOut = `${r.stdout || ''}\n${r.stderr || ''}`;
  }
  if (!infoOut.includes(`TeamIdentifier=${GOOGLE_TEAM_ID}`)) {
    throw new Error(`官方包签名 TeamIdentifier 校验失败（预期 ${GOOGLE_TEAM_ID}）`);
  }
  if (!infoOut.includes(`Identifier=${GOOGLE_BUNDLE_ID}`)) {
    throw new Error(`官方包签名 Bundle Identifier 校验失败（预期 ${GOOGLE_BUNDLE_ID}）`);
  }
  if (!infoOut.includes(`Authority=${GOOGLE_AUTHORITY}`)) {
    throw new Error(`官方包签名证书颁发者校验失败（预期 ${GOOGLE_AUTHORITY}）`);
  }
  return { ok: true, teamId: GOOGLE_TEAM_ID, bundleId: GOOGLE_BUNDLE_ID };
}

function extractOfficialZipAndVerify(zipPath, extractDir, options = {}) {
  const execImpl = options.execFileSync || execFileSync;
  fs.mkdirSync(extractDir, { recursive: true });
  execImpl('/usr/bin/ditto', ['-xk', zipPath, extractDir], { stdio: 'pipe' });

  let appPath = path.join(extractDir, 'Antigravity.app');
  if (!fs.existsSync(appPath)) {
    const entries = fs.readdirSync(extractDir).filter((e) => e.endsWith('.app'));
    if (entries.length > 0) {
      appPath = path.join(extractDir, entries[0]);
    }
  }
  if (!fs.existsSync(appPath) || !fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))) {
    throw new Error('解压后的官方安装包中未找到有效的 Antigravity.app');
  }
  if (options.skipGoogleSignatureCheck !== true && process.platform === 'darwin') {
    verifyOfficialGoogleBundleSignature(appPath, options);
  }
  return appPath;
}

function decodeXmlEntities(str) {
  return String(str || '').replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, entity) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const cp = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (entity.startsWith('#')) {
      const cp = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return m;
  });
}

function parseGithubCommitsAtom(xmlText) {
  const entries = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(String(xmlText || ''))) !== null) {
    const block = m[1];
    const idMatch = block.match(/<id\b[^>]*>[^<]*Commit\/([0-9a-f]{40})\s*<\/id>/i);
    const linkMatch = block.match(/<link\b[^>]*href="[^"]*\/commit\/([0-9a-f]{40})[^"]*"/i);
    const sha = String((idMatch && idMatch[1]) || (linkMatch && linkMatch[1]) || '')
      .trim()
      .toLowerCase();
    if (!SHA40_RE.test(sha)) continue;
    const titleMatch = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const updatedMatch = block.match(/<updated\b[^>]*>([^<]+)<\/updated>/i);
    const message = decodeXmlEntities(titleMatch ? titleMatch[1] : '')
      .trim()
      .split(/\r?\n/)[0]
      .trim();
    const date = String(updatedMatch ? updatedMatch[1] : '').trim();
    entries.push({ sha, message, date });
  }
  return entries;
}

function parseGitUploadPackBranchSha(rawText, branch = GITHUB_BRANCH) {
  const escapedBranch = String(branch || GITHUB_BRANCH).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`([0-9a-f]{40})\\s+refs/heads/${escapedBranch}(?:\\0|\\r|\\n|$)`, 'i');
  const m = String(rawText || '').match(re);
  return m ? m[1].toLowerCase() : '';
}

async function checkHakimiMainUpdate(options = {}) {
  const owner = options.githubOwner || GITHUB_OWNER;
  const repo = options.githubRepo || GITHUB_REPO;
  const branch = options.githubBranch || GITHUB_BRANCH;
  const installedCommit = String(options.installedCommit || '').trim();
  const httpImpl = options.httpRequest || defaultHttpRequest;
  const timeoutMs = options.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS;
  const webHeaders = {
    'User-Agent': 'antigravity-hakimi-updater',
  };

  // Query public github.com web endpoints instead of api.github.com so checks never hit
  // the 60 req/hr unauthenticated REST API rate limit on shared proxy/NAT egress IPs.
  let atomCommits = [];
  let latestSha = '';
  let commitMessage = '';
  let commitDate = '';
  let atomError = null;

  const atomUrl = `https://github.com/${owner}/${repo}/commits/${encodeURIComponent(branch)}.atom`;
  try {
    const atomRes = await httpImpl(atomUrl, {
      headers: { ...webHeaders, Accept: 'application/atom+xml, application/xml, text/xml' },
      timeoutMs,
      allowUrlFn: isAllowedGithubUrl,
    });
    if (atomRes.status >= 200 && atomRes.status < 300) {
      atomCommits = parseGithubCommitsAtom(atomRes.text);
      if (atomCommits.length > 0) {
        latestSha = atomCommits[0].sha;
        commitMessage = atomCommits[0].message;
        commitDate = atomCommits[0].date;
      } else {
        atomError = new Error('GitHub commits 订阅源未解析到有效提交记录');
      }
    } else {
      atomError = new Error(`查询 GitHub main 最新提交失败 (HTTP ${atomRes.status})`);
    }
  } catch (err) {
    atomError = err;
  }

  if (!SHA40_RE.test(latestSha)) {
    const refsUrl = `https://github.com/${owner}/${repo}.git/info/refs?service=git-upload-pack`;
    const refsRes = await httpImpl(refsUrl, {
      headers: webHeaders,
      timeoutMs,
      allowUrlFn: isAllowedGithubUrl,
    });
    if (refsRes.status < 200 || refsRes.status >= 300) {
      throw atomError || new Error(`查询 GitHub main 最新提交失败 (HTTP ${refsRes.status})`);
    }
    latestSha = parseGitUploadPackBranchSha(refsRes.text, branch);
    if (!SHA40_RE.test(latestSha)) {
      throw atomError || new Error('GitHub 返回的 main commit SHA 格式无效');
    }
  }

  const latestShort = latestSha.slice(0, 7);

  if (!installedCommit || !SHA40_RE.test(installedCommit)) {
    return {
      ok: true,
      status: 'ahead',
      updateAvailable: true,
      aheadBy: null,
      installedCommit: installedCommit || null,
      latestSha,
      latestShort,
      commitMessage,
      commitDate,
    };
  }

  const installedLower = installedCommit.toLowerCase();
  const latestLower = latestSha.toLowerCase();

  if (installedLower === latestLower) {
    return {
      ok: true,
      status: 'identical',
      updateAvailable: false,
      aheadBy: 0,
      installedCommit,
      latestSha,
      latestShort,
      commitMessage,
      commitDate,
    };
  }

  // Fast path: if installedCommit appears directly in main's recent Atom history,
  // it is guaranteed to be an ancestor of latestSha (zero extra compare requests).
  const atomIdx = atomCommits.findIndex((c) => c.sha.toLowerCase() === installedLower);
  if (atomIdx > 0) {
    return {
      ok: true,
      status: 'ahead',
      updateAvailable: true,
      aheadBy: atomIdx,
      behindBy: 0,
      installedCommit,
      latestSha,
      latestShort,
      commitMessage,
      commitDate,
    };
  }

  // Ancestry comparison via public github.com .patch endpoints (zero api.github.com quota).
  // `maxBytes: 1024` detects empty vs non-empty patch immediately without downloading large diffs.
  const fwdUrl = `https://github.com/${owner}/${repo}/compare/${installedCommit}...${latestSha}.patch`;
  const fwdRes = await httpImpl(fwdUrl, {
    headers: webHeaders,
    timeoutMs,
    maxBytes: 1024,
    allowUrlFn: isAllowedGithubUrl,
  });

  if (fwdRes.status === 404) {
    // Installed commit does not exist on GitHub (developer local unpushed commit)
    return {
      ok: true,
      status: 'local_unpushed',
      updateAvailable: false,
      aheadBy: 0,
      installedCommit,
      latestSha,
      latestShort,
      commitMessage,
      commitDate,
    };
  }
  if (fwdRes.status < 200 || fwdRes.status >= 300) {
    throw new Error(`比对 GitHub main 提交关系失败 (HTTP ${fwdRes.status})`);
  }

  const revUrl = `https://github.com/${owner}/${repo}/compare/${latestSha}...${installedCommit}.patch`;
  const revRes = await httpImpl(revUrl, {
    headers: webHeaders,
    timeoutMs,
    maxBytes: 1024,
    allowUrlFn: isAllowedGithubUrl,
  });

  if (revRes.status === 404) {
    return {
      ok: true,
      status: 'local_unpushed',
      updateAvailable: false,
      aheadBy: 0,
      installedCommit,
      latestSha,
      latestShort,
      commitMessage,
      commitDate,
    };
  }
  if (revRes.status < 200 || revRes.status >= 300) {
    throw new Error(`比对 GitHub main 提交关系失败 (HTTP ${revRes.status})`);
  }

  const mainHasNew = String(fwdRes.text || '').trim().length > 0;
  const localHasExtra = String(revRes.text || '').trim().length > 0;

  if (mainHasNew && !localHasExtra) {
    return {
      ok: true,
      status: 'ahead',
      updateAvailable: true,
      aheadBy: null,
      behindBy: 0,
      installedCommit,
      latestSha,
      latestShort,
      commitMessage,
      commitDate,
    };
  }
  if (!mainHasNew && !localHasExtra) {
    return {
      ok: true,
      status: 'identical',
      updateAvailable: false,
      aheadBy: 0,
      behindBy: 0,
      installedCommit,
      latestSha,
      latestShort,
      commitMessage,
      commitDate,
    };
  }
  if (!mainHasNew && localHasExtra) {
    return {
      ok: true,
      status: 'local_ahead',
      updateAvailable: false,
      aheadBy: 0,
      behindBy: null,
      installedCommit,
      latestSha,
      latestShort,
      commitMessage,
      commitDate,
    };
  }
  return {
    ok: true,
    status: 'diverged',
    updateAvailable: false,
    aheadBy: null,
    behindBy: null,
    installedCommit,
    latestSha,
    latestShort,
    commitMessage,
    commitDate,
  };
}

async function downloadAndExtractHakimiTarball({ sha, destTmpDir }, options = {}) {
  const cleanSha = String(sha || '').trim();
  if (!SHA40_RE.test(cleanSha)) {
    throw new Error(`非法 GitHub commit SHA: ${cleanSha}`);
  }
  const owner = options.githubOwner || GITHUB_OWNER;
  const repo = options.githubRepo || GITHUB_REPO;
  const httpImpl = options.httpRequest || defaultHttpRequest;
  const execImpl = options.execFileSync || execFileSync;

  const workDir = path.resolve(String(destTmpDir));
  fs.mkdirSync(workDir, { recursive: true });
  const tarPath = path.join(workDir, `hakimi-${cleanSha.slice(0, 12)}.tar.gz`);
  const extractDir = path.join(workDir, 'src');
  fs.mkdirSync(extractDir, { recursive: true });

  const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${cleanSha}`;
  const dlRes = await httpImpl(tarUrl, {
    destFilePath: tarPath,
    timeoutMs: options.downloadTimeoutMs || DOWNLOAD_HTTP_TIMEOUT_MS,
    allowUrlFn: isAllowedGithubUrl,
  });
  if (dlRes.status < 200 || dlRes.status >= 300) {
    upgradeHelper.unlinkIfExists(tarPath);
    throw new Error(`下载哈基米源码包失败 (HTTP ${dlRes.status})`);
  }

  try {
    execImpl('/usr/bin/tar', ['-xzf', tarPath, '-C', extractDir], { stdio: 'pipe' });
  } finally {
    upgradeHelper.unlinkIfExists(tarPath);
  }

  const dirs = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(extractDir, d.name));
  const repoRoot = dirs.find(
    (d) =>
      fs.existsSync(path.join(d, 'scripts', 'pack-hakimi-asar.js')) &&
      fs.existsSync(path.join(d, 'payload', 'dist', 'meter-region-unlock.js'))
  );
  if (!repoRoot) {
    throw new Error('解压后的哈基米源码包缺少必要的 scripts/ 或 payload/dist/ 文件');
  }
  return repoRoot;
}

function readBundleShortVersion(plistPath) {
  if (!plistPath || !fs.existsSync(plistPath)) return null;
  try {
    const xml = fs.readFileSync(plistPath, 'utf8');
    const m = xml.match(/<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function readInstalledBuildMeta(appBundlePath) {
  const bundle = appBundlePath ? path.resolve(String(appBundlePath)) : asarEngine.getHakimiAppPath();
  const plistPath = path.join(bundle, 'Contents', 'Info.plist');
  const resDir = asarEngine.getResourcesDir(bundle);
  const metaPath = path.join(resDir, BUILD_META_FILENAME);
  const plistVersion = readBundleShortVersion(plistPath);
  const res = upgradeHelper.readJsonFileSafe(metaPath, null);
  const parsed = res.ok && res.data && typeof res.data === 'object' ? res.data : {};
  const hakimiCommit = typeof parsed.hakimiCommit === 'string' && SHA40_RE.test(parsed.hakimiCommit.trim())
    ? parsed.hakimiCommit.trim()
    : null;
  return {
    schemaVersion: 1,
    antigravityVersion: plistVersion || parsed.antigravityVersion || null,
    hakimiVersion: parsed.hakimiVersion || null,
    hakimiCommit,
    hakimiCommitShort: hakimiCommit ? hakimiCommit.slice(0, 7) : (parsed.hakimiCommitShort || null),
    hakimiCommitDate: parsed.hakimiCommitDate || null,
    gitDirty: Boolean(parsed.gitDirty),
    sourceKind: parsed.sourceKind || 'unknown',
    builtAt: parsed.builtAt || null,
  };
}

function writeBuildMeta(appBundlePath, meta = {}) {
  const bundle = path.resolve(String(appBundlePath));
  asarEngine.assertNotOfficialAntigravityApp(bundle, '写入构建回执');
  const resDir = asarEngine.getResourcesDir(bundle);
  const metaPath = path.join(resDir, BUILD_META_FILENAME);
  const commit = typeof meta.hakimiCommit === 'string' && SHA40_RE.test(meta.hakimiCommit.trim())
    ? meta.hakimiCommit.trim()
    : null;
  const payload = {
    schemaVersion: 1,
    antigravityVersion: meta.antigravityVersion || readBundleShortVersion(path.join(bundle, 'Contents', 'Info.plist')) || null,
    hakimiVersion: meta.hakimiVersion || null,
    hakimiCommit: commit,
    hakimiCommitShort: commit ? commit.slice(0, 7) : null,
    hakimiCommitDate: meta.hakimiCommitDate || null,
    gitDirty: Boolean(meta.gitDirty),
    sourceKind: meta.sourceKind || 'official-local',
    builtAt: meta.builtAt || new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

function updateInfoPlistIntegrity(plistPath, newAsarHash, usingCustomIcon, options = {}) {
  const execImpl = options.execFileSync || execFileSync;
  if (!/^[0-9a-f]{64}$/i.test(String(newAsarHash || ''))) {
    throw new Error(`非法 ASAR 摘要长度: ${newAsarHash}`);
  }
  asarEngine.assertNotOfficialAntigravityApp(plistPath, '更新 Info.plist');

  if (options.useXmlFallback !== true && process.platform === 'darwin' && fs.existsSync('/usr/bin/plutil')) {
    const jsonText = execImpl('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const plistObj = JSON.parse(jsonText);
    if (!plistObj.ElectronAsarIntegrity || typeof plistObj.ElectronAsarIntegrity !== 'object') {
      plistObj.ElectronAsarIntegrity = {};
    }
    plistObj.ElectronAsarIntegrity['Resources/app.asar'] = {
      algorithm: 'SHA256',
      hash: newAsarHash,
    };
    if (usingCustomIcon) {
      delete plistObj.CFBundleIconName;
    }
    const tmpJson = `${plistPath}.tmp.${process.pid}.json`;
    try {
      fs.writeFileSync(tmpJson, JSON.stringify(plistObj), 'utf8');
      execImpl('/usr/bin/plutil', ['-convert', 'xml1', '-o', plistPath, tmpJson], { stdio: 'pipe' });
    } finally {
      upgradeHelper.unlinkIfExists(tmpJson);
    }
    return;
  }

  // Pure XML fallback for synthetic tests
  let xml = fs.readFileSync(plistPath, 'utf8');
  const hashRe = /(<key>\s*Resources\/app\.asar\s*<\/key>\s*<dict>[\s\S]*?<key>\s*hash\s*<\/key>\s*<string>)([^<]*)(<\/string>)/;
  if (hashRe.test(xml)) {
    xml = xml.replace(hashRe, `$1${newAsarHash}$3`);
  } else {
    xml = xml.replace(
      /<\/dict>\s*<\/plist>/,
      `<key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${newAsarHash}</string></dict></dict></dict></plist>`
    );
  }
  if (usingCustomIcon) {
    xml = xml.replace(/<key>\s*CFBundleIconName\s*<\/key>\s*<string>[^<]*<\/string>\s*/g, '');
  }
  fs.writeFileSync(plistPath, xml, 'utf8');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function extractEntitlements(targetPath, fallbackXml, execImpl = execFileSync) {
  try {
    const out = execImpl('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', targetPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (out && out.trim().startsWith('<?xml')) return out;
  } catch {}
  return fallbackXml;
}

function cloneAppBundle(srcAppPath, destAppPath, execImpl = execFileSync) {
  asarEngine.assertNotOfficialAntigravityApp(destAppPath, '复制沙盒应用');
  fs.mkdirSync(path.dirname(destAppPath), { recursive: true });
  if (process.platform === 'darwin') {
    try {
      // APFS Copy-on-Write clone: near-instant & zero extra disk until modified
      execImpl('/bin/cp', ['-c', '-R', '-p', srcAppPath, destAppPath], { stdio: 'pipe' });
      return;
    } catch {}
  }
  execImpl('/bin/cp', ['-R', '-p', srcAppPath, destAppPath], { stdio: 'pipe' });
}

/**
 * Full sandbox stage-build with structured per-stage failure reporting.
 * Always deletes `stageDir` immediately if any stage fails.
 */
function stageBuildHakimiApp(spec = {}, options = {}) {
  const execImpl = options.execFileSync || execFileSync;
  const sourceAppPath = path.resolve(String(spec.sourceAppPath || ''));
  const stageDir = path.resolve(String(spec.stageDir || ''));
  const targetInstalledAppPath = spec.targetInstalledAppPath
    ? path.resolve(String(spec.targetInstalledAppPath))
    : asarEngine.getHakimiAppPath();
  const patcherRoot = spec.patcherRoot ? path.resolve(String(spec.patcherRoot)) : null;

  asarEngine.assertNotOfficialAntigravityApp(stageDir, '创建沙盒目录');
  const stageAppPath = path.join(stageDir, '哈基米.app');
  asarEngine.assertNotOfficialAntigravityApp(stageAppPath, '构建沙盒应用');

  let currentStage = 'preflight';
  try {
    if (!fs.existsSync(sourceAppPath)) {
      throw new Error(`找不到源应用包: ${sourceAppPath}`);
    }
    const srcAsar = path.join(sourceAppPath, 'Contents', 'Resources', 'app.asar');
    const srcLs = path.join(sourceAppPath, 'Contents', 'Resources', 'bin', 'language_server');
    if (!fs.existsSync(srcAsar)) throw new Error(`源应用缺少 app.asar: ${srcAsar}`);
    if (!fs.existsSync(srcLs)) throw new Error(`源应用缺少 language_server: ${srcLs}`);

    const sourceVersion =
      spec.antigravityVersion || readBundleShortVersion(path.join(sourceAppPath, 'Contents', 'Info.plist')) || 'unknown';

    // Stage 1: Clone clean source bundle into staging directory
    currentStage = 'copy-source';
    if (fs.existsSync(stageDir)) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
    fs.mkdirSync(stageDir, { recursive: true });
    cloneAppBundle(sourceAppPath, stageAppPath, execImpl);

    const stageLs = path.join(stageAppPath, 'Contents', 'Resources', 'bin', 'language_server');
    const stageAsar = path.join(stageAppPath, 'Contents', 'Resources', 'app.asar');
    const stagePlist = path.join(stageAppPath, 'Contents', 'Info.plist');

    // Stage 2: Extract official entitlements before mutating binaries
    currentStage = 'entitlements';
    const entAppPath = path.join(stageDir, 'app.entitlements');
    const entLsPath = path.join(stageDir, 'ls.entitlements');
    if (options.skipCodesign !== true && process.platform === 'darwin') {
      fs.writeFileSync(entAppPath, extractEntitlements(sourceAppPath, FALLBACK_APP_ENTITLEMENTS, execImpl), 'utf8');
      fs.writeFileSync(entLsPath, extractEntitlements(srcLs, FALLBACK_LS_ENTITLEMENTS, execImpl), 'utf8');
    }

    // Stage 3: Region / Free-tier unlock patch on language_server
    currentStage = 'region-unlock';
    const regionUnlockMod = patcherRoot
      ? require(path.join(patcherRoot, 'payload', 'dist', 'meter-region-unlock.js'))
      : require('./meter-region-unlock');
    const unlockRes = regionUnlockMod.applyRegionUnlock(stageLs, { quiet: true });
    if (!unlockRes || !unlockRes.ok || (unlockRes.status !== 'patched' && unlockRes.status !== 'already_patched')) {
      throw new Error(unlockRes?.reason || unlockRes?.message || 'language_server 地区解锁补丁未匹配');
    }
    const verifyReg = regionUnlockMod.analyzeRegionUnlock(stageLs, { quiet: true });
    if (!verifyReg || verifyReg.status !== 'patched') {
      throw new Error(`language_server 地区解锁复检失败: ${verifyReg?.status || 'unknown'}`);
    }

    // Stage 4: Automatically preserve custom icon if installed 哈基米.app has one
    currentStage = 'custom-icon';
    let usingCustomIcon = false;
    let customIconPngPath = null;
    if (spec.preserveCustomIcon !== false && fs.existsSync(targetInstalledAppPath)) {
      const srcIcns = path.join(sourceAppPath, 'Contents', 'Resources', 'icon.icns');
      const curIcns = path.join(targetInstalledAppPath, 'Contents', 'Resources', 'icon.icns');
      const curAsar = path.join(targetInstalledAppPath, 'Contents', 'Resources', 'app.asar');
      if (fs.existsSync(srcIcns) && fs.existsSync(curIcns) && fs.existsSync(curAsar)) {
        if (sha256File(srcIcns) !== sha256File(curIcns)) {
          usingCustomIcon = true;
          fs.copyFileSync(curIcns, path.join(stageAppPath, 'Contents', 'Resources', 'icon.icns'));
          try {
            const iconBuf = asarEngine.builtinAsar.extractFile(curAsar, 'icon.png');
            customIconPngPath = path.join(stageDir, 'carryover-icon-512.png');
            fs.writeFileSync(customIconPngPath, iconBuf);
          } catch {}
          upgradeHelper.unlinkIfExists(path.join(stageAppPath, 'Contents', 'Resources', 'Assets.car'));
        }
      }
    }

    // Stage 5: Repack app.asar (utils + preload + SSH + updater wrapper + payload)
    currentStage = 'pack-asar';
    const packerMod = patcherRoot
      ? require(path.join(patcherRoot, 'scripts', 'pack-hakimi-asar.js'))
      : require('./hakimi-asar-packer');
    const payloadDistDir = patcherRoot ? path.join(patcherRoot, 'payload', 'dist') : __dirname;
    const packRes = packerMod.packHakimiAsar({
      srcAsar,
      destAsar: stageAsar,
      payloadDistDir,
      iconPng: customIconPngPath,
      skipConfig: true,
    });
    if (!packRes || !packRes.ok || !packRes.sha256) {
      throw new Error('app.asar 重打包失败');
    }

    // Stage 6: Update Info.plist ASAR integrity hash & write build metadata receipt
    currentStage = 'info-plist';
    updateInfoPlistIntegrity(stagePlist, packRes.sha256, usingCustomIcon, options);

    currentStage = 'build-meta';
    let hakimiVersion = spec.hakimiVersion || null;
    if (!hakimiVersion && patcherRoot && fs.existsSync(path.join(patcherRoot, 'package.json'))) {
      try {
        hakimiVersion = JSON.parse(fs.readFileSync(path.join(patcherRoot, 'package.json'), 'utf8')).version || null;
      } catch {}
    }
    if (!hakimiVersion) {
      try {
        hakimiVersion = require('./modules-config').PROJECT_VERSION || null;
      } catch {}
    }
    const buildMeta = writeBuildMeta(stageAppPath, {
      antigravityVersion: sourceVersion,
      hakimiVersion,
      hakimiCommit: spec.hakimiCommit || null,
      hakimiCommitDate: spec.hakimiCommitDate || null,
      gitDirty: Boolean(spec.gitDirty),
      sourceKind: spec.sourceKind || 'official-feed',
    });

    // Stage 7: Inode refresh + macOS codesign + strict verification
    currentStage = 'codesign';
    const mainExec = path.join(stageAppPath, 'Contents', 'MacOS', 'Antigravity');
    if (fs.existsSync(mainExec)) {
      const tmpInode = `${mainExec}.tmp_inode`;
      fs.copyFileSync(mainExec, tmpInode);
      fs.chmodSync(tmpInode, fs.statSync(mainExec).mode);
      fs.renameSync(tmpInode, mainExec);
    }
    if (options.skipCodesign !== true && process.platform === 'darwin') {
      execImpl(
        '/usr/bin/codesign',
        ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entLsPath, stageLs],
        { stdio: 'pipe' }
      );
      // Outer app MUST NOT use --options runtime so Library Validation allows Google-signed Electron Framework
      execImpl(
        '/usr/bin/codesign',
        ['--force', '--sign', '-', '--entitlements', entAppPath, stageAppPath],
        { stdio: 'pipe' }
      );
      currentStage = 'verify';
      execImpl('/usr/bin/codesign', ['--verify', '--strict', stageLs], { stdio: 'pipe' });
      execImpl('/usr/bin/codesign', ['--verify', '--strict', stageAppPath], { stdio: 'pipe' });
    }

    // Clean ephemeral build helpers in stageDir (keep only 哈基米.app + optional staged clean zip)
    upgradeHelper.unlinkIfExists(entAppPath);
    upgradeHelper.unlinkIfExists(entLsPath);
    if (customIconPngPath) upgradeHelper.unlinkIfExists(customIconPngPath);

    return {
      ok: true,
      stageDir,
      stagedAppPath: stageAppPath,
      antigravityVersion: sourceVersion,
      hakimiVersion: buildMeta.hakimiVersion,
      hakimiCommit: buildMeta.hakimiCommit,
      asarSha256: packRes.sha256,
      usingCustomIcon,
      inspect: packRes.inspect,
      buildMeta,
    };
  } catch (err) {
    // Immediately clean failed staging directory to keep 0 wasted disk space
    try {
      if (fs.existsSync(stageDir)) {
        asarEngine.assertNotOfficialAntigravityApp(stageDir, '清理失败沙盒');
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
    } catch {}
    return {
      ok: false,
      failedStage: currentStage,
      error: err?.message || String(err),
    };
  }
}

/**
 * Startup Orphan GC:
 * 1. Cleans leftover `updater/tmp/*` (interrupted downloads / extracted tarballs).
 * 2. Cleans orphan `.prev` / `.incoming` bundles beside target app when no cold-swap lock is alive.
 * 3. Cleans orphaned `updater/staging/*` directories not referenced by an active valid `ready` entry
 *    (or whose target version+commit is already installed).
 * 4. Enforces single-slot `updater/clean-base/` (at most 1 zip matching `installedVersion`).
 * 5. Cleans duplicate native `~/Library/Caches/com.google.antigravity` zip copies when safe.
 */
function cleanupOrphanUpdaterArtifacts(options = {}) {
  const paths = getUpdaterPaths(options);
  const targetAppPath = options.targetAppPath
    ? path.resolve(String(options.targetAppPath))
    : asarEngine.getHakimiAppPath();
  const installedMeta = options.installedMeta || readInstalledBuildMeta(targetAppPath);
  const installedVersion = installedMeta?.antigravityVersion || '';
  const installedCommit = installedMeta?.hakimiCommit || '';

  const report = {
    cleanedTmp: [],
    cleanedStaging: [],
    cleanedPrev: [],
    cleanedCleanBase: [],
    cleanedNativeCache: [],
  };

  // Skip aggressive cleanup while an active cold-swap helper holds a live lock
  const lockPath = upgradeHelper.getUpgradeLockPath({ stateDir: paths.stateDir });
  let coldSwapActive = false;
  if (fs.existsSync(lockPath)) {
    const lockData = upgradeHelper.readJsonFileSafe(lockPath, null);
    const pid = Number(lockData?.data?.pid || 0);
    if (pid > 0 && upgradeHelper.isPidAlive(pid, options.killImpl)) {
      coldSwapActive = true;
    } else {
      upgradeHelper.unlinkIfExists(lockPath);
    }
  }

  // 1. Clean ephemeral updater/tmp/*
  if (!options.skipTmpCleanup && fs.existsSync(paths.tmpDir)) {
    try {
      for (const name of fs.readdirSync(paths.tmpDir)) {
        const full = path.join(paths.tmpDir, name);
        asarEngine.assertNotOfficialAntigravityApp(full, '清理临时目录');
        fs.rmSync(full, { recursive: true, force: true });
        report.cleanedTmp.push(name);
      }
    } catch {}
  }

  // 2. Clean orphan .prev / .incoming siblings beside target app
  if (!coldSwapActive && targetAppPath) {
    const parentDir = path.dirname(targetAppPath);
    const baseName = path.basename(targetAppPath);
    const prevPrefix = `.${baseName}.prev`;
    const incomingPrefix = `.${baseName}.incoming`;
    if (fs.existsSync(parentDir)) {
      try {
        for (const name of fs.readdirSync(parentDir)) {
          if (name.startsWith(prevPrefix) || name.startsWith(incomingPrefix)) {
            const full = path.join(parentDir, name);
            if (!asarEngine.isOfficialAntigravityPath(full)) {
              fs.rmSync(full, { recursive: true, force: true });
              report.cleanedPrev.push(name);
            }
          }
        }
      } catch {}
    }
  }

  // 3. Reconcile updater/state.json staged entry & remove stale staging dirs
  const stateRead = upgradeHelper.readJsonFileSafe(paths.statePath, null);
  const persisted = stateRead.ok && stateRead.data && typeof stateRead.data === 'object' ? stateRead.data : null;
  let activeStagingDirName = null;
  if (persisted?.staged && persisted.staged.stagingRootDir) {
    const stagedRoot = path.resolve(String(persisted.staged.stagingRootDir));
    const stagedApp = persisted.staged.stagedAppPath ? path.resolve(String(persisted.staged.stagedAppPath)) : '';
    const alreadyInstalled =
      Boolean(installedVersion) &&
      persisted.staged.targetAntigravityVersion === installedVersion &&
      (!persisted.staged.targetHakimiCommit ||
        (installedCommit && persisted.staged.targetHakimiCommit.toLowerCase() === installedCommit.toLowerCase()));
    if (!alreadyInstalled && stagedApp && fs.existsSync(stagedApp)) {
      activeStagingDirName = path.basename(stagedRoot);
    } else if (persisted) {
      // Clear stale/already-installed staged pointer
      upgradeHelper.writeJsonFileAtomic(paths.statePath, { ...persisted, staged: null }, 0o600);
    }
  }
  if (fs.existsSync(paths.stagingDir)) {
    try {
      for (const name of fs.readdirSync(paths.stagingDir)) {
        if (name === activeStagingDirName) continue;
        const full = path.join(paths.stagingDir, name);
        asarEngine.assertNotOfficialAntigravityApp(full, '清理孤儿沙盒');
        fs.rmSync(full, { recursive: true, force: true });
        report.cleanedStaging.push(name);
      }
    } catch {}
  }

  // 4. Enforce single-slot clean-base cache (keep ONLY zip matching installedVersion)
  if (fs.existsSync(paths.cleanBaseDir)) {
    const cbRes = enforceSingleSlotCleanBase({
      cleanBaseDir: paths.cleanBaseDir,
      keepVersion: installedVersion,
    });
    report.cleanedCleanBase.push(...cbRes.removed);
  }

  // 5. Avoid duplicating 216MB zip in ~/Library/Caches/com.google.antigravity/ when safe
  if (fs.existsSync(paths.nativeCacheDir)) {
    const officialRunning =
      options.skipOfficialRunningCheck === true
        ? false
        : upgradeHelper.findRunningTargetPids('/Applications/Antigravity.app', 'all', options).length > 0;
    if (!officialRunning) {
      const hasCleanSlot = Boolean(readCleanBaseMeta(paths.cleanBaseDir));
      const updateZip = path.join(paths.nativeCacheDir, 'update.zip');
      if (hasCleanSlot && fs.existsSync(updateZip)) {
        if (upgradeHelper.unlinkIfExists(updateZip)) report.cleanedNativeCache.push('update.zip');
      }
      // If pending/Antigravity.zip matches a version already staged or already installed, remove duplicate
      const pendingZip = path.join(paths.nativeCacheDir, 'pending', 'Antigravity.zip');
      if (hasCleanSlot && fs.existsSync(pendingZip)) {
        const cleanMeta = readCleanBaseMeta(paths.cleanBaseDir);
        const pendingInfo = upgradeHelper.readJsonFileSafe(
          path.join(paths.nativeCacheDir, 'pending', 'update-info.json'),
          null
        );
        if (cleanMeta?.sha512 && pendingInfo?.data?.sha512 && cleanMeta.sha512 === pendingInfo.data.sha512) {
          if (upgradeHelper.unlinkIfExists(pendingZip)) report.cleanedNativeCache.push('pending/Antigravity.zip');
          upgradeHelper.unlinkIfExists(path.join(paths.nativeCacheDir, 'pending', 'update-info.json'));
        }
      }
    }
  }

  return report;
}

async function runCli(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const getArg = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : null;
  };

  if (cmd === 'fetch-official') {
    const outAppDir = getArg('--out-app-dir');
    if (!outAppDir) throw new Error('Missing --out-app-dir');
    const appBundle = getArg('--app-bundle');
    const keepZipOut = getArg('--keep-zip-out');
    const stateDir = getArg('--state-dir');
    const jsonOut = argv.includes('--json');

    const manifest = await fetchOfficialLatestManifest({ appBundlePath: appBundle });
    const tmpZip = keepZipOut
      ? path.resolve(keepZipOut)
      : path.join(path.resolve(outAppDir), `Antigravity-${manifest.version}.zip`);
    const acquired = await acquireOfficialVerifiedZip(manifest, tmpZip, {
      consumeNativePending: false,
      ...(stateDir ? { stateDir } : {}),
    });
    const appPath = extractOfficialZipAndVerify(acquired.zipPath, path.resolve(outAppDir));
    if (!keepZipOut && acquired.zipPath === tmpZip) {
      upgradeHelper.unlinkIfExists(tmpZip);
    }
    const keptZipPath = keepZipOut && acquired.zipPath === tmpZip ? tmpZip : '';
    const summary = {
      ok: true,
      version: manifest.version,
      sha512: manifest.sha512,
      appPath,
      source: acquired.source,
      zipPath: keptZipPath,
      needsPromotion: Boolean(keptZipPath && acquired.source !== 'clean-base-cache'),
    };
    if (jsonOut) process.stdout.write(JSON.stringify(summary) + '\n');
    else process.stdout.write(`${appPath}\n`);
    return;
  }

  if (cmd === 'promote-clean-base') {
    const zipPath = getArg('--zip');
    const version = getArg('--version');
    const sha512 = getArg('--sha512') || '';
    const stateDir = getArg('--state-dir');
    if (!zipPath || !version) throw new Error('Missing --zip or --version');
    const paths = getUpdaterPaths(stateDir ? { stateDir } : {});
    const res = upgradeHelper.promoteSingleSlotCleanBase({
      stagedZipPath: zipPath,
      cleanBaseDir: paths.cleanBaseDir,
      version,
      sha512,
    });
    if (res.promoted && !stateDir) {
      try {
        cleanupOrphanUpdaterArtifacts({ installedVersion: version });
      } catch {}
    }
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }

  if (cmd === 'stage-build') {
    const specPath = getArg('--spec');
    const resultOut = getArg('--result-out');
    if (!specPath) throw new Error('Missing --spec');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const res = stageBuildHakimiApp(spec);
    if (resultOut) {
      fs.mkdirSync(path.dirname(path.resolve(resultOut)), { recursive: true });
      fs.writeFileSync(path.resolve(resultOut), JSON.stringify(res, null, 2), 'utf8');
    } else {
      process.stdout.write(JSON.stringify(res) + '\n');
    }
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'write-meta') {
    const appPath = getArg('--app');
    if (!appPath) throw new Error('Missing --app');
    const meta = writeBuildMeta(appPath, {
      antigravityVersion: getArg('--ag-version') || undefined,
      hakimiVersion: getArg('--hakimi-version') || undefined,
      hakimiCommit: getArg('--commit') || undefined,
      hakimiCommitDate: getArg('--commit-date') || undefined,
      gitDirty: getArg('--dirty') === '1' || getArg('--dirty') === 'true',
      sourceKind: getArg('--source-kind') || 'official-local',
    });
    process.stdout.write(JSON.stringify(meta) + '\n');
    return;
  }

  throw new Error(`Unknown command: ${cmd || '(none)'}`);
}

if (require.main === module) {
  runCli().catch((err) => {
    process.stderr.write(`${err?.message || String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_OFFICIAL_FEED_URL,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  GOOGLE_TEAM_ID,
  GOOGLE_BUNDLE_ID,
  GOOGLE_AUTHORITY,
  BUILD_META_FILENAME,
  CLEAN_BASE_META_FILENAME,
  UPDATER_STATE_FILENAME,
  getUpdaterPaths,
  compareSemver,
  isAllowedOfficialUrl,
  isAllowedGithubUrl,
  parseAppUpdateYml,
  resolveOfficialFeedUrl,
  parseLatestMacYml,
  manifestHasZipEntry,
  selectMacZipFromManifest,
  decodeXmlEntities,
  parseGithubCommitsAtom,
  parseGitUploadPackBranchSha,
  defaultHttpRequest,
  computeFileSha512Base64,
  fetchOfficialLatestManifest,
  readCleanBaseMeta,
  enforceSingleSlotCleanBase,
  acquireOfficialVerifiedZip,
  verifyOfficialGoogleBundleSignature,
  extractOfficialZipAndVerify,
  checkHakimiMainUpdate,
  downloadAndExtractHakimiTarball,
  readBundleShortVersion,
  readInstalledBuildMeta,
  writeBuildMeta,
  updateInfoPlistIntegrity,
  extractEntitlements,
  cloneAppBundle,
  stageBuildHakimiApp,
  cleanupOrphanUpdaterArtifacts,
};
