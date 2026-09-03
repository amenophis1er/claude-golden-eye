#!/usr/bin/env node
'use strict';

/**
 * claude-golden-eye installer CLI — the whole npm story in one command:
 *
 *   npx claude-golden-eye init          interactive install (safe defaults)
 *   npx claude-golden-eye init --yes    non-interactive, defaults only
 *   npx claude-golden-eye@latest init   upgrade (re-copies payload, updates plugins)
 *   npx claude-golden-eye uninstall     tear down (add --purge to drop data)
 *
 * npx runs from an ephemeral cache, so the payload (marketplace + plugins) is
 * copied to a stable home — <data dir>/app — and the Claude Code marketplace
 * points there. Zero dependencies, like everything else in this repo.
 *
 * Targets the Claude instance of the current environment (CLAUDE_CONFIG_DIR
 * or ~/.claude). For a second instance, re-run init with CLAUDE_CONFIG_DIR set.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const DATA_DIR = process.env.GOLDEN_EYE_DATA_DIR || path.join(os.homedir(), '.golden-eye');
const APP_DIR = path.join(DATA_DIR, 'app');
const MARKETPLACE = 'claude-golden-eye';
// What init copies into APP_DIR — the runtime payload, not the installer.
const PAYLOAD = ['.claude-plugin', 'plugins', 'LICENSE', 'package.json'];

const say = (msg) => process.stdout.write(msg + '\n');

// ---------- flag parsing (exported for tests) ----------
const BOOL_FLAGS = ['yes', 'pm', 'composer', 'history', 'files', 'launchd', 'purge', 'help', 'version'];

function parseCliArgs(argv) {
  const out = { command: null, flags: {}, errors: [] };
  for (const a of argv) {
    if (!a.startsWith('-')) {
      if (out.command) out.errors.push(`unexpected argument: ${a}`);
      else out.command = a;
      continue;
    }
    if (a === '-y') { out.flags.yes = true; continue; }
    const m = a.match(/^--(no-)?([a-z]+)$/);
    if (m && BOOL_FLAGS.includes(m[2])) out.flags[m[2]] = !m[1];
    else out.errors.push(`unknown flag: ${a}`);
  }
  return out;
}

// ---------- marketplace/plugin state (best-effort reads of Claude Code's
// registries; every decision falls back to plain `add`/`install` on parse
// failure, and the claude CLI remains the authority) ----------
function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** 'add' | 'update' | 'repoint' — what to do about the marketplace entry. */
function decideMarketplaceAction(known, appDir) {
  const entry = known && known[MARKETPLACE];
  if (!entry) return 'add';
  return entry.installLocation === appDir ? 'update' : 'repoint';
}

function installedPlugins() {
  const j = readJson(path.join(configDir(), 'plugins', 'installed_plugins.json'));
  return new Set(Object.keys((j && j.plugins) || {}));
}

// ---------- shell helpers ----------
function claude(args, { allowFail = false } = {}) {
  try {
    execFileSync('claude', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      say('\nThe `claude` CLI was not found on PATH.');
      say('Install Claude Code first: https://code.claude.com/docs — then re-run init.');
      process.exit(1);
    }
    if (!allowFail) {
      say(`\ncommand failed: claude ${args.join(' ')}`);
      process.exit(1);
    }
    return false;
  }
}

function ask(rl, question, def) {
  const hint = def ? 'Y/n' : 'y/N';
  return rl
    .question(`${question} [${hint}] `)
    .then((a) => (a.trim() ? /^y(es)?$/i.test(a.trim()) : def));
}

// ---------- init ----------
async function init(flags) {
  say(`golden-eye ${PKG.version} — installing into ${configDir()}`);

  // 1. Choices: flags win, then prompts (TTY only), then safe defaults.
  const interactive = !flags.yes && process.stdin.isTTY;
  const choices = {
    pm: flags.pm ?? false,
    composer: flags.composer ?? false,
    history: flags.history ?? false,
    files: flags.files ?? false,
    launchd: flags.launchd ?? false,
  };
  if (interactive) {
    const rl = readline.promises.createInterface({ input: process.stdin, output: process.stdout });
    say('\nThe dashboard plugin is always installed. Optional extras:');
    if (flags.pm === undefined)
      choices.pm = await ask(rl, 'PM mode — /pm makes the main session delegate-only?', false);
    if (flags.composer === undefined)
      choices.composer = await ask(rl, 'Composer — type into live sessions from the dashboard?', false);
    if (flags.history === undefined)
      choices.history = await ask(rl, 'History — read-only browser over past session transcripts?', false);
    if (flags.files === undefined)
      choices.files = await ask(rl, 'File viewer — open a project file referenced in a session (read-only)?', false);
    if (flags.launchd === undefined && process.platform === 'darwin')
      choices.launchd = await ask(rl, 'Always-on server — launchd service that survives reboots?', false);
    rl.close();
  }

  // 2. Payload → stable home (npx's cache dir is ephemeral; a marketplace
  // source must outlive this process).
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const entry of PAYLOAD) {
    fs.cpSync(path.join(PKG_ROOT, entry), path.join(APP_DIR, entry), { recursive: true });
  }
  say(`\npayload ${PKG.version} → ${APP_DIR}`);

  // 3. Marketplace + plugins via the claude CLI.
  const action = decideMarketplaceAction(
    readJson(path.join(configDir(), 'plugins', 'known_marketplaces.json')),
    APP_DIR
  );
  if (action === 'repoint') claude(['plugin', 'marketplace', 'remove', MARKETPLACE], { allowFail: true });
  if (action === 'update') claude(['plugin', 'marketplace', 'update', MARKETPLACE]);
  else claude(['plugin', 'marketplace', 'add', APP_DIR]);

  const have = installedPlugins();
  const wanted = ['golden-eye', ...(choices.pm ? ['golden-eye-pm'] : [])];
  for (const plug of wanted) {
    const ref = `${plug}@${MARKETPLACE}`;
    claude(['plugin', have.has(ref) ? 'update' : 'install', ref]);
  }

  // 4. Server-side opt-ins (merge — never clobber unrelated keys).
  if (choices.composer || choices.history || choices.files) {
    const file = path.join(DATA_DIR, 'config.json');
    const cfg = readJson(file) || {};
    if (choices.composer) cfg.composer = true;
    if (choices.history) cfg.history = true;
    if (choices.files) cfg.files = true;
    fs.writeFileSync(file, JSON.stringify(cfg) + '\n');
    say(`opt-ins written to ${file}`);
  }

  // 5. Optional always-on service.
  if (choices.launchd) {
    try {
      execFileSync('sh', [path.join(APP_DIR, 'plugins', 'golden-eye', 'deploy', 'install-launchd.sh')], { stdio: 'inherit' });
    } catch (_) {
      say('launchd setup failed — you can retry later with deploy/install-launchd.sh');
    }
  }

  // 6. Boot (or restart, so new opt-ins/payload apply) and hand over the URL.
  const server = readJson(path.join(DATA_DIR, 'server.json'));
  if (server && server.pid) {
    try { process.kill(server.pid); say('restarted the running dashboard server'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const boot = spawn('node', [path.join(APP_DIR, 'plugins', 'golden-eye', 'server', 'boot.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await new Promise((r) => boot.on('exit', r));

  const port = (readJson(path.join(DATA_DIR, 'server.json')) || {}).port || 7717;
  say(`\n✔ installed — dashboard: http://127.0.0.1:${port}`);
  say('  restart Claude Code sessions so they load the hooks and start reporting.');
  if (choices.composer) {
    say('  composer needs each session started with (alias this):');
    say(`    claude --dangerously-load-development-channels plugin:golden-eye@${MARKETPLACE}`);
  }
  say(`  upgrade later: npx ${PKG.name}@latest init · remove: npx ${PKG.name} uninstall`);
}

// ---------- uninstall ----------
async function uninstall(flags) {
  for (const plug of ['golden-eye-pm', 'golden-eye']) {
    claude(['plugin', 'uninstall', `${plug}@${MARKETPLACE}`], { allowFail: true });
  }
  claude(['plugin', 'marketplace', 'remove', MARKETPLACE], { allowFail: true });
  // Server/launchd/data teardown — the packaged script (payload copy first,
  // falling back to the npx cache copy running right now).
  const script = [APP_DIR, PKG_ROOT]
    .map((d) => path.join(d, 'plugins', 'golden-eye', 'deploy', 'uninstall.sh'))
    .find(fs.existsSync);
  if (script) {
    try { execFileSync('sh', flags.purge ? [script, '--purge'] : [script], { stdio: 'inherit' }); } catch (_) {}
  }
  if (!flags.purge) fs.rmSync(APP_DIR, { recursive: true, force: true }); // --purge already removed the data dir
  say('\n✔ uninstalled' + (flags.purge ? ' (data purged)' : ` — data kept in ${DATA_DIR}`));
}

// ---------- entry ----------
const USAGE = `claude-golden-eye ${PKG.version}

  npx claude-golden-eye init         install (interactive; --yes for defaults)
  npx claude-golden-eye uninstall    remove (--purge also deletes ${DATA_DIR})

init flags: --yes  --[no-]pm  --[no-]composer  --[no-]history  --[no-]files
            --[no-]launchd
Target instance: the current CLAUDE_CONFIG_DIR (default ~/.claude).`;

async function main() {
  const { command, flags, errors } = parseCliArgs(process.argv.slice(2));
  if (errors.length) { say(errors.join('\n') + '\n\n' + USAGE); process.exit(1); }
  if (flags.version) return say(PKG.version);
  if (flags.help || !command) return say(USAGE);
  if (command === 'init') return init(flags);
  if (command === 'uninstall') return uninstall(flags);
  say(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => { say(String((err && err.message) || err)); process.exit(1); });
}

module.exports = { parseCliArgs, decideMarketplaceAction };
