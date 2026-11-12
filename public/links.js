'use strict';
/* GitDock Smart Sync · Commodious Works LLC · Created by Jordie Cruz */
(() => {
  const $ = id => document.getElementById(id);
  const box = $('linkedProjects'), error = $('linksError');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let running = false, creating = false, lastJson = '', active = '';
  async function req(url, method = 'GET', body = undefined) {
    const res = await fetch(url, { method, headers: {
      'X-GitDock-Token': window.__GITDOCK_TOKEN,
      ...(body === undefined ? {} : {'Content-Type':'application/json'})
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(data.error || `Request failed (${res.status}).`);
    return data;
  }
  function fail(message) { error.textContent = message; error.classList.remove('hidden'); }
  function clearError() { error.classList.add('hidden'); error.textContent = ''; }
  function count(p) { return p.counts.added + p.counts.modified + p.counts.deleted; }
  function render(projects) {
    // Preserve focus while polling; update only when returned state changes.
    const json = JSON.stringify(projects);
    if (json === lastJson) return;
    lastJson = json;
    if (!projects.length) { box.innerHTML = '<div class="links-empty">No linked folders yet. Connect one above to get started.</div>'; return; }
    box.innerHTML = projects.map(p => {
      const n = count(p), last = p.lastSync ? new Date(p.lastSync).toLocaleString() : 'Never synced';
      const statuses = p.busy ? 'Syncing…' : p.error ? 'Needs attention' : p.mode === 'off' ? 'Monitoring off' : (p.mode === 'auto' && p.paused) ? 'Auto-Sync paused' : !p.connected ? 'Scanning…' : n ? `${n} change${n === 1?'':'s'} waiting` : 'Up to date';
      const css = p.error ? 'error' : p.busy ? 'working' : p.paused ? 'pending' : n ? 'pending' : 'success';
      const rows = p.changes.map(x => `<div class="link-change"><span class="link-change-type ${esc(x.type)}">${esc(x.type.replace('-', ' '))}</span><span title="${esc(x.path)}">${esc(x.path)}</span><button class="link-diff-btn" data-action="diff" data-path="${esc(x.path)}" type="button">View diff</button></div>`).join('');
      return `<article class="link-card" data-link-id="${esc(p.id)}">
        <div class="link-card-top"><div class="link-card-heading"><span class="link-folder-icon">▣</span><div><h3>${esc(p.root.replace(/[\\/]+$/,'').split(/[\\/]/).pop())}</h3><div class="link-location" title="${esc(p.root)}">${esc(p.root)}</div></div></div>
          <span class="link-indicator ${css}">${statuses}</span></div>
        <div class="link-target">↳ <a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">${esc(p.repo)}</a><span class="link-branch">⑂ ${esc(p.branch)}</span><span class="link-last">Last sync: ${esc(last)}</span></div>
        <div class="link-counts"><span>+ ${p.counts.added} added</span><span>~ ${p.counts.modified} modified</span><span>− ${p.counts.deleted} deleted</span>${p.counts.ignoredDeletions ? `<span>${p.counts.ignoredDeletions} deletions protected</span>` : ''}${p.skipped ? `<span>${p.skipped} excluded</span>` : ''}</div>
        ${p.error ? `<div class="link-message is-error">${esc(p.error)}</div>` : p.note ? `<div class="link-message">${esc(p.note)}</div>` : ''}
        <div class="link-controls"><label>SYNC MODE <select data-action="mode" aria-label="Sync mode for ${esc(p.repo)}"><option value="off" ${p.mode==='off'?'selected':''}>Off</option><option value="review" ${p.mode==='review'?'selected':''}>Review &amp; Sync</option><option value="auto" ${p.mode==='auto'?'selected':''}>Auto-Sync on save</option></select></label>
          <label class="links-delete"><input type="checkbox" data-action="deletions" ${p.deletions?'checked':''}> Sync local deletions</label>
          <button type="button" class="link-plain" data-action="refresh" ${p.busy?'disabled':''}>↻ Refresh</button>
          <button type="button" class="link-plain link-unlink" data-action="unlink" ${p.busy?'disabled':''}>Unlink</button>
          <button type="button" class="link-sync" data-action="sync" ${p.busy?'disabled':''}>${p.busy?'Syncing…':'Sync Now →'}</button></div>
        <details class="link-details" ${active===p.id?'open':''}><summary>See exactly what changed <strong>${n ? n + ' to sync' : '—'}</strong></summary>
          ${p.changes.length ? `<div class="link-changes">${rows}${p.more ? `<div class="link-more">…and ${p.more} more; ${n} changes in total.</div>` : ''}</div>` : '<div class="link-changes-empty">No changes to sync. Your project matches its GitHub branch for files GitDock manages.</div>'}
          <pre class="link-diff-output hidden" aria-label="Code changes"></pre>
        </details>
      </article>`;
    }).join('');
  }
  async function load() {
    if (running) return;
    running = true;
    try { const {projects} = await req('/api/links'); render(projects); }
    catch (e) { if (!lastJson) fail(e.message); }
    finally { running = false; }
  }
  async function act(p, action, target) {
    clearError();
    if (action === 'diff') {
      const output = target.closest('.link-details')?.querySelector('.link-diff-output');
      if (!output) return;
      output.classList.remove('hidden'); output.textContent = 'Loading file differences…';
      try { const data = await req(`/api/links/${encodeURIComponent(p)}/diff?path=${encodeURIComponent(target.dataset.path)}`); output.textContent = data.diff || data.message || 'No text changes.'; }
      catch (e) { output.textContent = e.message; }
      return;
    }
    if (action === 'unlink' && !confirm(`Unlink ${p}?\n\nYour local folder and GitHub files will NOT be deleted.`)) return;
    if (action === 'mode' && target.value === 'auto' && !confirm('Enable Auto-Sync?\n\nWhile GitDock is running, saving files in this folder (including saves from Cursor) will automatically commit and push eligible changes to GitHub after a short pause. Review your repository visibility and make sure no secrets are included.')) { lastJson = ''; await load(); return; }
    if (action === 'deletions' && target.checked && !confirm('Allow deleting previously synced GitHub files when you delete them locally?\n\nRemote-only files will still be protected.')) { lastJson = ''; await load(); return; }
    const url = `/api/links/${encodeURIComponent(p)}`;
    try {
      if (action === 'mode') await req(url + '/settings','POST',{ mode: target.value });
      if (action === 'deletions') await req(url + '/settings','POST',{ deletions: target.checked });
      if (action === 'sync') await req(url + '/sync','POST');
      if (action === 'refresh') await req(url + '/refresh','POST');
      if (action === 'unlink') await req(url,'DELETE');
      lastJson = ''; await load();
    } catch (e) { fail(e.message); lastJson = ''; await load(); }
  }
  box.addEventListener('click', e => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    const id = button.closest('[data-link-id]')?.dataset.linkId;
    if (id) void act(id, button.dataset.action, button);
  });
  box.addEventListener('change', e => {
    if (!e.target.matches('select[data-action],input[data-action]')) return;
    const id = e.target.closest('[data-link-id]')?.dataset.linkId;
    if (id) void act(id, e.target.dataset.action, e.target);
  });
  box.addEventListener('toggle', e => {
    if (e.target.matches('details.link-details')) active = e.target.open ? e.target.closest('[data-link-id]')?.dataset.linkId : '';
  }, true);
  $('linkBrowse').addEventListener('click', async () => {
    try {
      const {root} = await req('/api/choose-folder','POST');
      if (root) $('linkRoot').value = root;
    } catch(e) { fail(e.message + ' You can paste the full folder path instead.'); }
  });
  $('linkProjectBtn').addEventListener('click', async () => {
    if (creating) return;
    creating = true; clearError();
    const btn = $('linkProjectBtn'), old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Linking…';
    try {
      const root = $('linkRoot').value.trim(), repo = $('linkRepo').value.trim(), branch = $('linkBranch').value.trim();
      if (!root || !repo.includes('/')) throw Error('Select a local folder and an existing owner/repository first.');
      await req('/api/links','POST',{root,repo,branch});
      $('linkRoot').value = ''; $('linkRepo').value = ''; $('linkBranch').value = '';
      lastJson = ''; await load();
    } catch (e) { fail(e.message); }
    finally { creating = false; btn.disabled = false; btn.textContent = old; }
  });
  async function repos() {
    try {
      const {repos} = await req('/api/repos');
      $('linkRepos').replaceChildren(...repos.map(x => new Option(x.nameWithOwner,x.nameWithOwner)));
    } catch { /* user may not be signed in yet */ }
  }
  void load(); void repos();
  setInterval(() => { if (!document.hidden) {void load();} }, 3600);
  setInterval(() => { if (!document.hidden && !$('linkRepos').options.length) void repos(); }, 20000);
})();
