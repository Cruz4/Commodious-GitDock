'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { LinkedProjects, snapshot, changes, treeFromBuffer, validateRepoName, validateBranch, isExcluded } = require('../linked-projects');

async function tmp(fn) { const dir = await fsp.mkdtemp(path.join(os.tmpdir(),'gitdock-links-')); try { return await fn(dir); } finally { await fsp.rm(dir,{recursive:true,force:true}); } }
function git(...args) { return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }
async function fixture(dir) {
  const bare=path.join(dir,'remote.git'), repo=path.join(dir,'initial'), local=path.join(dir,'cursor-project');
  git('init','--bare','-q','--initial-branch=main',bare);
  git('clone','-q',bare,repo);
  git('-C',repo,'config','user.name','Test User');git('-C',repo,'config','user.email','test@example.com');
  await fsp.mkdir(path.join(repo,'src'),{recursive:true});
  await fsp.writeFile(path.join(repo,'src','app.js'),'remote version');
  await fsp.writeFile(path.join(repo,'keep.txt'),'must stay');
  git('-C',repo,'add','-A');git('-C',repo,'commit','-qm','initial');git('-C',repo,'push','-q','origin','main');
  await fsp.mkdir(path.join(local,'src'),{recursive:true});
  await fsp.writeFile(path.join(local,'src','app.js'),'local version');
  await fsp.writeFile(path.join(local,'new.txt'),'new local file');
  await fsp.writeFile(path.join(local,'.env'),'PRIVATE_TOKEN=never commit');
  const manager = new LinkedProjects({ dir:path.join(dir,'config'), checkAuth:async()=>true,
    exec:async(binary,args,opts)=>{
      if(binary==='gh' && args[0]==='auth') return {text:'',stdout:Buffer.from(''),code:0};
      if(binary==='gh' && args[0]==='api' && args[1]==='user') return {text:JSON.stringify({name:'Test User',id:99,login:'testuser'}),stdout:Buffer.from(''),code:0};
      return require('../linked-projects-test-utils').run(binary,args,opts);
    },
    clone:async(_repo,branch,target)=>{ await require('../linked-projects-test-utils').run('git',['clone','--branch',branch,bare,target]); },
    secretCheck:async(folder,files)=>{const {secretCheck}=require('../server');return secretCheck(folder,files);}
  });
  await manager.init();
  return {bare,repo,local,manager};
}

test('repo and branch validation and excluded file rules',()=>{
  assert.equal(validateRepoName('owner/repo'), 'owner/repo');
  assert.throws(()=>validateRepoName('https://github.com/u/r'));
  assert.equal(validateBranch('feature/smart-sync'),'feature/smart-sync');
  for(const branch of ['a..b','refs/heads/..','-oops','a b','a.lock','a//b']) assert.throws(()=>validateBranch(branch),undefined,branch);
  assert.equal(isExcluded('src/app.js'),false);
  assert.equal(isExcluded('node_modules/foo.js'),true);
  assert.equal(isExcluded('config/.env.production'),true);
});

test('snapshot detects edits, skips secrets, and remote tree parses with paths',async()=>tmp(async dir=>{
  await fsp.writeFile(path.join(dir,'code.js'),'abc');await fsp.writeFile(path.join(dir,'.env'),'no');
  const first=await snapshot(dir);
  assert.deepEqual([...first.files.keys()],['code.js']);
  assert.equal(first.files.get('code.js').sha,'f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f'); // Git blob of abc
  const second=await snapshot(dir,first.files);
  assert.equal(second.files.get('code.js').sha,first.files.get('code.js').sha);
  await fsp.writeFile(path.join(dir,'code.js'),'abcd');
  const third=await snapshot(dir,second.files);
  assert.notEqual(third.files.get('code.js').sha,first.files.get('code.js').sha);
  const remote=treeFromBuffer(Buffer.from('100644 blob '+first.files.get('code.js').sha+'\tcode.js\0'));
  assert.deepEqual(changes(third.files,remote),[{path:'code.js',type:'modified',bytes:4}]);
}));

test('linked project previews, syncs, persists settings, and preserves unrelated GitHub files',async()=>tmp(async dir=>{
  const {bare,local,manager}=await fixture(dir);
  try {
    const linked=await manager.create({root:local,repo:'testowner/testrepo',branch:'main'});
    assert.equal(linked.mode,'review');assert.equal(linked.counts.added,1);assert.equal(linked.counts.modified,1);
    assert.equal(linked.counts.deleted,0);
    const patch = await manager.diff(linked.id, 'src/app.js');
    assert.match(patch.diff, /-remote version/);
    assert.match(patch.diff, /\+local version/);
    const result=await manager.sync(linked.id);
    assert.equal(result.counts.added,0);assert.equal(result.counts.modified,0);
    assert.ok(result.lastSync);assert.equal(result.mode,'review');
    assert.equal(git('--git-dir',bare,'show','main:keep.txt'),'must stay');
    assert.equal(git('--git-dir',bare,'show','main:new.txt'),'new local file');
    assert.equal(git('--git-dir',bare,'show','main:src/app.js'),'local version');
    assert.throws(()=>git('--git-dir',bare,'show','main:.env'));
    assert.equal(fs.existsSync(path.join(local,'.git')),false);
    await manager.settings(linked.id,{mode:'off',deletions:true});
    assert.equal(manager.status(manager.get(linked.id)).mode,'off');
    assert.equal(manager.list()[0].deletions,true);
    await fsp.rm(path.join(local,'new.txt'));
    let status=await manager.refresh(linked.id);
    assert.equal(status.counts.deleted,1);
    await manager.sync(linked.id);
    assert.throws(()=>git('--git-dir',bare,'show','main:new.txt'));
    assert.equal(git('--git-dir',bare,'show','main:keep.txt'),'must stay');
    // Restarted app loads link and mode from disk.
    manager.stop();
    const other = new LinkedProjects({dir:path.join(dir,'config')});await other.init();
    assert.equal(other.list().length,1);assert.equal(other.list()[0].mode,'off');assert.equal(other.list()[0].deletions,true);
    await other.remove(linked.id);assert.equal(other.list().length,0);other.stop();
  } finally { manager.stop(); }
}));

test('remote changed since preview: sync pauses instead of overwriting',async()=>tmp(async dir=>{
  const {bare,repo,local,manager}=await fixture(dir);
  try {
    const linked=await manager.create({root:local,repo:'owner/branch',branch:'main'});
    await fsp.writeFile(path.join(repo,'src','app.js'),'someone updated GitHub');
    git('-C',repo,'add','-A');git('-C',repo,'commit','-qm','remote edit');git('-C',repo,'push','-q','origin','main');
    await assert.rejects(()=>manager.sync(linked.id),/GitHub has new commits/);
    assert.equal(manager.list()[0].paused,true);
    assert.equal(git('--git-dir',bare,'show','main:src/app.js'),'someone updated GitHub');
    // After review, explicit second click may overwrite the remote edit.
    await manager.sync(linked.id);
    assert.equal(git('--git-dir',bare,'show','main:src/app.js'),'local version');
  } finally {manager.stop();}
}));

test('auto-sync on save is opt-in, and can be switched off',async()=>tmp(async dir=>{
  const {bare,local,manager}=await fixture(dir);
  try {
    const linked=await manager.create({root:local,repo:'owner/autosync',branch:'main'});
    await manager.sync(linked.id);
    assert.equal(linked.mode,'review');
    await fsp.writeFile(path.join(local,'src','app.js'),'saved in Cursor');
    await manager.refresh(linked.id);
    assert.equal(git('--git-dir',bare,'show','main:src/app.js'),'local version');
    await manager.settings(linked.id,{mode:'auto'});
    await new Promise(r=>setTimeout(r,5900));
    assert.equal(git('--git-dir',bare,'show','main:src/app.js'),'saved in Cursor');
    await manager.settings(linked.id,{mode:'off'});
    await fsp.writeFile(path.join(local,'src','app.js'),'not auto pushed');
    await new Promise(r=>setTimeout(r,1100));
    assert.equal(git('--git-dir',bare,'show','main:src/app.js'),'saved in Cursor');
  } finally {manager.stop();}
}));


test('new empty GitHub repository can be linked and receive its first commit', async()=>tmp(async dir=>{
  const bare=path.join(dir,'blank.git'),local=path.join(dir,'project');
  git('init','--bare','-q','--initial-branch=main',bare);
  await fsp.mkdir(local); await fsp.writeFile(path.join(local,'index.js'),'console.log("first commit")');
  const helper = require('../linked-projects-test-utils').run;
  const manager = new LinkedProjects({dir:path.join(dir,'config'),checkAuth:async()=>true,
    exec:async(bin,args,opts)=>{
      if (bin==='gh') {
        if(args[0]==='auth') return {text:'',code:0};
        if(args[0]==='repo' && args[1]==='clone') return helper('git', ['clone', ...(args.includes('--branch') ? ['--branch', 'main'] : []), bare, args[3]], opts);
        if(args[0]==='repo' && args[1]==='view') return {text:'true'};
        if(args[0]==='api') return {text:'{"name":"Test User","login":"testuser","id":1}'};
        throw Error('Unknown gh test command');
      }
      return helper(bin,args,opts);
    },
  });
  await manager.init();
  try {
    const linked=await manager.create({root:local,repo:'testowner/empty',branch:'main'});
    assert.equal(linked.counts.added,1);
    await manager.sync(linked.id);
    assert.equal(git('--git-dir',bare,'show','main:index.js'),'console.log("first commit")');
  } finally {manager.stop();}
}));
