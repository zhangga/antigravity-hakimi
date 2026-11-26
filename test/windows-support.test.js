'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const asarEngine = require(path.join(ROOT, 'payload', 'dist', 'asar-engine'));
const modulesConfig = require(path.join(ROOT, 'payload', 'dist', 'modules-config'));
const upgradeHelper = require(path.join(ROOT, 'payload', 'dist', 'hakimi-upgrade-helper'));
const coldHelper = require(path.join(ROOT, 'payload', 'dist', 'meter-account-cold-helper'));
const enhance = require(path.join(ROOT, 'payload', 'dist', 'meter-enhance'));
const switcher = require(path.join(ROOT, 'payload', 'dist', 'meter-account-switcher'));
const buildWin = require(path.join(ROOT, 'scripts', 'build-hakimi-win'));
const doctor = require(path.join(ROOT, 'scripts', 'doctor'));

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function createSyntheticExeBuffer({ runAsNode = 1, integrity = 0, onlyAsar = 0 } = {}) {
  const prefix = Buffer.from('MZ\x90\x00SYNTHETIC_PE_PREFIX');
  const sentinel = buildWin.FUSE_SENTINEL;
  const header = Buffer.from([1, 8]); // version 1, 8 fuses
  const flags = Buffer.from([
    runAsNode ? 0x31 : 0x30,
    0x30,
    0x31,
    0x31,
    integrity ? 0x31 : 0x30,
    onlyAsar ? 0x31 : 0x30,
    0x30,
    0x31,
  ]);
  return Buffer.concat([prefix, sentinel, header, flags, Buffer.from('TRAILER')]);
}

function createSyntheticWindowsApp(appDir, { version = '2.35.1', integrityFuse = 0 } = {}) {
  fs.mkdirSync(path.join(appDir, 'resources', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'Antigravity.exe'),
    createSyntheticExeBuffer({ runAsNode: 1, integrity: integrityFuse })
  );
  fs.writeFileSync(path.join(appDir, 'Uninstall Antigravity.exe'), Buffer.from('UNINSTALLER'));
  fs.writeFileSync(path.join(appDir, 'resources', 'bin', 'language_server.exe'), Buffer.from('MZ_FAKE_LS'));

  const asarSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-win-asar-src-'));
  try {
    fs.mkdirSync(path.join(asarSrc, 'dist', 'remote'), { recursive: true });
    fs.mkdirSync(path.join(asarSrc, 'node_modules', 'chrome-devtools-mcp', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(asarSrc, 'package.json'),
      JSON.stringify({ name: 'antigravity', version }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(asarSrc, 'dist', 'utils.js'),
      [
        "'use strict';",
        'const constants_1 = { WINDOW_ORIGIN: "http://127.0.0.1" };',
        'function setupNodeWrapper(env) { return env; }',
        'function createWindow(url, storageManager) {',
        '    const win = { loadURL() {}, focus() {} };',
        '    void win.loadURL(url);',
        '    return win;',
        '}',
        'function showOrCreateWindow(port) {',
        '    const wins = [];',
        '    if (wins.length > 0) {',
        '        wins[0].focus();',
        '    } else {',
        '        createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);',
        '    }',
        '}',
        'module.exports = { setupNodeWrapper, createWindow, showOrCreateWindow };',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(asarSrc, 'dist', 'preload.js'),
      "'use strict';\nconst { contextBridge } = require('electron');\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(asarSrc, 'dist', 'updater.js'),
      "'use strict';\nexports.initAutoUpdater = function() {};\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(asarSrc, 'dist', 'remote', 'bootstrapScript.js'),
      [
        "'use strict';",
        'const SCRIPT_BODY = "echo ok\\n";',
        'function buildBootstrapScript(header) {',
        '    return header + SCRIPT_BODY;',
        '}',
        'module.exports = { buildBootstrapScript };',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(asarSrc, 'dist', 'remote', 'remoteManager.js'),
      [
        "'use strict';",
        'class RemoteManager {',
        '    onConnected(entry, sshSession) {',
        '        return { entry, sshSession };',
        '    }',
        '    disposeHost(entry) {',
        '        return entry;',
        '    }',
        '}',
        'module.exports = { RemoteManager };',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(asarSrc, 'node_modules', 'chrome-devtools-mcp', 'bin', 'cli.js'),
      '#!/usr/bin/env node\nconsole.log("ok");\n',
      'utf8'
    );

    const destAsar = path.join(appDir, 'resources', 'app.asar');
    asarEngine.builtinAsar.createPackageWithOptions(asarSrc, destAsar, {
      unpackDir: '**/chrome-devtools-mcp',
      preserveExecutable: new Set(['node_modules/chrome-devtools-mcp/bin/cli.js']),
    });
  } finally {
    fs.rmSync(asarSrc, { recursive: true, force: true });
  }
}

test('official Antigravity guards block both macOS and Windows official install paths while allowing Hakimi and userData', () => {
  const blocked = [
    '/Applications/Antigravity.app',
    '/Applications/Antigravity.app/Contents/Resources/app.asar',
    '/Applications/Antigravity.app.orig',
    'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity',
    'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\resources\\app.asar',
    'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity.orig',
    'C:\\Program Files\\Antigravity',
    'C:\\Program Files (x86)\\Antigravity\\Antigravity.exe',
  ];
  for (const p of blocked) {
    assert.equal(asarEngine.isOfficialAntigravityPath(p), true, `asarEngine should block ${p}`);
    assert.equal(upgradeHelper.isOfficialAntigravityBundle(p), true, `upgradeHelper should block ${p}`);
    assert.equal(coldHelper.isOfficialAntigravityBundle(p), true, `coldHelper should block ${p}`);
  }

  const allowed = [
    '/Applications/哈基米.app',
    'C:\\Users\\Alice\\AppData\\Local\\Programs\\Hakimi',
    'C:\\Users\\Alice\\AppData\\Local\\Programs\\Hakimi\\resources\\app.asar',
    'C:\\Users\\Alice\\AppData\\Roaming\\Antigravity',
    'C:\\work\\github\\antigravity-hakimi',
  ];
  for (const p of allowed) {
    assert.equal(asarEngine.isOfficialAntigravityPath(p), false, `asarEngine should allow ${p}`);
    assert.equal(upgradeHelper.isOfficialAntigravityBundle(p), false, `upgradeHelper should allow ${p}`);
    assert.equal(coldHelper.isOfficialAntigravityBundle(p), false, `coldHelper should allow ${p}`);
  }
});

test('inspectElectronFuses parses RunAsNode and EnableEmbeddedAsarIntegrityValidation accurately', () => {
  withTempDir('hakimi-fuses-', (dir) => {
    const exe0 = path.join(dir, 'ok.exe');
    fs.writeFileSync(exe0, createSyntheticExeBuffer({ runAsNode: 1, integrity: 0 }));
    const r0 = buildWin.inspectElectronFuses(exe0);
    assert.equal(r0.found, true);
    assert.equal(r0.flags.runAsNode, true);
    assert.equal(r0.flags.enableEmbeddedAsarIntegrityValidation, false);

    const exe1 = path.join(dir, 'locked.exe');
    fs.writeFileSync(exe1, createSyntheticExeBuffer({ runAsNode: 1, integrity: 1 }));
    const r1 = buildWin.inspectElectronFuses(exe1);
    assert.equal(r1.found, true);
    assert.equal(r1.flags.enableEmbeddedAsarIntegrityValidation, true);
  });
});

test('buildHakimiWin --stage-only builds and passes doctor verification without touching official dir', () => {
  withTempDir('hakimi-win-e2e-', (dir) => {
    const fakeOfficial = path.join(dir, 'OfficialSource');
    const fakeDest = path.join(dir, 'HakimiDest');
    createSyntheticWindowsApp(fakeOfficial, { version: '2.35.1', integrityFuse: 0 });

    const res = buildWin.buildHakimiWin({
      from: fakeOfficial,
      dest: fakeDest,
      stageOnly: true,
      keepStage: true,
      quiet: true,
    });

    try {
      assert.equal(res.ok, true);
      assert.equal(res.stageOnly, true);
      assert.equal(res.antigravityVersion, '2.35.1');
      assert.ok(res.stageDir && fs.existsSync(res.stageDir));
      // Uninstaller excluded, dest untouched
      assert.equal(fs.existsSync(path.join(res.stageDir, 'Uninstall Antigravity.exe')), false);
      assert.equal(fs.existsSync(fakeDest), false);
      assert.equal(fs.existsSync(path.join(res.stageDir, 'resources', 'hakimi-build-meta.json')), true);

      // Version sync check on Windows layout
      const vs = modulesConfig.checkAppVersionSync({
        officialApp: fakeOfficial,
        hakimiApp: res.stageDir,
      });
      assert.equal(vs.officialVersion, '2.35.1');
      assert.equal(vs.hakimiVersion, '2.35.1');
      assert.equal(vs.outdated, false);

      // Doctor verification passes cleanly
      const report = doctor.runDoctor({
        officialApp: fakeOfficial,
        appPath: res.stageDir,
        skipProcess: true,
        skipCodesign: true,
      });
      assert.equal(report.ok, true, `Doctor failed: ${JSON.stringify(report.checks, null, 2)}`);
    } finally {
      if (res.stageDir) fs.rmSync(res.stageDir, { recursive: true, force: true });
    }
  });
});

test('buildHakimiWin fails fast when EnableEmbeddedAsarIntegrityValidation fuse is enabled', () => {
  withTempDir('hakimi-win-fuse-fail-', (dir) => {
    const fakeOfficial = path.join(dir, 'OfficialLocked');
    const fakeDest = path.join(dir, 'HakimiDest');
    createSyntheticWindowsApp(fakeOfficial, { version: '2.99.0', integrityFuse: 1 });

    assert.throws(
      () =>
        buildWin.buildHakimiWin({
          from: fakeOfficial,
          dest: fakeDest,
          stageOnly: true,
          quiet: true,
        }),
      /EnableEmbeddedAsarIntegrityValidation/
    );
  });
});

test('swapDirectoryWithRollback retries transient EBUSY and rolls back on fatal error', () => {
  withTempDir('hakimi-win-swap-', (dir) => {
    const dest = path.join(dir, 'Hakimi');
    const stage = path.join(dir, '.hakimi-stage');
    fs.mkdirSync(dest, { recursive: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(dest, 'marker.txt'), 'old', 'utf8');
    fs.writeFileSync(path.join(stage, 'marker.txt'), 'new', 'utf8');

    // Simulate 2 transient EBUSY failures before succeeding
    let attempts = 0;
    const flakyRename = (from, to) => {
      attempts++;
      if (attempts <= 2) {
        const err = new Error('EBUSY');
        err.code = 'EBUSY';
        throw err;
      }
      fs.renameSync(from, to);
    };

    const res = buildWin.swapDirectoryWithRollback(stage, dest, {
      renameSync: flakyRename,
      sleepSync: () => {},
      maxWaitMs: 5000,
    });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(path.join(dest, 'marker.txt'), 'utf8'), 'new');

    // Rollback test: fail second rename (moving stage -> dest)
    const stage2 = path.join(dir, '.hakimi-stage-2');
    fs.mkdirSync(stage2, { recursive: true });
    fs.writeFileSync(path.join(stage2, 'marker.txt'), 'broken', 'utf8');
    let callNum = 0;
    assert.throws(() => {
      buildWin.swapDirectoryWithRollback(stage2, dest, {
        renameSync: (from, to) => {
          callNum++;
          if (callNum === 2) {
            const err = new Error('fatal swap failure');
            err.code = 'EXDEV';
            throw err;
          }
          fs.renameSync(from, to);
        },
        sleepSync: () => {},
      });
    }, /fatal swap failure/);
    assert.equal(fs.readFileSync(path.join(dest, 'marker.txt'), 'utf8'), 'new');
  });
});

test('findMatchingWinLanguageServerPids matches only Hakimi language_server.exe and ignores official Antigravity', () => {
  const hakimiLs = 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Hakimi\\resources\\bin\\language_server.exe';
  const officialLs = 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe';

  const mockJson = JSON.stringify([
    { ProcessId: 1001, ExecutablePath: officialLs },
    { ProcessId: 2002, ExecutablePath: hakimiLs.toUpperCase() },
  ]);

  const hits = enhance.findMatchingWinLanguageServerPids([hakimiLs, officialLs], {
    execFileSync: () => mockJson,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pid, 2002);
});

// =========================================================================
// Phase 2: Windows Credential Manager & Cold Account Switching Tests
// =========================================================================

test('formatWindowsCredTarget and createWindowsKeychainAdapter pass secrets strictly via stdin', () => {
  assert.equal(coldHelper.formatWindowsCredTarget('gemini', 'antigravity'), 'gemini:antigravity');
  assert.throws(() => coldHelper.formatWindowsCredTarget('gemini', 'bad\naccount'), /非法控制字符/);

  const calls = [];
  const store = new Map();
  const mockExec = (bin, args, opts) => {
    calls.push({ bin, args, input: opts?.input });
    const req = JSON.parse(opts.input);
    if (req.action === 'set') {
      store.set(req.target, req.valueB64);
      return JSON.stringify({ ok: true });
    }
    if (req.action === 'has') {
      return JSON.stringify({ ok: true, found: store.has(req.target) });
    }
    if (req.action === 'hasMany') {
      const foundMap = {};
      for (const t of req.targets) foundMap[t] = store.has(t);
      return JSON.stringify({ ok: true, foundMap });
    }
    if (req.action === 'get') {
      if (!store.has(req.target)) return JSON.stringify({ ok: true, found: false });
      return JSON.stringify({ ok: true, found: true, valueB64: store.get(req.target) });
    }
    if (req.action === 'delete') {
      const deleted = store.delete(req.target);
      return JSON.stringify({ ok: true, deleted });
    }
    throw new Error('unexpected action');
  };

  const kc = coldHelper.createWindowsKeychainAdapter(mockExec);
  const secret = JSON.stringify({ id_token_email: 'win@example.com', refresh_token: 'SECRET_WIN_TOKEN_123' });
  kc.set('antigravity-hakimi-accounts', 'win@example.com', secret);

  // Verify secret NEVER appeared in CLI arguments
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'powershell.exe');
  assert.equal(calls[0].args.join(' ').includes('SECRET_WIN_TOKEN_123'), false);

  assert.equal(kc.has('antigravity-hakimi-accounts', 'win@example.com'), true);
  assert.deepEqual(kc.hasMany('antigravity-hakimi-accounts', ['win@example.com', 'missing@example.com']), {
    'win@example.com': true,
    'missing@example.com': false,
  });
  assert.equal(kc.get('antigravity-hakimi-accounts', 'win@example.com'), secret);
  assert.equal(kc.delete('antigravity-hakimi-accounts', 'win@example.com'), true);
  assert.equal(kc.get('antigravity-hakimi-accounts', 'win@example.com'), null);

  // Rejects blobs exceeding Windows Credential Manager limit
  assert.throws(
    () => kc.set('antigravity-hakimi-accounts', 'huge@example.com', 'x'.repeat(3000)),
    /超出 Windows 凭据管理器上限/
  );
});

test('live Windows Credential Manager round-trip (isolated test target)', { skip: process.platform !== 'win32' }, () => {
  const kc = coldHelper.createWindowsKeychainAdapter();
  const testService = 'antigravity-hakimi-unit-test';
  const testAccount = `probe-${process.pid}-${Date.now()}`;
  const sampleSecret = JSON.stringify({
    id_token_email: 'probe@example.com',
    tier_display_name: '测试 Pro 中文',
    refresh_token: 'fake-unit-test-token-value',
  });

  try {
    assert.equal(kc.has(testService, testAccount), false);
    assert.equal(kc.set(testService, testAccount, sampleSecret), true);
    assert.equal(kc.has(testService, testAccount), true);
    assert.deepEqual(kc.hasMany(testService, [testAccount, 'nonexistent-probe']), {
      [testAccount]: true,
      'nonexistent-probe': false,
    });
    assert.equal(kc.get(testService, testAccount), sampleSecret);
    assert.equal(kc.delete(testService, testAccount), true);
    assert.equal(kc.has(testService, testAccount), false);
  } finally {
    try {
      kc.delete(testService, testAccount);
    } catch {}
  }
});

test('Windows process detection and cold account switch job enforce isolation, cleanup, and clean relaunch', () => {
  withTempDir('hakimi-win-cold-acc-', (dir) => {
    const stateDir = path.join(dir, 'state');
    const homeDir = path.join(dir, 'home');
    const userDataDir = path.join(dir, 'AppData', 'Roaming', 'Antigravity');
    const geminiDir = path.join(homeDir, '.gemini');
    const agDir = path.join(geminiDir, 'antigravity');
    const hakimiDir = path.join(dir, 'Programs', 'Hakimi');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(agDir, { recursive: true });
    fs.mkdirSync(path.join(hakimiDir, 'resources', 'bin'), { recursive: true });

    // Detect agy.exe and agy language_server.exe without false positives
    const winProcsJson = JSON.stringify([
      {
        ProcessId: 3001,
        Name: 'Antigravity.exe',
        ExecutablePath: path.join(hakimiDir, 'Antigravity.exe'),
        CommandLine: `"${path.join(hakimiDir, 'Antigravity.exe')}"`,
      },
      {
        ProcessId: 3002,
        Name: 'language_server.exe',
        ExecutablePath: path.join(hakimiDir, 'resources', 'bin', 'language_server.exe'),
        CommandLine: `"${path.join(hakimiDir, 'resources', 'bin', 'language_server.exe')}" --app_data_dir antigravity`,
      },
      {
        ProcessId: 3003,
        Name: 'Antigravity.exe',
        ExecutablePath: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
        CommandLine: '"C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe"',
      },
      {
        ProcessId: 4001,
        Name: 'agy.exe',
        ExecutablePath: 'C:\\Users\\Alice\\bin\\agy.exe',
        CommandLine: '"C:\\Users\\Alice\\bin\\agy.exe" chat',
      },
      {
        ProcessId: 4002,
        Name: 'language_server.exe',
        ExecutablePath: 'C:\\Users\\Alice\\bin\\language_server.exe',
        CommandLine: '"C:\\Users\\Alice\\bin\\language_server.exe" --app_data_dir antigravity-cli',
      },
    ]);

    const agyHits = coldHelper.detectRunningAgyCliProcesses({
      platform: 'win32',
      execFileSync: () => winProcsJson,
    });
    assert.deepEqual(
      agyHits.map((h) => h.pid).sort(),
      [4001, 4002]
    );

    const mainPids = coldHelper.findRunningTargetPids(hakimiDir, 'main', {
      platform: 'win32',
      execFileSync: () => winProcsJson,
    });
    assert.deepEqual(mainPids, [3001]);

    const allPids = coldHelper.findRunningTargetPids(hakimiDir, 'all', {
      platform: 'win32',
      execFileSync: () => winProcsJson,
    });
    assert.deepEqual(allPids.sort(), [3001, 3002]);

    // End-to-end Windows cold switch job
    fs.writeFileSync(path.join(userDataDir, 'credential-user-scope'), 'old-scope', 'utf8');
    fs.writeFileSync(path.join(userDataDir, 'lockfile'), 'stale-lock', 'utf8');
    fs.writeFileSync(
      path.join(userDataDir, 'app_storage.json'),
      JSON.stringify({
        keepWindowBounds: true,
        'agy.onboarding.lastLoginUsername': 'old@work.com',
        'agy.onboarding.lastLoginIsGcpTos': 'false',
        'enable-wcv-three-layer-stack': 'true',
      }),
      'utf8'
    );
    fs.writeFileSync(path.join(geminiDir, 'jetski-standalone-oauth-token'), 'stale-fallback', 'utf8');
    fs.writeFileSync(path.join(agDir, 'installation_id'), 'preserve-install-id', 'utf8');

    const secretOld = JSON.stringify({ id_token_email: 'old@work.com', refresh_token: 'RT_OLD_WIN' });
    const secretTarget = JSON.stringify({ id_token_email: 'new@home.com', refresh_token: 'RT_NEW_WIN' });
    const store = new Map([
      ['gemini:antigravity', secretOld],
      ['antigravity-hakimi-accounts:new@home.com', secretTarget],
    ]);
    const mockKc = {
      has: (s, a) => store.has(`${s}:${a}`),
      hasMany: (s, list) => Object.fromEntries(list.map((a) => [a, store.has(`${s}:${a}`)])),
      get: (s, a) => store.get(`${s}:${a}`) || null,
      set: (s, a, v) => {
        store.set(`${s}:${a}`, v);
        return true;
      },
      delete: (s, a) => store.delete(`${s}:${a}`),
    };

    coldHelper.saveProfilesRegistry(
      {
        profiles: [
          { id: 'new@home.com', email: 'new@home.com', label: '个人号', tierName: 'Pro' },
        ],
      },
      { stateDir }
    );

    const relaunches = [];
    const jobRes = coldHelper.executeColdAccountJob(
      {
        action: 'switch',
        targetId: 'new@home.com',
        currentEmail: 'old@work.com',
        appBundlePath: hakimiDir,
        stateDir,
        userDataDir,
        geminiDir,
        homeDir,
      },
      {
        platform: 'win32',
        keychain: mockKc,
        skipStop: false,
        findPidsImpl: () => [],
        detectAgyCliImpl: () => [],
        sleepImpl: () => {},
        spawnImpl: (bin, args, opts) => {
          relaunches.push({ bin, args, opts });
          return { pid: 9999, unref() {} };
        },
      }
    );

    assert.equal(jobRes.ok, true);
    assert.equal(jobRes.switchedTo.id, 'new@home.com');
    assert.equal(jobRes.autoSavedPrevious, true);
    assert.equal(store.get('gemini:antigravity'), secretTarget);
    assert.equal(store.get('antigravity-hakimi-accounts:old@work.com'), secretOld);
    assert.equal(fs.existsSync(path.join(userDataDir, 'credential-user-scope')), false);
    assert.equal(fs.existsSync(path.join(geminiDir, 'jetski-standalone-oauth-token')), false);
    assert.equal(fs.readFileSync(path.join(agDir, 'installation_id'), 'utf8'), 'preserve-install-id');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, 'app_storage.json'), 'utf8')), {
      keepWindowBounds: true,
      'agy.onboarding.lastLoginUsername': 'new@home.com',
      'agy.onboarding.lastLoginIsGcpTos': 'false',
    });

    // Clean Windows relaunch directly targeting Hakimi\Antigravity.exe
    assert.equal(relaunches.length, 1);
    assert.equal(relaunches[0].bin, path.join(hakimiDir, 'Antigravity.exe'));
    assert.deepEqual(relaunches[0].args, []);

    // Switcher getAccountsStatus works on win32 using hasMany batching
    const status = switcher.getAccountsStatus({
      platform: 'win32',
      stateDir,
      keychain: mockKc,
      currentEmail: 'new@home.com',
      detectAgyCliImpl: () => [],
    });
    assert.equal(status.ok, true);
    assert.equal(status.supported, true);
    assert.equal(status.activeProfileId, 'new@home.com');
    assert.equal(status.profiles.length, 2);
  });
});

test('meter-account-cold-helper runs standalone outside repo on Windows with zero external deps', () => {
  withTempDir('hakimi-standalone-helper-', (dir) => {
    const src = path.join(ROOT, 'payload', 'dist', 'meter-account-cold-helper.js');
    const dst = path.join(dir, 'cold-switch-helper.js');
    fs.copyFileSync(src, dst);
    const mod = require(dst);
    assert.equal(mod.isSupportedPlatform('win32'), true);
    assert.equal(mod.isSupportedPlatform('darwin'), true);
    assert.equal(mod.isSupportedPlatform('linux'), false);
    assert.equal(typeof mod.createWindowsKeychainAdapter, 'function');
  });
});

