'use strict';
/* Commodious GitDock · Created by Jordie Cruz · Commodious Works LLC */
(() => {
  const $ = id => document.getElementById(id);
  const state = { files: new Map(), ignored: 0, busy: false, mode: 'new', status: null, loginLaunched: false, attemptedRepoFetch: false, jobId: null };
  const el = {
    dropzone: $('dropzone'), folderPicker: $('folderPicker'), filePicker: $('filePicker'),
    filePanel: $('filePanel'), fileList: $('fileList'), publishBtn: $('publishBtn'),
    progressPanel: $('progressPanel'), progressFill: $('progressFill'), progressLog: $('progressLog'),
    progressHeading: $('progressHeading'), progressDetail: $('progressDetail'), progressPercent: $('progressPercent')
  };
  const MAX_ITEMS = 10000, MAX_FILE = 99 * 1024 * 1024, MAX_ZIP = 1024 * 1024 * 1024;
  const ignoredDirs = new Set(['.git', 'node_modules', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.turbo', '.cache', 'coverage', 'dist', 'build', 'target', '.idea', '.terraform']);
  const ignoredFiles = [/^\.env(?:\..*)?$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.netrc$/i, /^id_(rsa|ed25519|ecdsa)(?:\.pub)?$/i, /^(?:credentials|service[-_]?account)(?:[-_.].*)?\.json$/i, /\.(?:p12|pfx|key)$/i, /^\.DS_Store$/];
  const fileIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>';
  function bytes(value) { if (!value) return '0 B'; const u=['B','KB','MB','GB'], i=Math.min(Math.floor(Math.log(value)/Math.log(1024)),3); return `${(value / 1024**i).toFixed(i===0?0:1)} ${u[i]}`; }
  function toast(message) { const t=$('toast'); t.textContent=message; t.classList.remove('hidden'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>t.classList.add('hidden'),5200); }
  function safePath(p) { return String(p).replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+/,'').split('/').filter(Boolean).join('/'); }
  function shouldIgnore(p) { const s=p.toLowerCase().split('/'); return s.some(seg=>ignoredDirs.has(seg)) || s.some(seg=>ignoredFiles.some(re=>re.test(seg))); }
  function projectName(p) { const seg=p.split('/'); const n=seg.length>1?seg[0]:seg[0].replace(/\.zip$/i,''); return n.replace(/[^a-z0-9_.-]/gi,'-').replace(/^-+|-+$/g,'').toLowerCase() || 'my-project'; }
  function esc(s) { return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function validFile(f,p) {
    if (!f || !(f instanceof File) || !p || p.split('/').some(s=>s==='..'||s==='.') || p.includes('\0')) return false;
    if (shouldIgnore(p)) { state.ignored++; return false; }
    const limit = p.toLowerCase().endsWith('.zip') && $('extractZip').checked ? MAX_ZIP : MAX_FILE;
    if (f.size > limit) { state.ignored++; toast(`Too large to include: ${p}. Regular GitHub files must be under 100 MB.`); return false; }
    return true;
  }
  function addFiles(items) {
    let added=0;
    for (const {file,path:relative} of items) {
      const p=safePath(relative||file.name);
      if (!validFile(file,p)) continue;
      if (state.files.size >= MAX_ITEMS) { toast('This upload is limited to 10,000 files.'); break; }
      state.files.set(p,file); added++;
    }
    if (added && !$('repoName').value.trim()) {
      const paths=[...state.files.keys()], roots=[...new Set(paths.map(p=>p.split('/')[0]))];
      $('repoName').value=roots.length===1?projectName(paths[0]):'my-project';
    }
    renderFiles();
    if (added) toast(`${added.toLocaleString()} file${added!==1?'s':''} added to your project.`);
    else if (!state.ignored) toast('No files found. Try selecting a folder or individual files.');
  }
  async function entryFile(entry) { return await new Promise((resolve,reject)=>entry.file(resolve,reject)); }
  async function readEntries(reader) {
    const entries=[];
    while (true) {
      const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
      if (!batch.length) break;
      entries.push(...batch);
      if (entries.length>MAX_ITEMS*2) throw Error('Too many files in this folder.');
    }
    return entries;
  }
  async function walkEntry(entry, prefix, out) {
    if (out.length>MAX_ITEMS) throw Error('Too many files in this upload.');
    if (entry.isFile) {
      const file=await entryFile(entry);
      out.push({file,path:prefix+file.name});
    } else if (entry.isDirectory) {
      const pre=prefix+entry.name+'/';
      if (shouldIgnore(pre+'placeholder.txt')) {state.ignored++;return;}
      for (const child of await readEntries(entry.createReader())) await walkEntry(child,pre,out);
    }
  }
  async function handleDrop(e) {
    e.preventDefault(); el.dropzone.classList.remove('dragging');
    if (state.busy) return;
    const dt=e.dataTransfer, out=[];
    try {
      if (dt.items?.length && [...dt.items].some(i=>i.webkitGetAsEntry?.())) {
        for (const item of dt.items) {
          const entry=item.webkitGetAsEntry?.(); if (entry) await walkEntry(entry,'',out);
        }
      } else for (const f of [...dt.files]) out.push({file:f,path:f.webkitRelativePath||f.name});
      addFiles(out);
    } catch (err) { toast(`Couldn't read one of the folders: ${err.message}`); }
  }
  function renderFiles() {
    const paths=[...state.files.keys()], n=paths.length;
    el.filePanel.classList.toggle('hidden',!n);
    $('clearBtn').classList.toggle('hidden',!n);
    $('countBadge').textContent=n.toLocaleString();
    $('fileTotal').textContent=`${n.toLocaleString()} file${n===1?'':'s'}`;
    $('sizeTotal').textContent=bytes([...state.files.values()].reduce((a,f)=>a+f.size,0));
    const roots=new Set(paths.filter(p=>p.includes('/')).map(p=>p.split('/')[0]));
    $('rootTotal').textContent=`${roots.size} project folder${roots.size===1?'':'s'}`;
    el.fileList.innerHTML=paths.slice(0,11).map(p=>`<div class="file-item">${fileIcon}<span class="file-item-name" title="${esc(p)}">${esc(p)}</span><span class="file-item-size">${bytes(state.files.get(p).size)}</span></div>`).join('');
    $('fileOverflow').classList.toggle('hidden',n<=11);
    $('fileOverflow').textContent=n>11?`+ ${(n-11).toLocaleString()} more files ready`:'';
    $('fileNotice').classList.toggle('hidden',!state.ignored);
    $('fileNotice').textContent=state.ignored?`${state.ignored} file(s) omitted for safety (ignored folders, secret files, or size limits).`:'';
    refreshPublish();
  }
  function refreshPublish() {
    const ready=state.files.size>0 && !state.busy;
    el.publishBtn.disabled=!ready;
    const git=state.status?.git, gh=state.status?.gh, connected=state.status?.connected;
    $('publishHint').textContent=state.busy?'Publishing your files…':!state.files.size?'Add a project to get started':!git||!gh?'Install Git and GitHub CLI to publish':!connected?'GitHub login required to publish':'Your files are ready. GitDock handles the rest.';
  }
  function setMode(mode) {
    state.mode=mode;
    $('newMode').classList.toggle('active',mode==='new'); $('existingMode').classList.toggle('active',mode==='existing');
    $('newFields').classList.toggle('hidden',mode!=='new'); $('existingFields').classList.toggle('hidden',mode!=='existing');
    if (mode==='existing' && !state.attemptedRepoFetch) void loadRepos();
  }
  async function api(endpoint, method='GET', data=null) {
    const headers={'X-GitDock-Token':window.__GITDOCK_TOKEN};
    if (data!==null) headers['Content-Type']='application/json';
    let response;
    try { response=await fetch(endpoint,{method,headers,body:data===null?undefined:JSON.stringify(data)}); }
    catch { throw Error('GitDock could not reach its local server. Is the app window still open?'); }
    const parsed=await response.json().catch(()=>({}));
    if (!response.ok) throw Error(parsed.error||`Request failed (${response.status}).`);
    return parsed;
  }
  async function checkStatus() {
    try {
      const status=await api('/api/status'); state.status=status;
      const btn=$('accountBtn'), label=$('accountLabel');
      label.textContent=status.connected?(status.user?.login?`@${status.user.login}`:'GitHub connected'):!status.git?'Install Git':'Connect GitHub';
      btn.title=status.connected?'GitHub connected. Click to refresh login.':!status.gh?'Install GitHub CLI to continue.':'Click to open GitHub sign-in.';
      if (status.connected) { btn.style.borderColor='#386d68'; state.loginLaunched=false; }
      else btn.style.borderColor='';
      if (status.connected && state.mode==='existing' && !state.attemptedRepoFetch) void loadRepos();
      refreshPublish();
    } catch (e) { $('accountLabel').textContent='Local server unavailable'; refreshPublish(); }
  }
  async function login() {
    if (state.status?.connected) {await checkStatus();toast('You are already signed in to GitHub.');return;}
    if (!state.status?.git) { toast('Install Git for Windows first, then restart this app.'); window.open('https://git-scm.com/downloads/win','_blank','noopener');return; }
    if (!state.status?.gh) { toast('Install GitHub CLI first, then restart this app.'); window.open('https://cli.github.com/','_blank','noopener');return; }
    try {
      await api('/api/login','POST'); state.loginLaunched=true;
      toast('A GitHub sign-in window opened. Complete the browser login, then return here.');
      $('accountLabel').textContent='Waiting for sign-in…';
    } catch(e) {toast(e.message);}
  }
  async function loadRepos() {
    if (!state.status?.connected) { $('repoSelect').innerHTML='<option value="">Sign in to GitHub first</option>';return; }
    state.attemptedRepoFetch=true;
    $('repoSelect').innerHTML='<option value="">Loading your repositories…</option>';
    try {
      const {repos}=await api('/api/repos');
      $('repoSelect').replaceChildren(new Option('Choose a repository…',''),...repos.map(r=>new Option(`${r.nameWithOwner} · ${r.isPrivate?'private':'public'}`,r.nameWithOwner)));
      if (!repos.length) toast('No repositories found yet. Create your first one instead.');
    } catch(e) { $('repoSelect').replaceChildren(new Option('Could not load repositories','')); toast(e.message); }
  }
  function setProgress(pct,title,detail) {
    el.progressPanel.classList.remove('hidden');
    el.progressFill.style.width=`${Math.max(0,Math.min(pct,100)).toFixed(1)}%`;
    el.progressPercent.textContent=`${Math.round(pct)}%`;
    if(title) el.progressHeading.textContent=title;
    if(detail) el.progressDetail.textContent=detail;
  }
  function addLog(message) { const div=document.createElement('div');div.textContent=message;el.progressLog.append(div);el.progressLog.scrollTop=el.progressLog.scrollHeight; }
  function uploadFile(id, relative, file, cb) {
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open('POST',`/api/jobs/${encodeURIComponent(id)}/file?path=${encodeURIComponent(relative)}`);
      xhr.setRequestHeader('X-GitDock-Token',window.__GITDOCK_TOKEN);
      xhr.setRequestHeader('Content-Type','application/octet-stream');
      xhr.upload.onprogress=e=>{if(e.lengthComputable)cb(e.loaded);};
      xhr.onerror=()=>reject(Error(`Could not send ${relative}. Check the local server.`));
      xhr.onload=()=>{
        let response;try {response=JSON.parse(xhr.responseText);}catch {response={};}
        if(xhr.status>=200&&xhr.status<300){cb(file.size);resolve(response);}
        else reject(Error(response.error||`Upload failed for ${relative}.`));
      };
      xhr.send(file);
    });
  }
  async function pollJob(id) {
    let lastLength=0;
    while(true) {
      const job=await api(`/api/jobs/${id}`);
      for (const m of job.messages.slice(lastLength)) addLog(m.message);
      lastLength=job.messages.length;
      const phases={ 'Checking connection':73,'Reviewing files':78,'Creating repository':83,'Getting repository':86,'Adding files':91,'Committing changes':95,'Pushing to GitHub':97,'Published':100 };
      if(job.state==='done') {
        setProgress(100,'Your project is on GitHub!','Everything is ready. Open your repository below.');
        if(job.result?.changed===false) el.progressDetail.textContent='No changes needed. Your repository is already up to date.';
        $('repoLink').href=job.result.url;
        $('successLinks').classList.remove('hidden');
        toast(`Published to ${job.result.repo}.`); return;
      }
      if(job.state==='error') {
        setProgress(100,'Upload needs attention',job.error||'Something went wrong.');
        el.progressFill.style.background='#e47787';
        if(job.result?.url) {
          $('repoLink').href=job.result.url;
          $('repoLink').textContent='Open repository (may be empty) ↗';
          $('successLinks').classList.remove('hidden');
        }
        throw Error(job.error||'Upload failed.');
      }
      setProgress(phases[job.step]||74,job.step+'…',job.messages.at(-1)?.message||'Working on your GitHub repository.');
      await new Promise(resolve=>setTimeout(resolve,950));
    }
  }
  async function publish() {
    if(state.busy||!state.files.size) return;
    if(!state.status?.git||!state.status?.gh) { toast('Install Git and GitHub CLI first, then restart GitDock.');return; }
    if(!state.status?.connected) {await login();return;}
    const repo=state.mode==='new'?$('repoName').value.trim():($('repoManual').value.trim() || $('repoSelect').value);
    if(!repo) {toast(state.mode==='new'?'Enter a name for your new GitHub repository.':'Choose a repository or enter owner/repository-name.');return;}
    const metadata={ mode:state.mode,repo,visibility:document.querySelector('input[name="visibility"]:checked').value,
      description:$('description').value.trim(),message:$('commitMessage').value.trim(),subfolder:$('subfolder').value.trim(),
      extractZip:$('extractZip').checked,stripRoot:$('stripRoot').checked };
    state.busy=true; refreshPublish();
    el.progressLog.replaceChildren();el.progressFill.style.background='';
    $('successLinks').classList.add('hidden');$('repoLink').textContent='Open GitHub repository ↗';
    setProgress(1,'Preparing your upload…','Organizing your files on your computer.');
    try {
      const {id}=await api('/api/jobs','POST',metadata);state.jobId=id;
      const files=[...state.files].map(([relative,file])=>({relative,file}));
      const total=files.reduce((a,v)=>a+Math.max(v.file.size,1),0);
      let done=0,index=0,staged=0;
      addLog(`Staging ${files.length.toLocaleString()} files locally…`);
      const workers=Array.from({length:Math.min(3,files.length)},async()=>{
        while(index<files.length){
          const current=files[index++]; let uploaded=0;
          await uploadFile(id,current.relative,current.file,size=>{
            const effective=Math.max(size,1);const delta=effective-uploaded;uploaded=effective;
            done+=delta;setProgress(5+65*done/total,'Uploading files locally…',`${bytes(done)} of ${bytes(total)} staged`);
          });
          staged++;
          if(staged===files.length||staged%Math.max(1,Math.floor(files.length/10))===0) addLog(`${staged.toLocaleString()} / ${files.length.toLocaleString()} staged`);
        }
      });
      await Promise.all(workers);
      setProgress(72,'Publishing to GitHub…','Creating or updating your repository.');
      await api(`/api/jobs/${id}/publish`,'POST');
      await pollJob(id);
    }catch(e){
      setProgress(100,'Upload needs attention',e.message);
      el.progressFill.style.background='#e47787';toast(e.message);
      addLog('Error: '+e.message);
    }finally{state.busy=false;refreshPublish();}
  }
  function reset() {
    state.files.clear();state.ignored=0;state.jobId=null;
    $('repoName').value='';$('repoManual').value='';$('description').value='';$('commitMessage').value='Upload project via Commodious GitDock';
    el.progressPanel.classList.add('hidden');$('successLinks').classList.add('hidden');
    renderFiles();window.scrollTo({top:0,behavior:'smooth'});
  }
  // Event bindings
  $('folderBtn').addEventListener('click',e=>{e.stopPropagation();el.folderPicker.click();});
  $('fileBtn').addEventListener('click',e=>{e.stopPropagation();el.filePicker.click();});
  $('addMoreBtn').addEventListener('click',()=>el.folderPicker.click());
  el.dropzone.addEventListener('click',e=>{if(e.target.closest('button'))return;el.folderPicker.click();});
  el.dropzone.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target===el.dropzone){e.preventDefault();el.folderPicker.click();}});
  for(const picker of [el.folderPicker,el.filePicker]) picker.addEventListener('change',e=>{
    addFiles([...e.target.files].map(file=>({file,path:file.webkitRelativePath||file.name})));picker.value='';
  });
  let dragCounter=0;
  el.dropzone.addEventListener('dragenter',e=>{e.preventDefault();dragCounter++;el.dropzone.classList.add('dragging');});
  el.dropzone.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';});
  el.dropzone.addEventListener('dragleave',e=>{e.preventDefault();if(--dragCounter<=0){dragCounter=0;el.dropzone.classList.remove('dragging');}});
  el.dropzone.addEventListener('drop',e=>{dragCounter=0;void handleDrop(e);});
  document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>{if(!el.dropzone.contains(e.target))e.preventDefault();});
  $('clearBtn').addEventListener('click',()=>{if(!state.busy){state.files.clear();state.ignored=0;renderFiles();}});
  $('newMode').addEventListener('click',()=>setMode('new'));
  $('existingMode').addEventListener('click',()=>setMode('existing'));
  $('accountBtn').addEventListener('click',()=>void login());
  $('refreshRepos').addEventListener('click',()=>void loadRepos());
  $('advancedToggle').addEventListener('click',()=>{$('advancedOptions').classList.toggle('hidden');$('advancedToggle').setAttribute('aria-expanded',String(!$('advancedOptions').classList.contains('hidden')));$('advancedChevron').textContent=$('advancedOptions').classList.contains('hidden')?'⌄':'⌃';});
  for(const radio of document.querySelectorAll('input[name="visibility"]')) radio.addEventListener('change',()=>{
    $('privateChoice').classList.toggle('selected',document.querySelector('input[name="visibility"]:checked').value==='private');
    $('publicChoice').classList.toggle('selected',document.querySelector('input[name="visibility"]:checked').value==='public');
  });
  $('publishBtn').addEventListener('click',()=>void publish());
  $('newUploadBtn').addEventListener('click',reset);
  renderFiles();void checkStatus();setInterval(()=>void checkStatus(),state.loginLaunched?2500:15000);
})();
