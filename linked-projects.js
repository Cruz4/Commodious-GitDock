'use strict';
/**
 * GitDock Linked Projects and Smart Sync.
 * Works on the ORIGINAL local folder, but uses a separate private Git checkout
 * for GitHub operations. Never initializes or modifies .git in the source.
 * Copyright (c) 2026 Commodious Works LLC. MIT.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const LIMIT_FILES = 10000;
const LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const LIMIT_FILE = 99 * 1024 * 1024;
const MAX_DETAILS = 250;
const MODES = new Set(['off', 'review', 'auto']);
const BLOCKED = new Set(['.git', '.gitdock', 'node_modules', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.turbo', '.cache', 'coverage', 'dist', 'build', 'target', '.idea', '.terraform']);
const SECRET_NAMES = [/^\.env(?:\..*)?$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.netrc$/i, /^id_(rsa|ed25519|ecdsa)(?:\.pub)?$/i, /^(?:credentials|service[-_]?account)(?:[-_.].*)?\.json$/i, /\.(?:p12|pfx|key)$/i, /^\.DS_Store$/];
function isExcluded(relative) {
  return relative.split('/').some(s => BLOCKED.has(s.toLowerCase()) || SECRET_NAMES.some(re => re.test(s)));
}
function validateRepoName(repo) {
  if (typeof repo !== 'string' || repo.length > 140 || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || repo.split('/').some(s => s === '.' || s === '..' || s.startsWith('-'))) throw Error('Enter a valid owner/repository.');
  return repo;
}
function validateBranch(branch) {
  if (typeof branch !== 'string' || branch.length > 180 || !branch || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || /(?:\.\.|\/\/|\@\{|[\s~^:?*\[\\\x00-\x1f])/.test(branch) || branch.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.lock'))) throw Error('Invalid Git branch name.');
  return branch;
}
async function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let len = 0;
    const max = options.maxOutput || 12 * 1024 * 1024;
    const timer = setTimeout(() => child.kill(), options.timeout || 180000);
    child.stdout.on('data', data => { len += data.length; if (len <= max) stdout.push(data); else child.kill(); });
    child.stderr.on('data', data => { if (Buffer.concat(stderr).length < 10000) stderr.push(data); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr).toString('utf8').trim();
      if (len > max) return reject(Error('Git output exceeded the limit for this project.'));
      if (code === 0 || options.allow?.includes(code)) return resolve({ stdout: out, text: out.toString('utf8').trim(), code });
      reject(Error((err || out.toString('utf8') || `${binary} exited with ${code}`).slice(-850)));
    });
  });
}
async function atomicWrite(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try { await fsp.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); await fsp.rename(temp, file); }
  finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
}
async function gitBlobSha(file, length) {
  const hash = crypto.createHash('sha1');
  hash.update(`blob ${length}\0`);
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', data => hash.update(data));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
function safeName(relative) {
  const names = relative.split('/');
  if (!relative || relative.length > 1800 || names.some(s => !s || s === '.' || s === '..' || /[\x00-\x1f<>:"|?*\\]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(s))) throw Error('Unsafe filename in local folder.');
  return relative;
}
async function snapshot(root, previous = new Map()) {
  const files = new Map();
  let total = 0, skipped = 0;
  async function walk(folder, prefix) {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcluded(rel)) { skipped++; continue; }
      if (entry.isSymbolicLink()) { skipped++; continue; }
      if (entry.isDirectory()) { await walk(path.join(folder, entry.name), rel); continue; }
      if (!entry.isFile()) { skipped++; continue; }
      safeName(rel);
      const file = path.join(folder, entry.name), stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.size > LIMIT_FILE) { skipped++; continue; }
      total += stat.size;
      if (total > LIMIT_BYTES || files.size >= LIMIT_FILES) throw Error('Linked project exceeds the 2 GB or 10,000-file limit.');
      const old = previous.get(rel);
      const sha = old && old.size === stat.size && old.mtimeMs === stat.mtimeMs ? old.sha : await gitBlobSha(file, stat.size);
      files.set(rel, { sha, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  await walk(root, '');
  return { files, skipped, total };
}
function treeFromBuffer(buffer) {
  const result = new Map();
  // git ls-tree -r -z HEAD: <mode> <type> <sha>\t<path>\0
  for (const item of buffer.toString('utf8').split('\0')) {
    if (!item) continue;
    const tab = item.indexOf('\t'); if (tab < 0) continue;
    const info = item.slice(0, tab).split(' ');
    if (info[1] === 'blob') result.set(item.slice(tab + 1), { sha: info[2], mode: info[0] });
  }
  return result;
}
function changes(files, remote, managed = {}, deletes = false) {
  const result = [];
  for (const [rel, file] of files) {
    const theirs = remote.get(rel);
    if (!theirs) result.push({ path: rel, type: 'added', bytes: file.size });
    else if (theirs.sha !== file.sha) result.push({ path: rel, type: 'modified', bytes: file.size });
  }
  for (const rel of Object.keys(managed)) {
    if (!files.has(rel) && remote.has(rel) && !isExcluded(rel)) result.push({ path: rel, type: deletes ? 'deleted' : 'deletion-ignored', bytes: 0 });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function rejectSymlinks(root, relative) {
  let p = root;
  for (const part of relative.split('/')) {
    p = path.join(p, part);
    const stat = await fsp.lstat(p).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat?.isSymbolicLink()) throw Error('Refusing to overwrite a symbolic link in repository: ' + relative);
  }
}
class LinkedProjects {
  constructor(opts = {}) {
    this.dir = opts.dir || process.env.GITDOCK_CONFIG_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.config'), 'Commodious Works', 'GitDock');
    this.database = path.join(this.dir, 'linked-projects.json');
    this.cache = path.join(this.dir, 'linked-checkouts');
    this.projects = new Map();
    this.runtime = new Map();
    this.exec = opts.exec || run;
    this.checkAuth = opts.checkAuth || (async () => true);
    this.secretCheck = opts.secretCheck || (async () => []);
    this.clone = opts.clone || (async (repo, branch, target) => {
      try { await this.exec('gh', ['repo', 'clone', repo, target, '--', '--branch', branch, '--single-branch', '--depth', '1'], { timeout: 240000 }); }
      catch (error) {
        // Git cannot clone an explicit branch in a brand-new empty repository.
        const blank = await this.exec('gh', ['repo','view',repo,'--json','isEmpty','--jq','.isEmpty']).then(x => x.text === 'true').catch(() => false);
        if (!blank) throw error;
        await fsp.rm(target, { recursive: true, force: true });
        await this.exec('gh', ['repo','clone',repo,target], { timeout: 240000 });
      }
    });
    this.ticker = null;
  }
  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    let entries = [];
    try { const raw = JSON.parse(await fsp.readFile(this.database, 'utf8')); entries = Array.isArray(raw.projects) ? raw.projects : []; }
    catch (e) { if (e.code !== 'ENOENT') console.error('[GitDock links] Could not load settings:', e.message); }
    for (const item of entries) {
      try {
        validateRepoName(item.repo); validateBranch(item.branch);
        if (!/^[0-9a-f-]{36}$/.test(item.id) || !path.isAbsolute(item.root) || !MODES.has(item.mode)) continue;
        const project = { id: item.id, root: item.root, repo: item.repo, branch: item.branch, mode: item.mode,
          deletions: !!item.deletions, managed: item.managed || {}, lastSync: item.lastSync || null, created: item.created || Date.now() };
        this.projects.set(item.id, project);
        this.runtime.set(item.id, this.freshRuntime());
        if (item.mode !== 'off') this.activate(project);
      } catch { /* invalid saved link */ }
    }
    this.ticker = setInterval(() => {
      for (const project of this.projects.values()) if (project.mode !== 'off') this.queueScan(project.id, 0);
    }, 12000);
    this.ticker.unref();
  }
  freshRuntime() { return { files: new Map(), remote: new Map(), diff: [], skipped: 0, total: 0, busy: false, error: '', note: '', watch: null, scanTimer: null, syncTimer: null, scanning: false, pending: false, initialized: false, hasRemote: false, remoteSha: '', autoPaused: false, autoSignature: '', syncCount: 0 }; }
  async save() {
    const projects = [...this.projects.values()].map(p => ({ id: p.id, root: p.root, repo: p.repo, branch: p.branch, mode: p.mode, deletions: p.deletions, managed: p.managed, lastSync: p.lastSync, created: p.created }));
    await atomicWrite(this.database, { version: 1, projects });
  }
  status(project) {
    const rt = this.runtime.get(project.id);
    const items = rt.diff;
    return { id: project.id, root: project.root, repo: project.repo, branch: project.branch, mode: project.mode,
      deletions: project.deletions, lastSync: project.lastSync, connected: rt.initialized, busy: rt.busy, error: rt.error, note: rt.note,
      paused: rt.autoPaused, changes: items.slice(0, MAX_DETAILS), more: Math.max(0, items.length - MAX_DETAILS),
      counts: { added: items.filter(x => x.type === 'added').length, modified: items.filter(x => x.type === 'modified').length,
        deleted: items.filter(x => x.type === 'deleted').length, ignoredDeletions: items.filter(x => x.type === 'deletion-ignored').length },
      localFiles: rt.files.size, skipped: rt.skipped, totalBytes: rt.total, link: 'https://github.com/' + project.repo + '/tree/' + encodeURIComponent(project.branch) };
  }
  list() { return [...this.projects.values()].map(p => this.status(p)); }
  activate(project) {
    const rt = this.runtime.get(project.id);
    if (rt.watch) return;
    try {
      rt.watch = fs.watch(project.root, { recursive: process.platform === 'win32' }, () => this.queueScan(project.id, 1250));
      rt.watch.on('error', e => { rt.note = `File watcher unavailable (${e.message}); using periodic checks.`; rt.watch?.close(); rt.watch = null; });
    } catch { rt.note = 'Using periodic folder scans on this system.'; }
    this.queueScan(project.id, 100);
  }
  deactivate(id) {
    const rt = this.runtime.get(id); if (!rt) return;
    rt.watch?.close(); rt.watch = null;
    clearTimeout(rt.scanTimer); clearTimeout(rt.syncTimer);
    rt.scanTimer = null; rt.syncTimer = null;
  }
  queueScan(id, delay = 1000) {
    const p = this.projects.get(id), rt = this.runtime.get(id); if (!p || p.mode === 'off' || !rt) return;
    clearTimeout(rt.scanTimer);
    rt.scanTimer = setTimeout(() => { void this.refresh(id).catch(() => {}); }, delay);
    rt.scanTimer.unref?.();
  }
  async refresh(id, opts = {}) {
    const p = this.get(id), rt = this.runtime.get(id);
    if (rt.scanning || rt.busy) { rt.pending = true; return this.status(p); }
    rt.scanning = true;
    try {
      const local = await snapshot(p.root, rt.files);
      rt.files = local.files; rt.skipped = local.skipped; rt.total = local.total;
      if (opts.remote || !rt.hasRemote) await this.remoteTree(p, !!opts.remote);
      rt.diff = changes(rt.files, rt.remote, p.managed, p.deletions);
      rt.initialized = true; if (!rt.autoPaused) rt.error = '';
      if (p.mode === 'auto' && !rt.autoPaused && !rt.busy && rt.diff.some(x => ['added', 'modified', 'deleted'].includes(x.type))) this.queueAuto(id);
    } catch (e) { rt.error = e.message; throw e; }
    finally {
      rt.scanning = false;
      if (rt.pending) { rt.pending = false; this.queueScan(id, 1000); }
    }
    return this.status(p);
  }
  get(id) { const p = this.projects.get(id); if (!p) throw Error('Linked project not found.'); return p; }
  async create(input) {
    const auth = await this.checkAuth(); if (!auth) throw Error('Connect GitHub before linking a project.');
    await this.exec('gh', ['auth', 'setup-git', '--hostname', 'github.com']);
    const root = path.resolve(String(input.root || ''));
    const stat = await fsp.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw Error('Choose an existing local project folder.');
    const real = await fsp.realpath(root);
    const repo = validateRepoName(input.repo);
    let branch = String(input.branch || '').trim();
    if (!branch) {
      const data = await this.exec('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { timeout: 30000 });
      branch = data.text;
      if (!branch) branch = 'main';
    }
    validateBranch(branch);
    if ([...this.projects.values()].some(p => p.root.toLowerCase() === real.toLowerCase() && p.repo.toLowerCase() === repo.toLowerCase() && p.branch === branch)) throw Error('This folder and repository are already linked.');
    // First link is always review-only. Auto-sync needs explicit opt-in AFTER setup.
    const p = { id: crypto.randomUUID(), root: real, repo, branch, mode: 'review', deletions: false, managed: {}, lastSync: null, created: Date.now() };
    this.projects.set(p.id, p); this.runtime.set(p.id, this.freshRuntime());
    try { await this.refresh(p.id, { remote: true }); await this.save(); this.activate(p); return this.status(p); }
    catch (e) { this.projects.delete(p.id); this.deactivate(p.id); this.runtime.delete(p.id); await fsp.rm(path.join(this.cache, p.id), { recursive: true, force: true }).catch(() => {}); throw e; }
  }
  async remoteTree(p, refresh = false) {
    const rt = this.runtime.get(p.id), checkout = path.join(this.cache, p.id);
    let present = false;
    try { present = (await fsp.stat(path.join(checkout, '.git'))).isDirectory(); } catch { /* new */ }
    if (!present) { await fsp.mkdir(this.cache, { recursive: true }); await this.clone(p.repo, p.branch, checkout); }
    else if (refresh) {
      const branch = await this.exec('git', ['-C', checkout, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${p.branch}`], { allow: [2], timeout: 30000 });
      if (branch.code === 2) {
        if (rt.remoteSha) throw Error('GitHub branch was deleted. Sync stopped to protect your project.');
        // New empty GitHub repository: no branch exists until first push.
      } else {
        await this.exec('git', ['-C', checkout, 'fetch', '--depth', '1', 'origin', `refs/heads/${p.branch}`], { timeout: 180000 });
        // This checkout is GitDock's OWN cache, not the actual Cursor project folder.
        await this.exec('git', ['-C', checkout, 'reset', '--hard', 'FETCH_HEAD'], { timeout: 90000 });
      }
    }
    const head = await this.exec('git', ['-C', checkout, 'rev-parse', '--verify', 'HEAD'], { allow: [128] });
    if (head.code !== 0) {
      await this.exec('git', ['-C', checkout, 'symbolic-ref', 'HEAD', `refs/heads/${p.branch}`]);
      rt.remote = new Map(); rt.remoteSha = ''; rt.hasRemote = true;
      return;
    }
    rt.remoteSha = head.text;
    const output = await this.exec('git', ['-C', checkout, 'ls-tree', '-r', '-z', 'HEAD'], { maxOutput: 15 * 1024 * 1024 });
    rt.remote = treeFromBuffer(output.stdout); rt.hasRemote = true;
  }
  queueAuto(id) {
    const p = this.projects.get(id), rt = this.runtime.get(id);
    if (!p || p.mode !== 'auto' || rt.autoPaused || rt.busy) return;
    const sig = rt.diff.filter(x => ['added','modified','deleted'].includes(x.type))
      .map(x => x.path + ':' + x.type + ':' + (rt.files.get(x.path)?.sha || 'deleted')).join('\n');
    if (rt.syncTimer && sig === rt.autoSignature) return;
    rt.autoSignature = sig;
    clearTimeout(rt.syncTimer);
    // Wait until Cursor's rapid saves settle; changes are still rechecked before pushing.
    rt.syncTimer = setTimeout(() => { void this.sync(id, { automatic: true }).catch(() => {}); }, 4500);
    rt.syncTimer.unref?.();
  }
  async settings(id, input) {
    const p = this.get(id), rt = this.runtime.get(id);
    if (typeof input.mode === 'string') {
      if (!MODES.has(input.mode)) throw Error('Select Off, Review & Sync, or Auto-Sync.');
      if (input.mode === 'auto' && !(await this.checkAuth())) throw Error('Connect GitHub before enabling Auto-Sync.');
      p.mode = input.mode;
      rt.autoPaused = false;
      if (p.mode === 'off') this.deactivate(id); else this.activate(p);
    }
    if (typeof input.deletions === 'boolean') p.deletions = input.deletions;
    rt.diff = changes(rt.files, rt.remote, p.managed, p.deletions);
    await this.save();
    if (p.mode === 'auto' && rt.diff.some(x => ['added', 'modified', 'deleted'].includes(x.type))) this.queueAuto(id);
    return this.status(p);
  }
  async sync(id, opts = {}) {
    const p = this.get(id), rt = this.runtime.get(id);
    if (rt.busy) throw Error('This project is already syncing.');
    if (!(await this.checkAuth())) throw Error('Connect GitHub before syncing.');
    await this.exec('gh', ['auth', 'setup-git', '--hostname', 'github.com']);
    rt.busy = true; rt.error = ''; rt.note = 'Checking the latest GitHub branch before syncing…';
    clearTimeout(rt.syncTimer); rt.syncTimer = null; rt.autoSignature = '';
    let scanWaits = 0;
    while (rt.scanning && scanWaits++ < 600) await new Promise(r => setTimeout(r, 50));
    if (rt.scanning) { rt.busy = false; throw Error('The project is still scanning. Try Sync Now again.'); }
    const checkout = path.join(this.cache, id);
    try {
      // Ensure every sync starts from current GitHub and cannot force-push.
      const before = rt.remoteSha;
      const hadPreview = rt.hasRemote;
      await this.remoteTree(p, true);
      if (hadPreview && before !== rt.remoteSha) {
        rt.autoPaused = true;
        rt.note = 'GitHub changed since your last preview. Review changes and click Sync Now again.';
        throw Error('GitHub has new commits. Review the updated changes before syncing.');
      }
      const local = await snapshot(p.root, rt.files);
      rt.files = local.files; rt.skipped = local.skipped; rt.total = local.total;
      rt.diff = changes(rt.files, rt.remote, p.managed, p.deletions);
      const actionable = rt.diff.filter(x => ['added', 'modified', 'deleted'].includes(x.type));
      if (!actionable.length) { rt.note = 'Already up to date. Remote-only files are preserved.'; rt.autoPaused = false; return this.status(p); }
      const upload = actionable.filter(x => x.type !== 'deleted').map(x => x.path);
      const flagged = await this.secretCheck(p.root, upload);
      if (flagged.length) { rt.autoPaused = true; throw Error('Possible secret/API key found. Sync stopped: ' + flagged.slice(0, 6).join(', ')); }
      for (const item of actionable) {
        const dest = path.join(checkout, ...item.path.split('/'));
        await rejectSymlinks(checkout, item.path);
        if (item.type === 'deleted') await fsp.rm(dest, { force: true });
        else {
          await rejectSymlinks(p.root, item.path);
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(path.join(p.root, ...item.path.split('/')), dest);
        }
      }
      const paths = actionable.map(x => x.path);
      // '--' explicitly terminates arguments; only include changed files.
      await this.exec('git', ['-C', checkout, 'add', '-A', '--', ...paths], { timeout: 200000 });
      const staged = await this.exec('git', ['-C', checkout, 'diff', '--cached', '--quiet'], { allow: [1] });
      if (staged.code === 1) {
        const user = await this.exec('gh', ['api', 'user', '--jq', '{login: .login, id: .id, name: .name}']);
        const profile = JSON.parse(user.text);
        const author = String(profile.name || profile.login || 'GitDock User').slice(0, 120);
        const email = `${profile.id}+${profile.login}@users.noreply.github.com`;
        await this.exec('git', ['-C', checkout, '-c', `user.name=${author}`, '-c', `user.email=${email}`, 'commit', '-m', `Sync ${path.basename(p.root)} via Commodious GitDock`], { timeout: 120000 });
        rt.note = 'Pushing changes to GitHub…';
        await this.exec('git', ['-C', checkout, 'push', 'origin', `HEAD:refs/heads/${p.branch}`], { timeout: 300000 });
      }
      // Mark files as managed only after a successful sync. Never delete remote-only files.
      const nextManaged = { ...p.managed };
      for (const item of actionable) if (item.type === 'deleted') delete nextManaged[item.path];
      for (const rel of rt.files.keys()) nextManaged[rel] = true;
      p.managed = nextManaged;
      p.lastSync = new Date().toISOString();
      rt.remoteSha = (await this.exec('git', ['-C', checkout, 'rev-parse', 'HEAD'])).text;
      rt.remote = treeFromBuffer((await this.exec('git', ['-C', checkout, 'ls-tree', '-r', '-z', 'HEAD'])).stdout);
      rt.diff = changes(rt.files, rt.remote, p.managed, p.deletions);
      rt.syncCount++;
      rt.autoPaused = false;
      rt.note = `Synced ${actionable.length} changed file(s) to ${p.repo} (${p.branch}).`;
      await this.save();
      return this.status(p);
    } catch (e) {
      rt.error = e.message;
      rt.autoPaused = true; // never hammer GitHub with repeated retries
      throw e;
    } finally {
      rt.busy = false;
      // A Cursor save may have happened during the push: check once more.
      if (p.mode !== 'off') this.queueScan(id, 1800);
    }
  }
  async diff(id, relative) {
    const p = this.get(id), rt = this.runtime.get(id);
    safeName(relative);
    if (isExcluded(relative) || !rt.diff.some(x => x.path === relative)) throw Error('Select a changed file to preview.');
    const cache = path.join(this.cache, id);
    const remote = path.join(cache, ...relative.split('/'));
    const local = path.join(p.root, ...relative.split('/'));
    let empty = '';
    try {
      await rejectSymlinks(cache, relative);
      await rejectSymlinks(p.root, relative);
      const a = await fsp.stat(remote).catch(() => null), b = await fsp.stat(local).catch(() => null);
      if ((a?.size || 0) > 350_000 || (b?.size || 0) > 350_000) throw Error('File too large for inline diff. Download or open the file in Cursor to review it.');
      if ((!a || !a.isFile()) && (!b || !b.isFile())) return { diff: '', message: 'File no longer exists.' };
      empty = path.join(this.dir, `empty-diff-${id}`);
      await fsp.writeFile(empty, '', { mode: 0o600 });
      const result = await this.exec('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', a?.isFile() ? remote : empty, b?.isFile() ? local : empty], { allow: [1], maxOutput: 220000, timeout: 18000 });
      const diff = result.text;
      if (diff.includes('Binary files')) return { diff: '', message: 'Binary file changed. Preview it in Cursor.' };
      return { diff: diff.length > 120000 ? diff.slice(0, 120000) + '\n…diff truncated…' : diff };
    } finally { if (empty) await fsp.rm(empty, { force: true }).catch(() => {}); }
  }
  async remove(id) {
    this.get(id);
    this.deactivate(id);
    this.projects.delete(id); this.runtime.delete(id);
    await this.save();
    await fsp.rm(path.join(this.cache, id), { recursive: true, force: true }).catch(() => {});
    return { removed: true };
  }
  stop() {
    clearInterval(this.ticker);
    for (const id of this.projects.keys()) this.deactivate(id);
  }
}
module.exports = { LinkedProjects, snapshot, changes, treeFromBuffer, validateRepoName, validateBranch, isExcluded, gitBlobSha };
