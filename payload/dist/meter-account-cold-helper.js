#!/usr/bin/env node
'use strict';

/**
 * Self-contained detached cold-switch worker & shared macOS Keychain primitives
 * for 哈基米.app multi-account switching.
 *
 * IMPORTANT:
 * - Uses ONLY Node.js built-in modules (`fs`, `os`, `path`, `crypto`, `child_process`)
 *   so it can be extracted from `app.asar` and executed by either standalone `node`
 *   or Electron (`ELECTRON_RUN_AS_NODE=1`) after the desktop app has fully exited.
 * - Never writes plaintext OAuth tokens to disk or logs; secrets move strictly
 *   between macOS Keychain items via `/usr/bin/security` (`security -i` stdin pipe).
 * - Preserves `installation_id`, `antigravity_state.pbtxt`, shared conversation
 *   history (`conversations/`, `brain/`, `conversation_summaries.db`), and Chromium
 *   `Antigravity Safe Storage` / `Partitions/hub-browser-*`.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ACTIVE_KEYCHAIN_SERVICE = 'gemini';
const ACTIVE_KEYCHAIN_ACCOUNT = 'antigravity';
const VAULT_KEYCHAIN_SERVICE = 'antigravity-hakimi-accounts';
const PROFILES_FILE_NAME = 'account-profiles-v1.json';
const PROFILES_SCHEMA_VERSION = '1.0.0';
const COLD_RESULT_FILE_NAME = 'cold-switch-last-result.json';
const COLD_LOCK_FILE_NAME = 'cold-switch.lock';
const COLD_HELPER_FILE_NAME = 'cold-switch-helper.js';
const COLD_LOG_FILE_NAME = 'cold-switch.log';
const SECURITY_BIN = '/usr/bin/security';
const SECURITY_TIMEOUT_MS = 8000;
const WINCRED_TIMEOUT_MS = 12000;
const WINCRED_MAX_BLOB_BYTES = 2560;
const GO_KEYRING_B64_PREFIX = 'go-keyring-base64:';
const SAFE_SHELL_TOKEN_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

const MENDEL_APP_STORAGE_KEYS = [
  'enable-wcv-three-layer-stack',
  'enable-remote-control-hub-browser-stream',
  'enable-agy-hub-cua-macos',
];

const ONBOARDING_APP_STORAGE_KEYS = [
  'agy.onboarding.lastLoginUsername',
  'agy.onboarding.lastLoginIsGcpTos',
];

const LEGACY_ONBOARDING_APP_STORAGE_KEYS = [
  'jetski.onboarding.lastLoginUsername',
  'jetski.onboarding.lastLoginIsGcpTos',
];

const ACCOUNT_SCOPED_APP_STORAGE_KEYS = [
  ...ONBOARDING_APP_STORAGE_KEYS,
  ...MENDEL_APP_STORAGE_KEYS,
];

const RELAUNCH_STRIP_ENV_KEYS = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'NODE_OPTIONS',
  'ELECTRON_OZONE_PLATFORM_HINT',
  'DEV_URL',
];

function isSupportedPlatform(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

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

function getDefaultAgDir(env = process.env, homeDir = os.homedir()) {
  if (env.AG_DIR && String(env.AG_DIR).trim()) {
    return path.resolve(String(env.AG_DIR).trim());
  }
  return path.join(homeDir, '.gemini', 'antigravity');
}

function isOfficialAntigravityBundle(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const resolved = path.resolve(targetPath);
  const candidates = [targetPath, resolved];
  try {
    candidates.push(fs.realpathSync(resolved));
  } catch {}
  for (const p of candidates) {
    const clean = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const noDrive = clean.replace(/^[a-z]:(?=\/)/, '');
    for (const form of [clean, noDrive]) {
      if (
        form === '/applications/antigravity.app' ||
        form === '/applications/antigravity.app.orig' ||
        form.startsWith('/applications/antigravity.app/') ||
        form.startsWith('/applications/antigravity.app.orig/')
      ) {
        return true;
      }
      const parts = form.split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === 'antigravity.app' || parts[i] === 'antigravity.app.orig') return true;
        if (
          (parts[i] === 'antigravity' || parts[i] === 'antigravity.orig') &&
          i > 0 &&
          (parts[i - 1] === 'programs' ||
            parts[i - 1] === 'program files' ||
            parts[i - 1] === 'program files (x86)')
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * POSIX shell escaping matching `alessio/shellescape.Quote` used by `zalando/go_keyring`
 * for `/usr/bin/security -i` stdin commands.
 */
function shellEscapeForSecurity(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Keychain parameter must be a string');
  }
  if (/[\r\n\0]/.test(raw)) {
    throw new Error('Keychain parameter contains illegal control characters');
  }
  if (raw.length === 0) return "''";
  if (SAFE_SHELL_TOKEN_RE.test(raw)) return raw;
  return `'${raw.replace(/'/g, `'"'"'`)}'`;
}

function isSecurityNotFoundError(err) {
  if (!err) return false;
  if (err.status === 44) return true;
  const stderr = Buffer.isBuffer(err.stderr)
    ? err.stderr.toString('utf8')
    : String(err.stderr || err.message || '');
  return /could not be found|errSecItemNotFound/i.test(stderr);
}

function sanitizeSecurityError(err, fallbackMsg) {
  const raw = Buffer.isBuffer(err?.stderr)
    ? err.stderr.toString('utf8').trim()
    : String(err?.message || '').trim();
  if (/User interaction is not allowed/i.test(raw)) {
    return 'macOS 钥匙串当前已锁定，请先解锁登录钥匙串后重试';
  }
  if (/User canceled|denied/i.test(raw)) {
    return '已取消 macOS 钥匙串授权';
  }
  if (/ETIMEDOUT|timed out/i.test(raw)) {
    return '访问 macOS 钥匙串超时，请重试';
  }
  const firstLine = raw.split(/\r?\n/)[0] || '';
  if (firstLine && firstLine.length <= 140 && !firstLine.includes(GO_KEYRING_B64_PREFIX) && !firstLine.includes('-w')) {
    return `${fallbackMsg}: ${firstLine}`;
  }
  return fallbackMsg;
}

function createMacOsKeychainAdapter(execImpl = execFileSync) {
  return {
    /**
     * Metadata-only existence check WITHOUT `-w` so plaintext secrets are never
     * read into stdout or Node memory during status refreshes.
     */
    has(service, account) {
      if (!service || !account) return false;
      try {
        execImpl(
          SECURITY_BIN,
          ['find-generic-password', '-s', String(service), '-a', String(account)],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'ignore', 'pipe'],
            timeout: SECURITY_TIMEOUT_MS,
          }
        );
        return true;
      } catch (err) {
        if (isSecurityNotFoundError(err)) return false;
        throw new Error(sanitizeSecurityError(err, '检查 macOS 钥匙串条目失败'));
      }
    },

    get(service, account) {
      if (!service || !account) return null;
      try {
        const out = execImpl(
          SECURITY_BIN,
          ['find-generic-password', '-s', String(service), '-a', String(account), '-w'],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: SECURITY_TIMEOUT_MS,
          }
        );
        const trimmed = String(out || '').replace(/\r?\n$/, '');
        return trimmed.length > 0 ? trimmed : null;
      } catch (err) {
        if (isSecurityNotFoundError(err)) return null;
        throw new Error(sanitizeSecurityError(err, '读取 macOS 钥匙串失败'));
      }
    },

    set(service, account, value) {
      if (!service || !account || typeof value !== 'string' || value.length === 0) {
        throw new Error('无效的钥匙串写入参数');
      }
      const cmdLine =
        `add-generic-password -U` +
        ` -s ${shellEscapeForSecurity(String(service))}` +
        ` -a ${shellEscapeForSecurity(String(account))}` +
        ` -w ${shellEscapeForSecurity(value)}\n`;
      try {
        execImpl(SECURITY_BIN, ['-i'], {
          input: cmdLine,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: SECURITY_TIMEOUT_MS,
        });
        return true;
      } catch (err) {
        throw new Error(sanitizeSecurityError(err, '写入 macOS 钥匙串失败'));
      }
    },

    delete(service, account) {
      if (!service || !account) return false;
      try {
        execImpl(
          SECURITY_BIN,
          ['delete-generic-password', '-s', String(service), '-a', String(account)],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: SECURITY_TIMEOUT_MS,
          }
        );
        return true;
      } catch (err) {
        if (isSecurityNotFoundError(err)) return false;
        throw new Error(sanitizeSecurityError(err, '删除 macOS 钥匙串条目失败'));
      }
    },
  };
}

function formatWindowsCredTarget(service, account) {
  const s = String(service || '');
  const a = String(account || '');
  if (!s || !a) throw new Error('Windows 凭据参数不能为空');
  if (/[\r\n\0]/.test(s) || /[\r\n\0]/.test(a)) {
    throw new Error('Windows 凭据参数包含非法控制字符');
  }
  return `${s}:${a}`;
}

function encodeAsciiJson(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

const WINCRED_PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$rawIn = [Console]::In.ReadToEnd()',
  '$req = $rawIn | ConvertFrom-Json',
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class HakimiWinCred {',
  '    public const uint CRED_TYPE_GENERIC = 1;',
  '    public const uint CRED_PERSIST_LOCAL_MACHINE = 2;',
  '    public const int ERROR_NOT_FOUND = 1168;',
  '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '    public struct CREDENTIAL {',
  '        public uint Flags;',
  '        public uint Type;',
  '        public string TargetName;',
  '        public string Comment;',
  '        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '        public uint CredentialBlobSize;',
  '        public IntPtr CredentialBlob;',
  '        public uint Persist;',
  '        public uint AttributeCount;',
  '        public IntPtr Attributes;',
  '        public string TargetAlias;',
  '        public string UserName;',
  '    }',
  '    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '    public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credPtr);',
  '    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, uint flags);',
  '    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '    public static extern bool CredDelete(string target, uint type, uint flags);',
  '    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]',
  '    public static extern void CredFree(IntPtr cred);',
  '    public static int Has(string target) {',
  '        IntPtr ptr;',
  '        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out ptr)) {',
  '            int err = Marshal.GetLastWin32Error();',
  '            return err == ERROR_NOT_FOUND ? 0 : -err;',
  '        }',
  '        CredFree(ptr);',
  '        return 1;',
  '    }',
  '    public static string GetBase64(string target, out int errCode) {',
  '        errCode = 0;',
  '        IntPtr ptr;',
  '        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out ptr)) {',
  '            errCode = Marshal.GetLastWin32Error();',
  '            return null;',
  '        }',
  '        try {',
  '            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));',
  '            byte[] blob = new byte[c.CredentialBlobSize];',
  '            if (c.CredentialBlobSize > 0 && c.CredentialBlob != IntPtr.Zero) {',
  '                Marshal.Copy(c.CredentialBlob, blob, 0, (int)c.CredentialBlobSize);',
  '            }',
  '            return Convert.ToBase64String(blob);',
  '        } finally {',
  '            CredFree(ptr);',
  '        }',
  '    }',
  '    public static int SetBase64(string target, string userName, string valueB64) {',
  '        byte[] bytes = Convert.FromBase64String(valueB64);',
  '        IntPtr blobPtr = IntPtr.Zero;',
  '        try {',
  '            if (bytes.Length > 0) {',
  '                blobPtr = Marshal.AllocHGlobal(bytes.Length);',
  '                Marshal.Copy(bytes, 0, blobPtr, bytes.Length);',
  '            }',
  '            CREDENTIAL cred = new CREDENTIAL();',
  '            cred.Type = CRED_TYPE_GENERIC;',
  '            cred.TargetName = target;',
  '            cred.UserName = userName;',
  '            cred.Persist = CRED_PERSIST_LOCAL_MACHINE;',
  '            cred.CredentialBlobSize = (uint)bytes.Length;',
  '            cred.CredentialBlob = blobPtr;',
  '            if (!CredWrite(ref cred, 0)) {',
  '                return Marshal.GetLastWin32Error();',
  '            }',
  '            return 0;',
  '        } finally {',
  '            if (blobPtr != IntPtr.Zero) {',
  '                if (bytes.Length > 0) {',
  '                    byte[] zeros = new byte[bytes.Length];',
  '                    Marshal.Copy(zeros, 0, blobPtr, zeros.Length);',
  '                }',
  '                Marshal.FreeHGlobal(blobPtr);',
  '            }',
  '            Array.Clear(bytes, 0, bytes.Length);',
  '        }',
  '    }',
  '    public static int Delete(string target) {',
  '        if (!CredDelete(target, CRED_TYPE_GENERIC, 0)) {',
  '            int err = Marshal.GetLastWin32Error();',
  '            return err == ERROR_NOT_FOUND ? 0 : -err;',
  '        }',
  '        return 1;',
  '    }',
  '}',
  "'@",
  "$act = [string]$req.action",
  "if ($act -eq 'has') {",
  '    $rc = [HakimiWinCred]::Has([string]$req.target)',
  '    if ($rc -lt 0) { @{ ok = $false; win32Error = (-$rc) } | ConvertTo-Json -Compress }',
  '    else { @{ ok = $true; found = ($rc -eq 1) } | ConvertTo-Json -Compress }',
  "} elseif ($act -eq 'hasMany') {",
  '    $map = @{}',
  '    foreach ($t in @($req.targets)) {',
  '        $rc = [HakimiWinCred]::Has([string]$t)',
  '        if ($rc -lt 0) { $map[[string]$t] = $false } else { $map[[string]$t] = ($rc -eq 1) }',
  '    }',
  '    @{ ok = $true; foundMap = $map } | ConvertTo-Json -Compress',
  "} elseif ($act -eq 'get') {",
  '    $err = 0',
  '    $b64 = [HakimiWinCred]::GetBase64([string]$req.target, [ref]$err)',
  '    if ($null -eq $b64) {',
  '        if ($err -eq 1168) { @{ ok = $true; found = $false } | ConvertTo-Json -Compress }',
  '        else { @{ ok = $false; win32Error = $err } | ConvertTo-Json -Compress }',
  '    } else {',
  '        @{ ok = $true; found = $true; valueB64 = $b64 } | ConvertTo-Json -Compress',
  '    }',
  "} elseif ($act -eq 'set') {",
  '    $err = [HakimiWinCred]::SetBase64([string]$req.target, [string]$req.userName, [string]$req.valueB64)',
  '    if ($err -eq 0) { @{ ok = $true } | ConvertTo-Json -Compress }',
  '    else { @{ ok = $false; win32Error = $err } | ConvertTo-Json -Compress }',
  "} elseif ($act -eq 'delete') {",
  '    $rc = [HakimiWinCred]::Delete([string]$req.target)',
  '    if ($rc -lt 0) { @{ ok = $false; win32Error = (-$rc) } | ConvertTo-Json -Compress }',
  '    else { @{ ok = $true; deleted = ($rc -eq 1) } | ConvertTo-Json -Compress }',
  '} else {',
  "    @{ ok = $false; error = 'unknown action' } | ConvertTo-Json -Compress",
  '}',
].join('\n');

let cachedWinCredEncodedCmd = null;
function getWinCredEncodedCommand() {
  if (!cachedWinCredEncodedCmd) {
    cachedWinCredEncodedCmd = Buffer.from(WINCRED_PS_SCRIPT, 'utf16le').toString('base64');
  }
  return cachedWinCredEncodedCmd;
}

function sanitizeWinCredError(err, fallbackMsg) {
  const raw = Buffer.isBuffer(err?.stderr)
    ? err.stderr.toString('utf8').trim()
    : String(err?.message || '').trim();
  if (/ETIMEDOUT|timed out/i.test(raw)) {
    return '访问 Windows 凭据管理器超时，请重试';
  }
  const firstLine = raw.split(/\r?\n/)[0] || '';
  if (firstLine && firstLine.length <= 140 && !firstLine.includes(GO_KEYRING_B64_PREFIX) && !firstLine.includes('valueB64')) {
    return `${fallbackMsg}: ${firstLine}`;
  }
  return fallbackMsg;
}

/**
 * Windows Credential Manager adapter using native advapi32.dll P/Invoke via PowerShell.
 * - Matches `zalando/go-keyring` (`danieljoos/wincred`) format:
 *   TargetName = "<service>:<account>", UserName = "<account>",
 *   Type = CRED_TYPE_GENERIC (1), Persist = CRED_PERSIST_LOCAL_MACHINE (2),
 *   CredentialBlob = raw UTF-8 bytes.
 * - Zero plaintext secrets in CLI arguments, env vars, or disk files (JSON passed via stdin).
 */
function createWindowsKeychainAdapter(execImpl = execFileSync) {
  const invokeWinCred = (payloadObj, fallbackErr) => {
    let stdout = '';
    try {
      stdout = execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', getWinCredEncodedCommand()],
        {
          input: encodeAsciiJson(payloadObj),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: WINCRED_TIMEOUT_MS,
          windowsHide: true,
        }
      );
    } catch (err) {
      throw new Error(sanitizeWinCredError(err, fallbackErr));
    }
    const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    let parsed = null;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      throw new Error(fallbackErr);
    }
    if (!parsed || parsed.ok !== true) {
      const codeSuffix = parsed?.win32Error ? ` (Win32 error ${parsed.win32Error})` : '';
      throw new Error(`${fallbackErr}${codeSuffix}`);
    }
    return parsed;
  };

  return {
    has(service, account) {
      if (!service || !account) return false;
      const target = formatWindowsCredTarget(service, account);
      const res = invokeWinCred({ action: 'has', target }, '检查 Windows 凭据条目失败');
      return Boolean(res.found);
    },

    hasMany(service, accounts) {
      const out = {};
      const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
      if (!service || list.length === 0) return out;
      const targetByAccount = new Map();
      const targets = [];
      for (const acc of list) {
        const t = formatWindowsCredTarget(service, acc);
        targetByAccount.set(String(acc), t);
        targets.push(t);
      }
      const res = invokeWinCred({ action: 'hasMany', targets }, '批量检查 Windows 凭据条目失败');
      const foundMap = res.foundMap && typeof res.foundMap === 'object' ? res.foundMap : {};
      for (const [acc, t] of targetByAccount.entries()) {
        out[acc] = Boolean(foundMap[t]);
      }
      return out;
    },

    get(service, account) {
      if (!service || !account) return null;
      const target = formatWindowsCredTarget(service, account);
      const res = invokeWinCred({ action: 'get', target }, '读取 Windows 凭据失败');
      if (!res.found || typeof res.valueB64 !== 'string') return null;
      const decoded = Buffer.from(res.valueB64, 'base64').toString('utf8');
      return decoded.length > 0 ? decoded : null;
    },

    set(service, account, value) {
      if (!service || !account || typeof value !== 'string' || value.length === 0) {
        throw new Error('无效的 Windows 凭据写入参数');
      }
      const target = formatWindowsCredTarget(service, account);
      const bytes = Buffer.from(value, 'utf8');
      if (bytes.length > WINCRED_MAX_BLOB_BYTES) {
        throw new Error(`凭据大小 (${bytes.length} 字节) 超出 Windows 凭据管理器上限 (${WINCRED_MAX_BLOB_BYTES} 字节)`);
      }
      invokeWinCred(
        { action: 'set', target, userName: String(account), valueB64: bytes.toString('base64') },
        '写入 Windows 凭据失败'
      );
      return true;
    },

    delete(service, account) {
      if (!service || !account) return false;
      const target = formatWindowsCredTarget(service, account);
      const res = invokeWinCred({ action: 'delete', target }, '删除 Windows 凭据失败');
      return Boolean(res.deleted);
    },
  };
}

function createPlatformKeychainAdapter(options = {}) {
  const plat = options.platform || process.platform;
  const execImpl = options.execFileSync || execFileSync;
  if (plat === 'win32') {
    return createWindowsKeychainAdapter(execImpl);
  }
  return createMacOsKeychainAdapter(execImpl);
}

function computeTokenFingerprint(rawSecret) {
  if (!rawSecret || typeof rawSecret !== 'string') return null;
  return crypto.createHash('sha256').update(rawSecret, 'utf8').digest('hex').slice(0, 12);
}

function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || cleaned.length > 160) return '';
  return cleaned;
}

function sanitizeProfileId(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  return s.replace(/[^a-z0-9@._+-]/g, '_').slice(0, 128);
}

function sanitizeDisplayLabel(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\r\n\0]/g, ' ').trim().slice(0, 64);
}

function sanitizeTierName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\r\n\0]/g, ' ').trim().slice(0, 48);
}

function parseStoredTokenMetadata(rawSecret) {
  if (!rawSecret || typeof rawSecret !== 'string') return null;
  try {
    let jsonText = rawSecret;
    if (rawSecret.startsWith(GO_KEYRING_B64_PREFIX)) {
      jsonText = Buffer.from(rawSecret.slice(GO_KEYRING_B64_PREFIX.length), 'base64').toString('utf8');
    }
    if (!jsonText.trim().startsWith('{')) return null;
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractRawEmailHintFromSecret(rawSecret) {
  const parsed = parseStoredTokenMetadata(rawSecret);
  if (!parsed) return '';
  const candidates = [
    parsed.id_token_email,
    parsed.idTokenEmail,
    parsed.email,
    parsed.user_email,
    parsed.userEmail,
    parsed.account,
    parsed.user?.email,
    parsed.metadata?.email,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.trim())) {
      return c.trim();
    }
  }
  return '';
}

function extractEmailHintFromSecret(rawSecret) {
  return normalizeEmail(extractRawEmailHintFromSecret(rawSecret));
}

function extractIsGcpTosHintFromSecret(rawSecret) {
  const parsed = parseStoredTokenMetadata(rawSecret);
  if (!parsed) return 'false';
  const method = String(parsed.auth_method || parsed.authMethod || '').trim().toLowerCase();
  return (method === 'gcp' || method === 'wif') ? 'true' : 'false';
}

function normalizeOnboardingIsGcpTos(raw) {
  if (raw === true || raw === 'true') return 'true';
  if (raw === false || raw === 'false') return 'false';
  return '';
}

function readOnboardingStateFromAppStorage(userDataDir) {
  const dir = userDataDir ? path.resolve(String(userDataDir)) : getDefaultUserDataDir();
  const appStoragePath = path.join(dir, 'app_storage.json');
  const readRes = readJsonFileSafe(appStoragePath, null);
  if (!readRes.ok || !readRes.data || typeof readRes.data !== 'object' || Array.isArray(readRes.data)) {
    return { username: '', isGcpTos: '' };
  }
  const rawUser =
    readRes.data['agy.onboarding.lastLoginUsername'] ??
    readRes.data['jetski.onboarding.lastLoginUsername'] ??
    '';
  const rawGcp =
    readRes.data['agy.onboarding.lastLoginIsGcpTos'] ??
    readRes.data['jetski.onboarding.lastLoginIsGcpTos'];
  return {
    username: typeof rawUser === 'string' ? rawUser.trim() : '',
    isGcpTos: normalizeOnboardingIsGcpTos(rawGcp),
  };
}

function extractTierHintFromSecret(rawSecret) {
  const parsed = parseStoredTokenMetadata(rawSecret);
  if (!parsed) return '';
  const displayName = sanitizeTierName(parsed.tier_display_name || parsed.tierDisplayName || '');
  const userTierId = sanitizeTierName(parsed.user_tier || parsed.userTier || '');
  const lowerId = userTierId.toLowerCase();
  if (/ultra/i.test(displayName) || /ultra/i.test(lowerId)) {
    const multMatch = displayName.match(/ultra[\s(]*(\d+x)\b/i);
    if (multMatch) return `Google AI Ultra ${multMatch[1].toLowerCase()}`;
    if (lowerId === 'g1-ultra-lite-tier' || /ultra[-_ ]?(?:lite|5x)\b/i.test(lowerId)) {
      return 'Google AI Ultra 5x';
    }
    if (lowerId === 'g1-ultra-tier' || /ultra[-_ ]?20x\b/i.test(lowerId)) {
      return 'Google AI Ultra 20x';
    }
    return displayName || 'Google AI Ultra';
  }
  return displayName || userTierId || '';
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, data: fallback };
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return { ok: false, data: fallback };
    const parsed = JSON.parse(raw);
    return { ok: true, data: parsed };
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

function getProfilesPath(options = {}) {
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : getDefaultStateDir();
  return path.join(stateDir, PROFILES_FILE_NAME);
}

function getRuntimeDir(options = {}) {
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : getDefaultStateDir();
  return path.join(stateDir, 'runtime');
}

function getColdResultPath(options = {}) {
  return path.join(getRuntimeDir(options), COLD_RESULT_FILE_NAME);
}

function getColdLockPath(options = {}) {
  return path.join(getRuntimeDir(options), COLD_LOCK_FILE_NAME);
}

function normalizeRegistryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sanitizeProfileId(raw.id || raw.email);
  if (!id) return null;
  const email = normalizeEmail(raw.email || '');
  const onboardingUsername = typeof raw.onboardingUsername === 'string'
    ? raw.onboardingUsername.replace(/[\r\n\0]/g, '').trim().slice(0, 160)
    : '';
  const onboardingIsGcpTos = normalizeOnboardingIsGcpTos(raw.onboardingIsGcpTos);
  return {
    id,
    email,
    label: sanitizeDisplayLabel(raw.label || ''),
    tierName: sanitizeTierName(raw.tierName || ''),
    savedAt: typeof raw.savedAt === 'string' && raw.savedAt ? raw.savedAt : new Date().toISOString(),
    lastUsedAt: typeof raw.lastUsedAt === 'string' && raw.lastUsedAt ? raw.lastUsedAt : '',
    tokenFingerprint: typeof raw.tokenFingerprint === 'string' ? raw.tokenFingerprint.slice(0, 16) : '',
    ...(onboardingUsername ? { onboardingUsername } : {}),
    ...(onboardingIsGcpTos ? { onboardingIsGcpTos } : {}),
  };
}

function loadProfilesRegistry(options = {}) {
  const filePath = getProfilesPath(options);
  const fallback = { version: PROFILES_SCHEMA_VERSION, updatedAt: '', profiles: [] };
  const res = readJsonFileSafe(filePath, fallback);
  if (!res.ok || !res.data || !Array.isArray(res.data.profiles)) return fallback;
  const seen = new Set();
  const profiles = [];
  for (const item of res.data.profiles) {
    const clean = normalizeRegistryEntry(item);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    profiles.push(clean);
  }
  return {
    version: res.data.version || PROFILES_SCHEMA_VERSION,
    updatedAt: typeof res.data.updatedAt === 'string' ? res.data.updatedAt : '',
    profiles,
  };
}

function saveProfilesRegistry(registry, options = {}) {
  const filePath = getProfilesPath(options);
  const cleanProfiles = [];
  const seen = new Set();
  for (const item of Array.isArray(registry?.profiles) ? registry.profiles : []) {
    const clean = normalizeRegistryEntry(item);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    cleanProfiles.push(clean);
  }
  const payload = {
    version: PROFILES_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    profiles: cleanProfiles,
  };
  return writeJsonFileAtomic(filePath, payload, 0o600);
}

function findMatchingProfile(profiles, { activeFingerprint, currentEmail }) {
  const normEmail = normalizeEmail(currentEmail);
  if (normEmail) {
    const byEmail = profiles.find((p) => p.email === normEmail || p.id === normEmail);
    if (byEmail) return byEmail;
  }
  if (activeFingerprint) {
    const byFp = profiles.find((p) => p.tokenFingerprint && p.tokenFingerprint === activeFingerprint);
    if (byFp) return byFp;
  }
  return null;
}

function upsertProfileWithSecret(registry, kc, rawSecret, meta = {}) {
  const fp = computeTokenFingerprint(rawSecret);
  const email = normalizeEmail(meta.email) || extractEmailHintFromSecret(rawSecret);
  const tierName = sanitizeTierName(meta.tierName || '') || extractTierHintFromSecret(rawSecret);
  const existing = findMatchingProfile(registry.profiles, {
    activeFingerprint: fp,
    currentEmail: email,
  });

  const id = existing
    ? existing.id
    : (email ? sanitizeProfileId(email) : sanitizeProfileId(`account-${fp}`));
  if (!id) {
    throw new Error('无法生成有效的账号标识');
  }

  kc.set(VAULT_KEYCHAIN_SERVICE, id, rawSecret);
  if (typeof kc.has === 'function') {
    if (!kc.has(VAULT_KEYCHAIN_SERVICE, id)) {
      throw new Error('回读校验钥匙串备份条目失败');
    }
  } else {
    const verify = kc.get(VAULT_KEYCHAIN_SERVICE, id);
    if (!verify || computeTokenFingerprint(verify) !== fp) {
      throw new Error('回读校验钥匙串备份条目失败');
    }
  }

  const now = new Date().toISOString();
  const rawMetaEmail = typeof meta.email === 'string' ? meta.email.trim() : '';
  const rawSecretEmail = extractRawEmailHintFromSecret(rawSecret);
  const onboardingUsername =
    (typeof meta.onboardingUsername === 'string' && meta.onboardingUsername.trim()) ||
    existing?.onboardingUsername ||
    rawMetaEmail ||
    rawSecretEmail ||
    email ||
    '';
  const onboardingIsGcpTos =
    normalizeOnboardingIsGcpTos(meta.onboardingIsGcpTos) ||
    existing?.onboardingIsGcpTos ||
    extractIsGcpTosHintFromSecret(rawSecret);
  const nextEntry = normalizeRegistryEntry({
    id,
    email: email || existing?.email || '',
    label: meta.label !== undefined ? meta.label : (existing?.label || ''),
    tierName: tierName || existing?.tierName || '',
    savedAt: existing?.savedAt || now,
    lastUsedAt: now,
    tokenFingerprint: fp,
    onboardingUsername,
    onboardingIsGcpTos,
  });

  const idx = registry.profiles.findIndex((p) => p.id === id);
  if (idx >= 0) {
    registry.profiles[idx] = nextEntry;
  } else {
    registry.profiles.push(nextEntry);
  }
  return nextEntry;
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

function listWinProcesses(execImpl = execFileSync) {
  const psScript = [
    '$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, Name, ExecutablePath, CommandLine;',
    'if ($procs) { $procs | ConvertTo-Json -Compress } else { "[]" }',
  ].join(' ');
  const out = execImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 6000,
      windowsHide: true,
    }
  );
  const trimmed = String(out || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const rows = [];
    for (const item of list) {
      if (!item) continue;
      const pid = Number(item.ProcessId);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      rows.push({
        pid,
        name: String(item.Name || ''),
        executablePath: String(item.ExecutablePath || ''),
        command: String(item.CommandLine || item.ExecutablePath || item.Name || ''),
      });
    }
    return rows;
  }
  // Fallback: handle mocked Unix `ps` output in cross-platform unit tests
  const rows = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({ pid, name: '', executablePath: '', command: m[2] });
  }
  return rows;
}

function isWindowsAppPath(targetAppPath, platform = process.platform) {
  if (!targetAppPath) return platform === 'win32';
  const lower = String(targetAppPath).toLowerCase();
  if (lower.endsWith('.app') || lower.endsWith('.app.orig')) return false;
  return platform === 'win32';
}

/**
 * Detect running `agy` CLI processes (or `agy`-owned `language_server` with
 * `--app_data_dir antigravity-cli`) that share the global ("gemini", "antigravity")
 * system credential slot.
 */
function detectRunningAgyCliProcesses(options = {}) {
  const execImpl = options.execFileSync || execFileSync;
  const plat = options.platform || process.platform;
  const selfPids = new Set([process.pid, ...(Array.isArray(options.excludePids) ? options.excludePids : [])]);
  let rows = [];
  try {
    rows = plat === 'win32' ? listWinProcesses(execImpl) : listPsProcesses(execImpl);
  } catch {
    return [];
  }
  const matched = [];
  for (const row of rows) {
    if (selfPids.has(row.pid)) continue;
    const cmd = String(row.command || '').trim();
    const exePath = String(row.executablePath || '').trim();
    const procName = String(row.name || '').trim().toLowerCase();
    if (!cmd && !exePath && !procName) continue;
    const firstToken = exePath || (cmd.split(/\s+/)[0] || '').replace(/^"|"$/g, '');
    const base = path.basename(firstToken.replace(/\\/g, '/')).toLowerCase();
    const isAgyBin =
      base === 'agy' ||
      base === 'agy.exe' ||
      procName === 'agy.exe' ||
      /(?:^|[\\/])agy(?:\.exe)?$/i.test(firstToken);
    const isAgyLs =
      (/(?:^|[\\/])language_server(?:\.exe)?(?:\s|$)/i.test(firstToken) ||
        procName === 'language_server.exe') &&
      /--app_data_dir(?:=|\s+)["']?antigravity-cli["']?(?:\s|$)/i.test(cmd);
    if (isAgyBin || isAgyLs) {
      matched.push({ pid: row.pid, command: firstToken || procName });
    }
  }
  return matched;
}

function findRunningTargetPids(targetAppPath, mode = 'all', options = {}) {
  if (!targetAppPath) return [];
  const execImpl = options.execFileSync || execFileSync;
  const plat = options.platform || process.platform;
  const resolvedApp = path.resolve(String(targetAppPath));
  const selfPids = new Set([process.pid, ...(Array.isArray(options.excludePids) ? options.excludePids : [])]);

  if (isWindowsAppPath(targetAppPath, plat)) {
    let normRoot = resolvedApp;
    try {
      if (fs.existsSync(resolvedApp)) normRoot = fs.realpathSync(resolvedApp);
    } catch {}
    const prefixes = new Set([
      resolvedApp.replace(/[\\/]+$/, '').toLowerCase() + '\\',
      normRoot.replace(/[\\/]+$/, '').toLowerCase() + '\\',
    ]);
    const mainExecs = new Set([
      path.join(resolvedApp, 'Antigravity.exe').toLowerCase(),
      path.join(normRoot, 'Antigravity.exe').toLowerCase(),
    ]);
    let rows = [];
    try {
      rows = listWinProcesses(execImpl);
    } catch {
      return [];
    }
    const pids = [];
    for (const row of rows) {
      if (selfPids.has(row.pid)) continue;
      const exeLower = row.executablePath ? path.resolve(row.executablePath).toLowerCase() : '';
      if (!exeLower) continue;
      const isMain = mainExecs.has(exeLower);
      let isUnderApp = false;
      for (const pref of prefixes) {
        if (exeLower.startsWith(pref)) {
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

/**
 * Zero-survivor exit barrier matching scripts/lib/target-app-lifecycle.sh:
 * 1. Wait briefly for graceful `app.quit()` initiated by Electron main process
 * 2. SIGTERM main process(es) -> wait
 * 3. SIGTERM remaining helper / language_server / sidecar processes -> wait
 * 4. SIGKILL any stubborn survivors -> wait until zero processes remain
 */
function stopTargetAppProcesses(targetAppPath, options = {}) {
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 100;
  const initialGraceMs = Number.isFinite(options.initialGraceMs) ? options.initialGraceMs : 2000;
  const mainTermMs = Number.isFinite(options.mainTermMs) ? options.mainTermMs : 2500;
  const allTermMs = Number.isFinite(options.allTermMs) ? options.allTermMs : 1500;
  const killWaitMs = Number.isFinite(options.killWaitMs) ? options.killWaitMs : 2500;
  const killImpl = options.killImpl || process.kill;
  const execImpl = options.execFileSync || execFileSync;
  const sleepImpl = options.sleepImpl || sleepMs;
  const findPids = options.findPidsImpl || ((m) => findRunningTargetPids(targetAppPath, m, options));
  const isWinTarget = isWindowsAppPath(targetAppPath, options.platform || process.platform);

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
    if (isWinTarget && !options.killImpl) {
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
    } else {
      for (const pid of mainPids) safeKillPid(pid, 'SIGTERM', killImpl);
    }
    rem = waitUntilZero(mainTermMs);
    if (rem.length === 0) return { ok: true, remaining: [] };
  }

  if (isWinTarget && !options.killImpl) {
    for (const pid of rem) {
      try {
        execImpl('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 4000,
          windowsHide: true,
        });
      } catch {
        safeKillPid(pid, 'SIGKILL', killImpl);
      }
    }
    rem = waitUntilZero(allTermMs + killWaitMs);
    if (rem.length === 0) return { ok: true, remaining: [] };
  } else {
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
    if (process.platform === 'win32') {
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
  try {
    killImpl(pid, 0);
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

function unlinkIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Clean strictly account-bound local residue after all processes have exited:
 * 1. `~/.gemini/jetski-standalone-oauth-token` and `~/.gemini/cache/antigravity-keyring-unavailable`
 *    (prevents `compositeTokenStorage` from cross-account merge-healing).
 * 2. `~/Library/Application Support/Antigravity/credential-user-scope`
 *    (exact mirror of `authstore.ClearSavedScope()` so plugin Keychain scope rebuilds for the new user).
 * 3. Account-specific keys inside `~/Library/Application Support/Antigravity/app_storage.json`
 *    (`agy.onboarding.lastLoginUsername`, `agy.onboarding.lastLoginIsGcpTos`, and cached Mendel flags),
 *    preserving window layout, pinned conversations, and shared history.
 *
 * Intentionally preserves:
 * - `installation_id` & `antigravity_state.pbtxt`
 * - Shared conversation history (`conversations/`, `brain/`, `conversation_summaries.db`)
 * - Chromium `Antigravity Safe Storage` and `Partitions/hub-browser-*`
 */
function cleanupAccountLocalResidue(options = {}) {
  const homeDir = options.homeDir ? path.resolve(options.homeDir) : os.homedir();
  const userDataDir = options.userDataDir
    ? path.resolve(options.userDataDir)
    : getDefaultUserDataDir(process.platform, process.env, homeDir);
  const geminiRoot = options.geminiDir
    ? path.resolve(options.geminiDir)
    : path.join(homeDir, '.gemini');

  const removedFallbackToken = unlinkIfExists(path.join(geminiRoot, 'jetski-standalone-oauth-token'));
  const removedKeyringMarker = unlinkIfExists(path.join(geminiRoot, 'cache', 'antigravity-keyring-unavailable'));
  const removedCredentialScope = unlinkIfExists(path.join(userDataDir, 'credential-user-scope'));

  const appStoragePath = path.join(userDataDir, 'app_storage.json');
  const clearedAppStorageKeys = [];
  let appliedOnboardingTarget = null;
  const onboardingTarget = options.onboardingTarget && typeof options.onboardingTarget === 'object'
    ? options.onboardingTarget
    : null;
  const targetUsername = typeof onboardingTarget?.username === 'string' ? onboardingTarget.username.trim() : '';
  const targetIsGcpTos = normalizeOnboardingIsGcpTos(onboardingTarget?.isGcpTos);

  if (fs.existsSync(appStoragePath)) {
    const readRes = readJsonFileSafe(appStoragePath, null);
    if (readRes.ok && readRes.data && typeof readRes.data === 'object' && !Array.isArray(readRes.data)) {
      let dirty = false;
      for (const key of [...MENDEL_APP_STORAGE_KEYS, ...LEGACY_ONBOARDING_APP_STORAGE_KEYS]) {
        if (Object.prototype.hasOwnProperty.call(readRes.data, key)) {
          delete readRes.data[key];
          clearedAppStorageKeys.push(key);
          dirty = true;
        }
      }
      if (targetUsername) {
        const nextGcpTos = targetIsGcpTos || 'false';
        if (readRes.data['agy.onboarding.lastLoginUsername'] !== targetUsername) {
          readRes.data['agy.onboarding.lastLoginUsername'] = targetUsername;
          dirty = true;
        }
        if (readRes.data['agy.onboarding.lastLoginIsGcpTos'] !== nextGcpTos) {
          readRes.data['agy.onboarding.lastLoginIsGcpTos'] = nextGcpTos;
          dirty = true;
        }
        appliedOnboardingTarget = { username: targetUsername, isGcpTos: nextGcpTos };
      } else {
        for (const key of ONBOARDING_APP_STORAGE_KEYS) {
          if (Object.prototype.hasOwnProperty.call(readRes.data, key)) {
            delete readRes.data[key];
            clearedAppStorageKeys.push(key);
            dirty = true;
          }
        }
      }
      if (dirty) {
        writeJsonFileAtomic(appStoragePath, readRes.data, 0o600);
      }
    }
  }

  return {
    removedFallbackToken,
    removedKeyringMarker,
    removedCredentialScope,
    clearedAppStorageKeys,
    appliedOnboardingTarget,
  };
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
  const plat = options.platform || process.platform;
  try {
    if (isWindowsAppPath(targetAppPath, plat)) {
      const resolved = path.resolve(String(targetAppPath));
      const exePath = resolved.toLowerCase().endsWith('.exe')
        ? resolved
        : path.join(resolved, 'Antigravity.exe');
      const child = spawnImpl(exePath, [], {
        cwd: path.dirname(exePath),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: cleanEnv,
      });
      if (child && typeof child.unref === 'function') child.unref();
      return { ok: true, exePath };
    }
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

function isPidAlive(pid, killImpl = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code !== 'ESRCH');
  }
}

function acquireColdLock(options = {}) {
  const lockPath = getColdLockPath(options);
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
          if (Date.now() - st.mtimeMs > 60000) return true;
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
      return { ok: false, error: '已有账号冷切换任务正在执行，请稍候' };
    }
    return { ok: false, error: err?.message || '获取冷切换互斥锁失败' };
  }
}

function releaseColdLock(options = {}) {
  unlinkIfExists(getColdLockPath(options));
}

function appendColdLog(stateDir, msg) {
  try {
    const logPath = path.join(getRuntimeDir({ stateDir }), COLD_LOG_FILE_NAME);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

/**
 * Execute a cold account job AFTER all target app processes have exited.
 * Always writes a non-sensitive result JSON and (when `relaunch !== false`)
 * relaunches the target app even if an error occurred after shutdown.
 */
function executeColdAccountJob(job, options = {}) {
  const action = String(job?.action || '');
  const stateDir = job?.stateDir ? path.resolve(job.stateDir) : getDefaultStateDir();
  const homeDir = job?.homeDir ? path.resolve(job.homeDir) : os.homedir();
  const userDataDir = job?.userDataDir
    ? path.resolve(job.userDataDir)
    : getDefaultUserDataDir(process.platform, process.env, homeDir);
  const geminiDir = job?.geminiDir
    ? path.resolve(job.geminiDir)
    : path.join(homeDir, '.gemini');
  const appBundlePath = job?.appBundlePath ? path.resolve(job.appBundlePath) : '';
  const shouldRelaunch = options.relaunch !== false && Boolean(appBundlePath);

  if (appBundlePath && !options.allowOfficialForTest && isOfficialAntigravityBundle(appBundlePath)) {
    return { ok: false, error: '安全拦截：禁止对官方原版 Antigravity.app 执行进程关闭或冷切重启' };
  }

  const kc =
    options.keychain ||
    createPlatformKeychainAdapter({
      platform: options.platform || process.platform,
      execFileSync: options.execFileSync || execFileSync,
    });
  const commonOpts = { ...options, stateDir, userDataDir, geminiDir, homeDir };

  const finalize = (result, { suppressRelaunch = false } = {}) => {
    const record = {
      ...result,
      action,
      completedAt: new Date().toISOString(),
    };
    writeJsonFileAtomic(getColdResultPath({ stateDir }), record, 0o600);
    releaseColdLock({ stateDir });
    if (shouldRelaunch && !suppressRelaunch) {
      if (options.sleepImpl) options.sleepImpl(300);
      else sleepMs(300);
      const relaunchRes = relaunchTargetApp(appBundlePath, options);
      appendColdLog(stateDir, `relaunch ${appBundlePath}: ok=${relaunchRes.ok}`);
      record.relaunched = relaunchRes.ok;
      if (!relaunchRes.ok && !record.error) {
        record.error = relaunchRes.error;
      }
    }
    return record;
  };

  const lockRes = acquireColdLock({ stateDir, killImpl: options.killImpl });
  if (!lockRes.ok) {
    return { ok: false, action, error: lockRes.error };
  }

  appendColdLog(stateDir, `start cold job action=${action} target=${job?.targetId || '-'}`);

  try {
    // 1. Wait for target app + language_server + sidecars zero-survivor exit barrier
    if (appBundlePath && options.skipStop !== true) {
      const stopRes = stopTargetAppProcesses(appBundlePath, commonOpts);
      if (!stopRes.ok) {
        appendColdLog(stateDir, `stop failed: ${stopRes.error}`);
        const mainAlive = options.findPidsImpl
          ? options.findPidsImpl('main').length > 0
          : findRunningTargetPids(appBundlePath, 'main', commonOpts).length > 0;
        return finalize({ ok: false, error: stopRes.error }, { suppressRelaunch: mainAlive });
      }
      cleanupStaleSingletonLockDir(userDataDir, options.killImpl || process.kill);
    }

    // 2. Defense-in-depth check: ensure no agy CLI started during shutdown window
    const agyProcs = options.detectAgyCliImpl
      ? options.detectAgyCliImpl()
      : detectRunningAgyCliProcesses(commonOpts);
    if (Array.isArray(agyProcs) && agyProcs.length > 0) {
      const pids = agyProcs.map((p) => p.pid).join(', ');
      const errMsg = `检测到终端正在运行 agy CLI（PID: ${pids}），已中止账号切换以避免钥匙串并发覆盖`;
      appendColdLog(stateDir, errMsg);
      return finalize({ ok: false, code: 'AGY_CLI_RUNNING', agyCliPids: agyProcs.map((p) => p.pid), error: errMsg });
    }

    const registry = loadProfilesRegistry({ stateDir });
    const outgoingOnboarding = readOnboardingStateFromAppStorage(userDataDir);

    if (action === 'switch') {
      const targetId = sanitizeProfileId(job.targetId);
      if (!targetId) {
        return finalize({ ok: false, error: '未指定目标账号' });
      }
      const targetProfile = registry.profiles.find((p) => p.id === targetId);
      if (!targetProfile) {
        return finalize({ ok: false, error: '未找到目标账号快照' });
      }

      const targetSecret = kc.get(VAULT_KEYCHAIN_SERVICE, targetId);
      if (!targetSecret) {
        return finalize({ ok: false, error: '钥匙串中未找到目标账号的备份凭据，请重新登录后保存' });
      }
      const targetFp = computeTokenFingerprint(targetSecret);

      // Backup current active slot first so refreshed tokens are never lost
      const activeSecret = kc.get(ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT);
      let autoSavedPrevious = false;
      let previousProfile = null;
      if (activeSecret) {
        const activeFp = computeTokenFingerprint(activeSecret);
        if (activeFp !== targetFp) {
          const hintEmail = normalizeEmail(job.currentEmail) || extractEmailHintFromSecret(activeSecret);
          const matchedPrev = findMatchingProfile(registry.profiles, {
            activeFingerprint: activeFp,
            currentEmail: hintEmail,
          });
          const outgoingMatchesStorage =
            Boolean(outgoingOnboarding.username) &&
            (!hintEmail || normalizeEmail(outgoingOnboarding.username) === hintEmail);
          const outgoingMeta = outgoingMatchesStorage
            ? {
                onboardingUsername: outgoingOnboarding.username,
                onboardingIsGcpTos: outgoingOnboarding.isGcpTos,
              }
            : {};
          if (matchedPrev && matchedPrev.id !== targetId) {
            previousProfile = upsertProfileWithSecret(registry, kc, activeSecret, {
              email: job.currentEmail || hintEmail || matchedPrev.email,
              tierName: job.currentTierName || matchedPrev.tierName,
              label: matchedPrev.label,
              ...outgoingMeta,
            });
          } else if (!matchedPrev) {
            previousProfile = upsertProfileWithSecret(registry, kc, activeSecret, {
              email: job.currentEmail || hintEmail,
              tierName: job.currentTierName || '',
              ...outgoingMeta,
            });
            autoSavedPrevious = true;
          }
          const preSave = saveProfilesRegistry(registry, { stateDir });
          if (!preSave.ok) {
            return finalize({ ok: false, error: preSave.error || '回写原账号元数据失败，已中止切换' });
          }
        }
      }

      // Overwrite active Keychain slot atomically via stdin `security -i`
      kc.set(ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT, targetSecret);
      const verifyActive = kc.get(ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT);
      if (!verifyActive || computeTokenFingerprint(verifyActive) !== targetFp) {
        return finalize({ ok: false, error: '写入目标账号钥匙串凭据校验失败' });
      }

      // Restore target account's accepted onboarding identity so Antigravity does not
      // re-prompt the "One last thing before getting started..." modal on every switch.
      const targetOnboardingUsername =
        targetProfile.onboardingUsername ||
        extractRawEmailHintFromSecret(targetSecret) ||
        targetProfile.email ||
        '';
      const targetOnboardingIsGcpTos =
        targetProfile.onboardingIsGcpTos || extractIsGcpTosHintFromSecret(targetSecret);

      // Clean account-scoped local residues (preserving installation_id & shared conversations)
      const residueCleaned = cleanupAccountLocalResidue({
        homeDir,
        userDataDir,
        geminiDir,
        onboardingTarget: targetOnboardingUsername
          ? { username: targetOnboardingUsername, isGcpTos: targetOnboardingIsGcpTos }
          : null,
      });

      // Update target metadata timestamps
      const now = new Date().toISOString();
      const idx = registry.profiles.findIndex((p) => p.id === targetId);
      if (idx >= 0) {
        registry.profiles[idx] = {
          ...registry.profiles[idx],
          lastUsedAt: now,
          tokenFingerprint: targetFp,
          ...(targetOnboardingUsername ? { onboardingUsername: targetOnboardingUsername } : {}),
          ...(targetOnboardingIsGcpTos ? { onboardingIsGcpTos: targetOnboardingIsGcpTos } : {}),
        };
      }
      saveProfilesRegistry(registry, { stateDir });
      const switchedTo = registry.profiles.find((p) => p.id === targetId) || targetProfile;

      appendColdLog(stateDir, `switch success -> ${switchedTo.id}`);
      return finalize({
        ok: true,
        switchedTo,
        previousProfile,
        autoSavedPrevious,
        residueCleaned,
      });
    }

    if (action === 'prepare-add') {
      const activeSecret = kc.get(ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT);
      let backedUpProfile = null;
      if (activeSecret) {
        const hintEmail = normalizeEmail(job.currentEmail) || extractEmailHintFromSecret(activeSecret);
        const outgoingMatchesStorage =
          Boolean(outgoingOnboarding.username) &&
          (!hintEmail || normalizeEmail(outgoingOnboarding.username) === hintEmail);
        backedUpProfile = upsertProfileWithSecret(registry, kc, activeSecret, {
          email: job.currentEmail || hintEmail,
          tierName: job.currentTierName || '',
          ...(outgoingMatchesStorage
            ? {
                onboardingUsername: outgoingOnboarding.username,
                onboardingIsGcpTos: outgoingOnboarding.isGcpTos,
              }
            : {}),
        });
        const preSave = saveProfilesRegistry(registry, { stateDir });
        if (!preSave.ok) {
          return finalize({ ok: false, error: preSave.error || '备份当前账号元数据失败，已中止清除操作' });
        }
      }

      // Clear local active Keychain slot ONLY (do not call server-side AuthLogout)
      kc.delete(ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT);
      const stillPresent = typeof kc.has === 'function'
        ? kc.has(ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT)
        : Boolean(kc.get(ACTIVE_KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT));
      if (stillPresent) {
        return finalize({ ok: false, error: '清除当前活动钥匙串条目失败，请重试' });
      }

      const residueCleaned = cleanupAccountLocalResidue({ homeDir, userDataDir, geminiDir });
      appendColdLog(stateDir, `prepare-add success (backedUp=${backedUpProfile?.id || 'none'})`);
      return finalize({
        ok: true,
        backedUpProfile,
        clearedActive: true,
        residueCleaned,
      });
    }

    return finalize({ ok: false, error: `未知的冷切换动作: ${action}` });
  } catch (err) {
    const errMsg = err?.message || '冷切换账号过程发生异常';
    appendColdLog(stateDir, `error: ${errMsg}`);
    return finalize({ ok: false, error: errMsg });
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
  const res = executeColdAccountJob(readRes.data);
  if (!res.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  ACTIVE_KEYCHAIN_SERVICE,
  ACTIVE_KEYCHAIN_ACCOUNT,
  VAULT_KEYCHAIN_SERVICE,
  PROFILES_FILE_NAME,
  PROFILES_SCHEMA_VERSION,
  COLD_RESULT_FILE_NAME,
  COLD_LOCK_FILE_NAME,
  COLD_HELPER_FILE_NAME,
  COLD_LOG_FILE_NAME,
  MENDEL_APP_STORAGE_KEYS,
  ONBOARDING_APP_STORAGE_KEYS,
  LEGACY_ONBOARDING_APP_STORAGE_KEYS,
  ACCOUNT_SCOPED_APP_STORAGE_KEYS,
  RELAUNCH_STRIP_ENV_KEYS,
  isSupportedPlatform,
  getDefaultStateDir,
  getDefaultUserDataDir,
  getDefaultAgDir,
  isOfficialAntigravityBundle,
  shellEscapeForSecurity,
  isSecurityNotFoundError,
  sanitizeSecurityError,
  createMacOsKeychainAdapter,
  formatWindowsCredTarget,
  createWindowsKeychainAdapter,
  createPlatformKeychainAdapter,
  computeTokenFingerprint,
  normalizeEmail,
  sanitizeProfileId,
  sanitizeDisplayLabel,
  sanitizeTierName,
  parseStoredTokenMetadata,
  extractRawEmailHintFromSecret,
  extractEmailHintFromSecret,
  extractIsGcpTosHintFromSecret,
  extractTierHintFromSecret,
  readOnboardingStateFromAppStorage,
  readJsonFileSafe,
  writeJsonFileAtomic,
  getProfilesPath,
  getRuntimeDir,
  getColdResultPath,
  getColdLockPath,
  normalizeRegistryEntry,
  loadProfilesRegistry,
  saveProfilesRegistry,
  findMatchingProfile,
  upsertProfileWithSecret,
  listPsProcesses,
  listWinProcesses,
  isWindowsAppPath,
  detectRunningAgyCliProcesses,
  findRunningTargetPids,
  stopTargetAppProcesses,
  cleanupStaleSingletonLockDir,
  cleanupAccountLocalResidue,
  buildCleanRelaunchEnv,
  relaunchTargetApp,
  acquireColdLock,
  releaseColdLock,
  executeColdAccountJob,
};
