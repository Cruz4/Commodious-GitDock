package main

const setupHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setting up GitDock — Commodious Works LLC</title>
<style>
:root{color-scheme:dark;font-family:Inter,Segoe UI,Arial,sans-serif}*{box-sizing:border-box}
body{background:radial-gradient(ellipse at 16% 10%,#292345 0%,transparent 52%),#0D1726;color:#f4f5ff;margin:0;min-height:100vh;display:grid;place-items:center;padding:20px}
main{max-width:590px;width:100%;border:1px solid #394057;background:#141e30;border-radius:23px;overflow:hidden;box-shadow:0 25px 80px #070a1666}
header{padding:32px 36px 20px;border-bottom:1px solid #2d394c;display:flex;align-items:center;gap:14px}
.brand-icon{width:46px;height:46px;border:1px solid #75518c;border-radius:13px;display:grid;place-items:center;color:#ed86f8;font-weight:900;font-size:24px;background:#241d37}
.brand-title{font-weight:800;letter-spacing:-.5px;font-size:24px}.brand-title b{color:#d946ef}
.brand-sub{font-size:10px;letter-spacing:2px;font-weight:700;color:#9ca6c5;margin-top:4px}
.content{padding:30px 36px 38px}h1{font-size:26px;line-height:1.2;letter-spacing:-.7px;margin:0 0 8px}
p{color:#adb9d2;line-height:1.6;font-size:14px;margin:0 0 22px}
.tool{padding:15px 16px;display:flex;align-items:center;gap:13px;border:1px solid #303b53;background:#1b2940;border-radius:11px;margin:9px 0}
.dot{display:grid;place-items:center;border-radius:50%;width:23px;height:23px;flex-shrink:0;border:2px solid #66728e;font-size:12px}
.dot.done{background:#234d46;border-color:#53bd99;color:#a2f3d9}.dot.missing{border-color:#b99550;color:#ebc876}
.tool-name{font-weight:700;font-size:14px}.tool-sub{font-size:12px;color:#95a3bf;margin-top:2px}.tool a{font-size:11px;margin-left:auto;color:#df98fb}
.message{background:#202e44;border:1px solid #344760;padding:14px 16px;border-radius:11px;margin-top:20px;font-size:13px;color:#cbd6ea;line-height:1.5;word-break:break-word}
.message.err{border-color:#a76758;background:#382832;color:#ffcdc6}
button{margin-top:16px;cursor:pointer;padding:12px 19px;background:#d946ef;border:0;color:#131020;border-radius:10px;font-weight:800;font-size:13px}
[hidden]{display:none!important}footer{padding:20px 36px;color:#7485a7;border-top:1px solid #2d394c;font-size:11px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
.spin{display:inline-block;border:2px solid #70597b;border-top-color:#eb98f4;border-radius:50%;height:14px;width:14px;animation:rotate 1s linear infinite;vertical-align:middle;margin-right:6px}@keyframes rotate{to{transform:rotate(360deg)}}
</style></head><body><main>
<header><div class="brand-icon">CW</div><div><div class="brand-title">Git<b>Dock</b></div><div class="brand-sub">BY COMMODIOUS WORKS LLC</div></div></header>
<div class="content"><h1 id="heading">Your one-click setup</h1><p>GitDock is setting itself up. You won't have to use a terminal or run any batch files. Windows may ask permission to install required tools.</p>
<div id="tools"></div><div class="message" id="msg"><span class="spin"></span> Checking requirements…</div><button hidden id="retry" type="button">Retry setup</button></div>
<footer><span>© 2026 Commodious Works LLC</span><span>Created by Jordie Cruz · Version 1.2</span></footer></main>
<script>
const session='SETUP_SESSION_TOKEN';const toolsEl=document.getElementById('tools');const msg=document.getElementById('msg');const retry=document.getElementById('retry');const heading=document.getElementById('heading');let redirecting=false;
async function update(){try{const res=await fetch('/api/status',{cache:'no-store'});const x=await res.json();toolsEl.replaceChildren();for(const t of x.tools){const row=document.createElement('div');row.className='tool';const dot=document.createElement('div');dot.className='dot '+(t.found?'done':'missing');dot.textContent=t.found?'✓':'·';const text=document.createElement('div');const name=document.createElement('div');name.className='tool-name';name.textContent=t.name;const desc=document.createElement('div');desc.className='tool-sub';desc.textContent=t.found?'Ready':'Missing — automatic setup in progress';text.append(name,desc);row.append(dot,text);if(!t.found){const link=document.createElement('a');link.href=t.link;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Official download';row.append(link);}toolsEl.append(row);}
const bad=x.phase==='needs-help';heading.textContent=x.phase==='ready'?'Setup complete!':bad?'Setup needs attention':'Your one-click setup';msg.className='message'+(bad?' err':'');msg.textContent=x.error?x.detail+' '+x.error:x.detail;retry.hidden=!bad;
if(x.ready&&!redirecting){redirecting=true;window.location.replace(x.ready);return;}}
catch(e){msg.textContent='Checking the installer… '+e.message;}}
retry.onclick=async()=>{retry.hidden=true;msg.textContent='Retrying setup…';await fetch('/api/retry',{method:'POST',headers:{'X-Setup-Token':session}});update()};update();setInterval(update,1400);
</script></body></html>`
