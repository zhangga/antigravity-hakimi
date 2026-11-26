#!/usr/bin/env node
'use strict';

/**
 * Cross-platform (macOS Keychain & Windows Credential Manager) CLI for
 * managing and cold-switching Antigravity Hakimi Google/Gemini accounts.
 *
 * Security invariants:
 * - Zero plaintext tokens written to disk, CLI args, or stdout.
 * - Strictly refuses to terminate or relaunch official Antigravity installations.
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const switcher = require(path.join(ROOT, 'payload', 'dist', 'meter-account-switcher'));

function printHelp() {
  console.log(`Usage: node scripts/account-switch.js <command> [options]

Commands:
  status                         查看当前登录状态与已保存账号快照
  save [--label <备注>]          将当前活动账号保存到系统凭据保险库
  switch <id|email>              冷切换到已保存账号（自动备份当前账号并重启 Hakimi）
  add                            备份当前账号并清空活动凭据，重启进入官方登录页
  rename <id|email> <新备注>     修改已保存账号的显示备注
  remove <id|email>              从备份保险库删除指定账号（不影响当前登录态）

Options:
  --app <path>                   指定 Hakimi 应用路径（默认自动定位，严禁指向官方原版）
  --json                         以 JSON 格式输出结果
  -h, --help                     显示帮助`);
}

function parseCliArgs(argv) {
  const args = [];
  const opts = { json: false, help: false, label: undefined, appBundlePath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--label' && argv[i + 1] !== undefined) opts.label = argv[++i];
    else if (a === '--app' && argv[i + 1] !== undefined) opts.appBundlePath = argv[++i];
    else if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    else args.push(a);
  }
  return { cmd: args[0] || 'status', rest: args.slice(1), opts };
}

function formatStatus(res) {
  if (!res.ok) return `ERROR: ${res.error || '获取账号状态失败'}`;
  const lines = [
    `Platform: ${process.platform} (supported=${res.supported})`,
    `Active:   ${res.hasActiveToken ? `${res.activeEmail || '(unknown)'}${res.activeTierName ? ` [${res.activeTierName}]` : ''}${res.currentUnsaved ? ' (未保存)' : ''}` : '未登录'}`,
  ];
  if (res.agyCliRunning) {
    lines.push(`Warning:  agy CLI 正在运行 (PID: ${res.agyCliPids.join(', ')})，切号将被拦截`);
  }
  lines.push('');
  if (!res.profiles || res.profiles.length === 0) {
    lines.push('Saved profiles: (无，运行 `node scripts/account-switch.js save` 保存当前账号)');
  } else {
    lines.push(`Saved profiles (${res.profiles.length}):`);
    for (const p of res.profiles) {
      const mark = p.isActive ? '*' : ' ';
      const vault = p.vaultPresent ? 'vault:OK' : 'vault:MISSING';
      const label = p.label ? ` (${p.label})` : '';
      const tier = p.tierName ? ` [${p.tierName}]` : '';
      lines.push(`  ${mark} ${p.id}${label}${tier} — ${vault}`);
    }
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const { cmd, rest, opts } = parseCliArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  const common = {};
  if (opts.appBundlePath) common.appBundlePath = opts.appBundlePath;

  let res;
  if (cmd === 'status') {
    res = switcher.getAccountsStatus(common);
  } else if (cmd === 'save') {
    res = switcher.saveCurrentAccount({ label: opts.label }, common);
  } else if (cmd === 'switch') {
    const targetId = rest[0];
    if (!targetId) throw new Error('请指定要切换的目标账号 ID 或邮箱');
    res = switcher.startColdSwitchAccount({ targetId }, common);
  } else if (cmd === 'add' || cmd === 'prepare-add') {
    res = switcher.startColdPrepareAddAccount({}, common);
  } else if (cmd === 'rename') {
    const [targetId, ...labelParts] = rest;
    if (!targetId) throw new Error('用法: rename <id|email> <新备注>');
    res = switcher.renameAccount({ targetId, label: labelParts.join(' ') }, common);
  } else if (cmd === 'remove' || cmd === 'rm') {
    const targetId = rest[0];
    if (!targetId) throw new Error('用法: remove <id|email>');
    res = switcher.removeAccount({ targetId }, common);
  } else {
    throw new Error(`未知子命令: ${cmd}`);
  }

  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'status') {
    console.log(formatStatus(res));
  } else if (res.ok) {
    console.log(`OK: ${cmd} completed${res.coldSwitching ? ` (cold helper PID=${res.helperPid || '?'})` : ''}`);
  } else {
    console.error(`ERROR: ${res.error || '操作失败'}`);
  }

  return res.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`ERROR: ${err?.message || String(err)}`);
    process.exit(1);
  }
}

module.exports = { parseCliArgs, formatStatus, main };
