'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { cleanPath, isIgnored, destination, validateRepo, stageArchive, secretCheck, copyToRepo, start } = require('../server');
const { readZipEntries } = require('../zip');

const CRC_TABLE = Uint32Array.from({length:256}, (_,i) => {
  let n=i;
  for(let j=0;j<8;j++) n=(n&1)?(0xedb88320^(n>>>1)):(n>>>1);
  return n>>>0;
});
function crc32(b) {let n=0xffffffff;for(const x of b) n=CRC_TABLE[(n^x)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function makeZip(files) {
  const parts = [], central = [];
  let offset=0;
  for(const [filename, contents] of Object.entries(files)) {
    const name=Buffer.from(filename), body=Buffer.from(contents);
    const compressed=zlib.deflateRawSync(body);
    const crc=crc32(body);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);
    local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26);
    parts.push(local,name,compressed);
    const dir=Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50,0);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);
    dir.writeUInt16LE(0x800,8);dir.writeUInt16LE(8,10);dir.writeUInt32LE(crc,16);
    dir.writeUInt32LE(compressed.length,20);dir.writeUInt32LE(body.length,24);
    dir.writeUInt16LE(name.length,28);dir.writeUInt32LE(offset,42);
    central.push(dir,name);
    offset += local.length+name.length+compressed.length;
  }
  const centralBuf=Buffer.concat(central);
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(Object.keys(files).length,8);
  eocd.writeUInt16LE(Object.keys(files).length,10);
  eocd.writeUInt32LE(centralBuf.length,12);eocd.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,centralBuf,eocd]);
}
async function temp(fn) {const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'gitdock-test-'));try{return await fn(dir);}finally{await fsp.rm(dir,{force:true,recursive:true});}}

test('rejects traversal, invalid Windows names, and absolute paths', () => {
  assert.equal(cleanPath('project/src/index.js'),'project/src/index.js');
  for(const name of ['/etc/passwd','C:\\secret','../secret','.git/../secret','app//src','project/CON.txt','x/something:danger','x/trailing.'])
    assert.throws(()=>cleanPath(name),undefined,name);
  assert.throws(()=>destination('/tmp/target','../outside'));
});

test('ignores typical secrets and generated build folders', () => {
  for(const file of ['.env','app/.env.production','project/node_modules/x','project/.git/config','project/.npmrc','project/id_ed25519','project/dist/build.js'])
    assert.equal(isIgnored(file),true,file);
  assert.equal(isIgnored('project/src/index.js'),false);
});

test('validates new and existing repository names', () => {
  assert.equal(validateRepo('my-project',false),'my-project');
  assert.equal(validateRepo('myorg/my-project',true),'myorg/my-project');
  assert.throws(()=>validateRepo('--oops',false));
  assert.throws(()=>validateRepo('https://github.com/u/r',true));
});

test('ZIP extraction preserves paths, ignores .env and detects traversal', async () => temp(async dir => {
  const stage=path.join(dir,'stage');await fsp.mkdir(stage);
  const zip=path.join(dir,'project.zip');await fsp.writeFile(zip,makeZip({'example/src/index.js':'console.log("hello")', 'example/.env':'SHOULD_NOT_SHIP'}));
  const entries=await readZipEntries(zip);assert.equal(entries.length,2);
  const job={stage,files:0,bytes:0,skipped:[]};
  const result=await stageArchive(zip,job,'project.zip');
  assert.equal(result.extracted,1);assert.equal(result.ignored,1);
  assert.equal(await fsp.readFile(path.join(stage,'example/src/index.js'),'utf8'),'console.log("hello")');
  await assert.rejects(()=>fsp.stat(path.join(stage,'example/.env')));
  const bad=path.join(dir,'bad.zip');await fsp.writeFile(bad,makeZip({'../../escape.txt':'danger'}));
  await assert.rejects(()=>stageArchive(bad,job,'bad.zip'),/Unsafe/);
}));

test('ZIP CRC mismatch is detected, and corrupted extracted file is removed', async () => temp(async dir => {
  const zip=path.join(dir,'badcrc.zip'),stage=path.join(dir,'stage');await fsp.mkdir(stage);
  const data=makeZip({'bad.txt':'hello'});
  // Change central-directory checksum but leave compressed data unchanged.
  const offset=data.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  data.writeUInt32LE(0,offset+16);await fsp.writeFile(zip,data);
  const job={stage,files:0,bytes:0,skipped:[]};
  await assert.rejects(()=>stageArchive(zip,job,'badcrc.zip'),/checksum/);
  await assert.rejects(()=>fsp.stat(path.join(stage,'badcrc/bad.txt')));
}));

test('detects a common API key pattern before publishing', async () => temp(async dir => {
  const name='index.js';await fsp.writeFile(path.join(dir,name),'const token="ghp_12345678901234567890";');
  const findings=await secretCheck(dir,[name]);assert.deepEqual(findings,[name]);
}));

test('updates existing checkout without deleting unrelated files or following symlinks', async () => temp(async dir => {
  const stage=path.join(dir,'stage'),repo=path.join(dir,'checkout');await fsp.mkdir(stage);await fsp.mkdir(repo);
  await fsp.writeFile(path.join(stage,'new.txt'),'new');await fsp.writeFile(path.join(repo,'keep.txt'),'original');
  await copyToRepo(stage,repo,['new.txt'],'','');
  assert.equal(await fsp.readFile(path.join(repo,'keep.txt'),'utf8'),'original');
  assert.equal(await fsp.readFile(path.join(repo,'new.txt'),'utf8'),'new');
  if (process.platform !== 'win32') {
    const outside=path.join(dir,'outside');await fsp.mkdir(outside);
    await fsp.symlink(outside,path.join(repo,'linked'));
    await fsp.mkdir(path.join(stage,'linked'));await fsp.writeFile(path.join(stage,'linked','danger.txt'),'x');
    await assert.rejects(()=>copyToRepo(stage,repo,['linked/danger.txt'],'',''),/symbolic link/);
    await assert.rejects(()=>fsp.stat(path.join(outside,'danger.txt')));
  }
}));

test('local HTTP server stages a file using its session token; without login it cannot publish', async () => {
  process.env.GITDOCK_NO_BROWSER='1';
  const server=start();
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  const port=server.address().port;
  const base=`http://127.0.0.1:${port}`;
  try {
    const config=await (await fetch(base+'/app-config.js')).text();
    const token=JSON.parse(config.match(/window\.__GITDOCK_TOKEN=(.*);/)[1]);
    const auth={'X-GitDock-Token':token};
    const unauthorized=await fetch(base+'/api/jobs',{method:'POST'});
    assert.equal(unauthorized.status,403);
    const start=await fetch(base+'/api/jobs',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({repo:'test-repo'})});
    assert.equal(start.status,201);
    const {id}=await start.json();
    const post=await fetch(base+`/api/jobs/${id}/file?path=project%2Fsrc%2Findex.js`,{method:'POST',headers:auth,body:Buffer.from('hello')});
    assert.equal(post.status,200);
    const response=await (await fetch(base+`/api/jobs/${id}`,{headers:auth})).json();
    assert.equal(response.files,1);
    const publish=await fetch(base+`/api/jobs/${id}/publish`,{method:'POST',headers:auth});
    assert.equal(publish.status,202);
    // No GitHub CLI is installed in this test environment, so failure is expected.
    await new Promise(r=>setTimeout(r,250));
    const result=await (await fetch(base+`/api/jobs/${id}`,{headers:auth})).json();
    assert.ok(['error','publishing'].includes(result.state));
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});

test('end-to-end publisher creates repo, pushes content, and updates existing repo without deletion (mock GitHub)', async () => temp(async dir => {
  if (process.platform === 'win32') return;
  const { execFileSync } = require('node:child_process');
  const bin = path.join(dir, 'bin'), remotes = path.join(dir, 'remotes');
  await fsp.mkdir(bin);await fsp.mkdir(remotes);
  const gh = `#!/bin/sh
set -eu
case "$1 \${2-}" in
  '--version '*) echo 'gh version test';;
  'auth status'|'auth setup-git') exit 0;;
  'api user') echo '{"login":"mockuser","id":42,"name":"Commodious Works"}';;
  'repo create') git init -q --bare --initial-branch=main "$GITDOCK_TEST_REMOTES/$3.git";;
  'repo clone') git clone -q "$GITDOCK_TEST_REMOTES/\${3#*/}.git" "$4";;
  'repo list') echo '[]';;
  *) echo "Unexpected fake gh command: $*" >&2; exit 2;;
esac
`;
  const fake=path.join(bin,'gh');await fsp.writeFile(fake,gh,{mode:0o755});
  const oldPath=process.env.PATH,oldRemotes=process.env.GITDOCK_TEST_REMOTES;
  process.env.PATH=bin+path.delimiter+oldPath;
  process.env.GITDOCK_TEST_REMOTES=remotes;
  process.env.GITDOCK_NO_BROWSER='1';
  const server=start();
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function wait(id) {
    for(let i=0;i<100;i++) {
      const result=await (await fetch(base+`/api/jobs/${id}`)).json();
      if(result.state==='done'||result.state==='error') return result;
      await new Promise(r=>setTimeout(r,50));
    }
    throw Error('Timeout waiting for mock GitHub publish');
  }
  try {
    const config=await (await fetch(base+'/app-config.js')).text();
    const token=JSON.parse(config.match(/window\.__GITDOCK_TOKEN=(.*);/)[1]);
    const auth={'X-GitDock-Token':token};
    async function create(mode,repo,files) {
      const createResp=await fetch(base+'/api/jobs',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({mode,repo})});
      assert.equal(createResp.status,201);
      const {id}=await createResp.json();
      for(const [file,body] of Object.entries(files)) {
        const res=await fetch(base+`/api/jobs/${id}/file?path=${encodeURIComponent(file)}`,{method:'POST',headers:auth,body:Buffer.from(body)});
        assert.equal(res.status,200,await res.text());
      }
      const pub=await fetch(base+`/api/jobs/${id}/publish`,{method:'POST',headers:auth});
      assert.equal(pub.status,202);
      const result=await wait(id);
      assert.equal(result.state,'done',result.error||'Publish failed');
      return result;
    }
    const first=await create('new','test-publish',{'sample/keep.txt':'Keep me','sample/replace.txt':'v1'});
    assert.equal(first.result.repo,'mockuser/test-publish');
    const bare=path.join(remotes,'test-publish.git');
    const show=file=>execFileSync('git',['--git-dir',bare,'show',`main:${file}`],{encoding:'utf8'}).trim();
    assert.equal(show('keep.txt'),'Keep me');
    assert.equal(show('replace.txt'),'v1');
    const updated=await create('existing','mockuser/test-publish',{'sample/replace.txt':'v2','sample/new.txt':'New'});
    assert.equal(updated.result.changed,true);
    assert.equal(show('keep.txt'),'Keep me');
    assert.equal(show('replace.txt'),'v2');
    assert.equal(show('new.txt'),'New');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    process.env.PATH=oldPath;
    if(oldRemotes===undefined) delete process.env.GITDOCK_TEST_REMOTES;
    else process.env.GITDOCK_TEST_REMOTES=oldRemotes;
  }
}));

test('Linked Projects endpoints and UI are served locally and writes require token', async () => {
  process.env.GITDOCK_NO_BROWSER='1';
  const server=start();
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const version=await (await fetch(base+'/api/version')).json();
    assert.equal(version.version,'1.2.0');
    const html=await (await fetch(base+'/')).text();
    assert.match(html,/Linked Projects/);
    assert.match(html,/links\.js/);
    const script=await (await fetch(base+'/links.js')).text();
    assert.match(script,/Auto-Sync on save/);
    const links=await (await fetch(base+'/api/links')).json();
    assert.ok(Array.isArray(links.projects));
    const unauthorized=await fetch(base+'/api/links',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(unauthorized.status,403);
    const noPath=await fetch(base+'/api/links',{method:'POST',headers:{'X-GitDock-Token':'bad','Content-Type':'application/json'},body:'{}'});
    assert.equal(noPath.status,403);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
