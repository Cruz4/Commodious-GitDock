'use strict';

/**
 * Commodious GitDock — local-only GitHub project publisher.
 * Copyright (c) 2026 Commodious Works LLC. MIT License.
 * No token collection: authentication is handled by the official GitHub CLI.
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { readZipEntries, extractEntry, MAX_ZIP } = require('./zip');
const { LinkedProjects } = require('./linked-projects');

const HOST = '127.0.0.1';
const PORT = Number(process.env.GITDOCK_PORT || 0);
const TOKEN = crypto.randomBytes(24).toString('hex');
const PUBLIC = path.join(__dirname, 'public');
const JOBS = new Map();
const LINKS = new LinkedProjects({
  checkAuth: async () => { const s = await prereqs(); return !!(s.git && s.gh && s.connected); },
  secretCheck: (folder, files) => secretCheck(folder, files)
});
let linksReady;
const SESSION_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'commodious-gitdock-session-'));
process.once('exit', () => {
  // A graceful app shutdown erases staging files, including uploads not yet published.
  try { fs.rmSync(SESSION_TEMP, { recursive: true, force: true }); } catch { /* shutdown */ }
});
const MAX_SINGLE = 99 * 1024 * 1024; // below GitHub's 100 MiB hard limit
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const MAX_ITEMS = 10000;
const BODY_LIMIT = 128 * 1024;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.turbo', '.cache', 'coverage', 'dist', 'build', 'target', '.idea', '.terraform']);
const IGNORE_FILES = [/^\.env(?:\..*)?$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.netrc$/i, /^id_(rsa|ed25519|ecdsa)(?:\.pub)?$/i, /^(?:credentials|service[-_]?account)(?:[-_.].*)?\.json$/i, /\.(?:p12|pfx|key)$/i, /^\.DS_Store$/];
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{15,}/,
  /\bsk_live_[A-Za-z0-9]{16,}/,
  /\bsk-proj-[A-Za-z0-9_-]{18,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:^|\n)\s*(?:OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|STRIPE_SECRET_KEY|DATABASE_URL|AWS_SECRET_ACCESS_KEY)\s*=\s*[^\s#]{10,}/i,
];

function cleanPath(input) {
  if (typeof input !== 'string' || !input || input.length > 1800 || input.includes('\0')) throw Error('Invalid file path.');
  let normalized = input.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) throw Error('Absolute paths are not allowed.');
  const parts = normalized.split('/');
  if (parts.some(s => !s || s === '.' || s === '..' || /[\x00-\x1f<>:"|?*]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(s))) throw Error('Unsafe or unsupported file path.');
  return parts.join('/');
}
function isIgnored(p) {
  const segments = p.toLowerCase().split('/');
  return segments.some(s => IGNORED_DIRS.has(s)) || segments.some(s => IGNORE_FILES.some(re => re.test(s)));
}
function destination(root, relative) {
  const base = path.resolve(root), result = path.resolve(root, ...cleanPath(relative).split('/'));
  if (!result.startsWith(base + path.sep)) throw Error('Unsafe destination.');
  return result;
}
function validateRepo(repo, existing) {
  if (typeof repo !== 'string' || repo.length > 140) throw Error('Enter a repository name.');
  const segment = '[A-Za-z0-9_.-]+';
  if (!new RegExp(existing ? `^${segment}/${segment}$` : `^${segment}$`).test(repo)) throw Error(existing ? 'Select an existing owner/repository.' : 'Repository names can contain letters, numbers, -, _, and periods.');
  if (repo.split('/').some(part => part === '.' || part === '..' || part.startsWith('-'))) throw Error('Invalid repository name.');
  return repo;
}
function json(res, status, data) {
  const content = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': content.length, 'X-Content-Type-Options': 'nosniff' });
  res.end(content);
}
function log(job, step, detail) {
  job.step = step;
  if (detail) job.messages.push({ time: Date.now(), message: detail });
  if (job.messages.length > 45) job.messages.shift();
}
function summary(job) {
  return { id: job.id, state: job.state, step: job.step, files: job.files, bytes: job.bytes, messages: job.messages, skipped: job.skipped.slice(-25), result: job.result || null, error: job.error || null };
}
async function readJson(req) {
  const parts = []; let sum = 0;
  for await (const chunk of req) {
    sum += chunk.length; if (sum > BODY_LIMIT) throw Error('Request too large.');
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { throw Error('Invalid request body.'); }
}
async function cmd(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), options.timeout || 120000);
    child.stdout.on('data', c => { stdout = (stdout + c.toString()).slice(-12000); });
    child.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-12000); });
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0 || (options.acceptCode && options.acceptCode.includes(code))) resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      else reject(new Error((stderr || stdout || `${binary} exited with code ${code}`).trim().slice(-700)));
    });
  });
}
async function prereqs() {
  const [git, gh] = await Promise.all([cmd('git', ['--version'], { timeout: 9000 }).then(() => true).catch(() => false), cmd('gh', ['--version'], { timeout: 9000 }).then(() => true).catch(() => false)]);
  let connected = false, user = null;
  if (gh) {
    connected = await cmd('gh', ['auth', 'status', '-h', 'github.com'], { timeout: 13000 }).then(() => true).catch(() => false);
    if (connected) {
      try { user = JSON.parse((await cmd('gh', ['api', 'user', '--jq', '{login: .login, id: .id, name: .name}'], { timeout: 13000 })).stdout); } catch { /* can retry on publish */ }
    }
  }
  return { git, gh, connected, user };
}
function startLogin() {
  const args = ['auth', 'login', '--web', '--git-protocol', 'https', '-h', 'github.com', '-s', 'repo,workflow'];
  if (process.platform === 'win32') {
    // Keep the visible terminal so a first-time user can see and complete device-code auth.
    const shell = 'gh ' + args.map(a => a.replace(/[^\w,.-]/g, '')).join(' ') + ' && echo. && echo Login complete. You can close this window. || pause';
    const child = spawn('cmd.exe', ['/c', 'start', 'GitDock GitHub Login', 'cmd.exe', '/k', shell], { windowsHide: false, detached: true, stdio: 'ignore' });
    child.unref();
  } else if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "gh auth login --web --git-protocol https -h github.com -s repo,workflow"`;
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }); child.unref();
  } else {
    const child = spawn('x-terminal-emulator', ['-e', 'gh', ...args], { detached: true, stdio: 'ignore' }); child.unref();
  }
}
async function stageArchive(zipFile, job, archiveName) {
  const entries = await readZipEntries(zipFile);
  if (entries.length + job.files > MAX_ITEMS) throw Error('ZIP contains too many files.');
  const base = path.posix.basename(archiveName).replace(/\.zip$/i, '');
  const parent = path.posix.dirname(archiveName) === '.' ? '' : path.posix.dirname(archiveName) + '/';
  const roots = new Set(entries.map(e => e.name.split('/')[0]));
  const nested = roots.size === 1 && entries.every(e => e.name.includes('/'));
  let extracted = 0, ignored = 0, expanded = 0;
  for (const entry of entries) {
    const relative = cleanPath((nested ? parent : parent + base + '/') + entry.name);
    if (isIgnored(relative) || /(^|\/)__MACOSX(\/|$)/.test(relative)) { ignored++; continue; }
    if (entry.size > MAX_SINGLE) throw Error(`File in ZIP is too large for GitHub: ${relative}`);
    if (job.bytes + expanded + entry.size > MAX_TOTAL) throw Error('Project exceeds the 2 GB local staging limit.');
    const dest = destination(job.stage, relative);
    const actual = await extractEntry(zipFile, entry, dest, MAX_SINGLE);
    expanded += actual; extracted++;
  }
  job.files += extracted;
  job.bytes += expanded;
  if (ignored) job.skipped.push(`${ignored} ignored file(s) inside ${archiveName}`);
  return { archive: true, extracted, ignored };
}
async function stageFile(req, job, relative) {
  if (job.state !== 'collecting') throw Error('This upload is no longer accepting files.');
  const rel = cleanPath(relative);
  if (isIgnored(rel)) { req.resume(); job.skipped.push(rel); return { skipped: true }; }
  const contentLength = Number(req.headers['content-length'] || 0);
  const isZip = job.options.extractZip && rel.toLowerCase().endsWith('.zip');
  const maxTransfer = isZip ? MAX_ZIP : MAX_SINGLE;
  if (contentLength > maxTransfer) throw Error(`File exceeds the upload limit: ${rel}`);
  if (job.bytes + contentLength > MAX_TOTAL) throw Error('Project exceeds the 2 GB limit.');
  if (job.files >= MAX_ITEMS) throw Error('Project contains too many files.');
  const stagingFile = destination(job.stage, rel);
  await fsp.mkdir(path.dirname(stagingFile), { recursive: true });
  let transferred = 0;
  const { Transform } = require('node:stream');
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      transferred += chunk.length;
      if (transferred > maxTransfer || job.bytes + transferred > MAX_TOTAL) cb(Error('File or project too large.'));
      else cb(null, chunk);
    }
  });
  try { await pipeline(req, limiter, fs.createWriteStream(stagingFile, { flags: 'w' })); }
  catch (e) { await fsp.rm(stagingFile, { force: true }); throw e; }
  if (isZip) {
    try { return await stageArchive(stagingFile, job, rel); }
    finally { await fsp.rm(stagingFile, { force: true }); }
  }
  job.bytes += transferred; job.files++;
  return { file: rel, bytes: transferred };
}
async function collectFiles(root, base = '') {
  const result = [];
  async function walk(dir, prefix) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const r = prefix ? prefix + '/' + e.name : e.name;
      if (isIgnored(r) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) result.push(r);
    }
  }
  await walk(root, base);
  return result;
}
async function secretCheck(stage, paths) {
  const alerts = [];
  for (const relative of paths) {
    if (isIgnored(relative)) continue;
    const p = destination(stage, relative);
    const handle = await fsp.open(p, 'r');
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
      await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.includes(0)) continue;
      const text = buffer.toString('utf8');
      if (SECRET_PATTERNS.some(re => re.test(text))) alerts.push(relative);
    } finally { await handle.close(); }
    if (alerts.length >= 10) break;
  }
  return alerts;
}
async function rejectSymlinkTargets(root, relative) {
  let current = root;
  for (const segment of cleanPath(relative).split('/')) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw Error('Refusing to replace a symbolic link in the existing repository: ' + relative);
  }
}
async function copyToRepo(stage, repoRoot, paths, rootStrip, subfolder) {
  for (const original of paths) {
    let rel = original;
    if (rootStrip && rel.startsWith(rootStrip + '/')) rel = rel.slice(rootStrip.length + 1);
    if (subfolder) rel = subfolder + '/' + rel;
    const target = destination(repoRoot, rel);
    if (path.relative(repoRoot, target).split(path.sep).includes('.git')) throw Error('Cannot overwrite Git internals.');
    await rejectSymlinkTargets(repoRoot, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(destination(stage, original), target);
  }
}
async function publish(job) {
  job.state = 'publishing';
  const { options } = job;
  try {
    log(job, 'Checking connection', 'Checking GitHub login and Git installation…');
    const status = await prereqs();
    if (!status.git || !status.gh) throw Error('Install both Git and GitHub CLI first, then restart GitDock.');
    if (!status.connected) throw Error('Sign in to GitHub first using the Connect GitHub button.');
    log(job, 'Reviewing files', 'Checking file paths and potential secrets…');
    const paths = await collectFiles(job.stage);
    if (!paths.length) throw Error('There are no project files to publish.');
    const danger = await secretCheck(job.stage, paths);
    if (danger.length) throw Error('Potential secret/API key detected. Remove these files or credentials before publishing: ' + danger.join(', '));
    const firstParts = new Set(paths.map(p => p.split('/')[0]));
    const rootStrip = options.stripRoot && firstParts.size === 1 && paths.every(p => p.includes('/')) ? [...firstParts][0] : '';
    const targetRepo = validateRepo(options.repo, options.mode === 'existing');
    const user = status.user || JSON.parse((await cmd('gh', ['api', 'user', '--jq', '{login: .login, id: .id, name: .name}'])).stdout);
    let fullRepo = targetRepo;
    await cmd('gh', ['auth', 'setup-git', '--hostname', 'github.com']);
    if (options.mode === 'new') {
      log(job, 'Creating repository', `Creating ${options.visibility} repository ${targetRepo}…`);
      const args = ['repo', 'create', targetRepo, options.visibility === 'public' ? '--public' : '--private'];
      if (options.description) args.push('--description', options.description);
      await cmd('gh', args, { timeout: 90000 });
      fullRepo = user.login + '/' + targetRepo;
      job.result = { url: 'https://github.com/' + fullRepo, repo: fullRepo, created: true };
    }
    const localRepo = path.join(job.temp, 'checkout');
    log(job, 'Getting repository', options.mode === 'existing' ? 'Safely downloading the existing repository…' : 'Preparing the new repository…');
    await cmd('gh', ['repo', 'clone', fullRepo, localRepo, '--', '--depth', '1'], { timeout: 240000 });
    const head = await cmd('git', ['-C', localRepo, 'rev-parse', '--verify', 'HEAD'], { acceptCode: [128] });
    if (head.code !== 0) await cmd('git', ['-C', localRepo, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    log(job, 'Adding files', `Copying ${paths.length.toLocaleString()} project files…`);
    await copyToRepo(job.stage, localRepo, paths, rootStrip, options.subfolder);
    await cmd('git', ['-C', localRepo, 'add', '--all', '--', '.'], { timeout: 240000 });
    const changed = await cmd('git', ['-C', localRepo, 'diff', '--cached', '--quiet'], { acceptCode: [1] });
    const url = 'https://github.com/' + fullRepo;
    if (changed.code === 0) {
      job.state = 'done'; job.result = { url, repo: fullRepo, changed: false, created: options.mode === 'new' };
      log(job, 'Published', 'Everything is already up to date. No new commit needed.'); return;
    }
    log(job, 'Committing changes', 'Creating your commit…');
    const commitName = (user.name || user.login).slice(0, 120);
    const commitEmail = `${user.id}+${user.login}@users.noreply.github.com`;
    await cmd('git', ['-C', localRepo, '-c', `user.name=${commitName}`, '-c', `user.email=${commitEmail}`, 'commit', '-m', options.message || 'Upload project via Commodious GitDock'], { timeout: 120000 });
    log(job, 'Pushing to GitHub', 'Sending your files to GitHub…');
    await cmd('git', ['-C', localRepo, 'push', 'origin', 'HEAD'], { timeout: 300000 });
    job.state = 'done';
    job.result = { url, repo: fullRepo, changed: true, created: options.mode === 'new' };
    log(job, 'Published', 'Success! Your project is now on GitHub.');
  } catch (e) {
    job.state = 'error'; job.error = e.message || String(e);
    log(job, 'Needs attention', job.error);
  }
}
async function requestHandler(req, res) {
  try {
    const host = req.headers.host || '';
    if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) return json(res, 403, { error: 'Local access only.' });
    const url = new URL(req.url, `http://${host}`);
    if (req.method !== 'GET' && (req.headers['x-gitdock-token'] !== TOKEN || (req.headers.origin && req.headers.origin !== `http://${host}`))) return json(res, 403, { error: 'Invalid local session.' });
    if (url.pathname.startsWith('/api/links') || url.pathname === '/api/choose-folder') {
      if (linksReady) await linksReady;
      if (url.pathname === '/api/choose-folder' && req.method === 'POST') {
        if (process.platform !== 'win32') return json(res, 409, { error: 'Use the folder path field on this system.' });
        const ps = [
          '$ErrorActionPreference="Stop"',
          '$shell = New-Object -ComObject Shell.Application',
          '$folder = $shell.BrowseForFolder(0,"Select the local project folder to sync",0,0)',
          'if ($folder) { [Console]::Out.Write($folder.Self.Path) }'
        ].join('; ');
        const picked = await cmd('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 120000 });
        return json(res, 200, { root: picked.stdout });
      }
      if (url.pathname === '/api/links' && req.method === 'GET') return json(res, 200, { projects: LINKS.list() });
      if (url.pathname === '/api/links' && req.method === 'POST') {
        const body = await readJson(req);
        return json(res, 201, { project: await LINKS.create(body) });
      }
      const linkMatch = url.pathname.match(/^\/api\/links\/([0-9a-f-]{36})(?:\/(settings|refresh|sync|diff))?$/);
      if (linkMatch) {
        const [, id, action] = linkMatch;
        if (req.method === 'GET' && !action) return json(res, 200, { project: LINKS.status(LINKS.get(id)) });
        if (req.method === 'DELETE' && !action) return json(res, 200, await LINKS.remove(id));
        if (req.method === 'POST' && action === 'settings') return json(res, 200, { project: await LINKS.settings(id, await readJson(req)) });
        if (req.method === 'POST' && action === 'refresh') return json(res, 200, { project: await LINKS.refresh(id, { remote: true }) });
        if (req.method === 'POST' && action === 'sync') return json(res, 200, { project: await LINKS.sync(id) });
        if (req.method === 'GET' && action === 'diff') return json(res, 200, await LINKS.diff(id, url.searchParams.get('path') || ''));
      }
    }
    if (url.pathname === '/api/version' && req.method === 'GET') return json(res, 200, { version: '1.2.0' });
    if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, await prereqs());
    if (url.pathname === '/api/repos' && req.method === 'GET') {
      const data = await cmd('gh', ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,isPrivate,url'], { timeout: 30000 });
      return json(res, 200, { repos: JSON.parse(data.stdout || '[]') });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const status = await prereqs();
      if (!status.gh) return json(res, 409, { error: 'GitHub CLI is not installed.' });
      startLogin(); return json(res, 200, { started: true });
    }
    if (url.pathname === '/api/jobs' && req.method === 'POST') {
      const body = await readJson(req);
      const mode = body.mode === 'existing' ? 'existing' : 'new';
      const repo = validateRepo(String(body.repo || ''), mode === 'existing');
      const subfolder = body.subfolder ? cleanPath(String(body.subfolder)) : '';
      const temp = await fsp.mkdtemp(path.join(SESSION_TEMP, 'job-'));
      const stage = path.join(temp, 'files'); await fsp.mkdir(stage);
      const id = crypto.randomUUID();
      const job = { id, temp, stage, files: 0, bytes: 0, state: 'collecting', step: 'Waiting for files', skipped: [], messages: [], created: Date.now(), options: {
        mode, repo, subfolder, visibility: body.visibility === 'public' ? 'public' : 'private',
        description: String(body.description || '').slice(0, 300), message: String(body.message || '').slice(0, 300),
        extractZip: body.extractZip !== false, stripRoot: body.stripRoot !== false
      }};
      JOBS.set(id, job); return json(res, 201, { id });
    }
    const match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)(?:\/(file|publish))?$/);
    if (match) {
      const job = JOBS.get(match[1]);
      if (!job) return json(res, 404, { error: 'Upload session not found.' });
      if (req.method === 'GET' && !match[2]) return json(res, 200, summary(job));
      if (req.method === 'POST' && match[2] === 'file') {
        const result = await stageFile(req, job, url.searchParams.get('path'));
        return json(res, 200, result);
      }
      if (req.method === 'POST' && match[2] === 'publish') {
        if (job.state !== 'collecting') return json(res, 409, { error: 'Already publishing.' });
        if (!job.files) return json(res, 400, { error: 'Add project files first.' });
        void publish(job);
        return json(res, 202, summary(job));
      }
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    if (url.pathname === '/app-config.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('window.__GITDOCK_TOKEN=' + JSON.stringify(TOKEN) + ';');
    }
    const names = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js', '/links.js': 'links.js', '/favicon.svg': 'favicon.svg' };
    const name = names[url.pathname]; if (!name) return json(res, 404, { error: 'Not found.' });
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' };
    const data = await fsp.readFile(path.join(PUBLIC, name));
    res.writeHead(200, { 'Content-Type': types[path.extname(name)] + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(data);
  } catch (e) {
    const status = /Unsafe|Invalid|limit|too large|name|secret|missing|contains|file path|folder|too many|exceeds|no longer/i.test(e.message) ? 400 : 500;
    json(res, status, { error: e.message || 'Unexpected error.' });
  }
}
function openBrowser(address) {
  const [exe, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', address]] : process.platform === 'darwin' ? ['open', [address]] : ['xdg-open', [address]];
  const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => console.log('Open this URL in your browser:', address)); p.unref();
}
function start() {
  if (!linksReady) linksReady = LINKS.init().catch(e => { console.error('[GitDock] Linked Projects startup failed:', e.message); throw e; });
  const server = http.createServer((req, res) => { void requestHandler(req, res); });
  server.listen(PORT, HOST, () => {
    const address = `http://${HOST}:${server.address().port}`;
    console.log('\n  COMM O D I O U S   G I T D O C K');
    console.log('  Local project publisher:', address);
    console.log('  Close this terminal window to stop the app.\n');
    if (process.env.GITDOCK_NO_BROWSER !== '1') openBrowser(address);
  });
  setInterval(async () => {
    for (const [id, job] of JOBS) {
      if (!['done', 'error'].includes(job.state) || Date.now() - job.created < 4 * 3600 * 1000) continue;
      JOBS.delete(id); await fsp.rm(job.temp, { recursive: true, force: true }).catch(() => {});
    }
  }, 600000).unref();
  server.on('close', () => LINKS.stop());
  return server;
}
if (require.main === module) start();
module.exports = { start, cleanPath, isIgnored, destination, validateRepo, secretCheck, copyToRepo, stageArchive, collectFiles };
