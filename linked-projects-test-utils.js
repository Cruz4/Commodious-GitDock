'use strict';
const { spawn }=require('node:child_process');
exports.run = (binary,args,opts={})=>new Promise((resolve,reject)=>{
 const child=spawn(binary,args,{cwd:opts.cwd,stdio:['ignore','pipe','pipe']});
 let stdout=[],stderr=[];
 child.stdout.on('data',x=>stdout.push(x));child.stderr.on('data',x=>stderr.push(x));
 child.once('error',reject);child.once('close',code=>{
  const buf=Buffer.concat(stdout),message=Buffer.concat(stderr).toString();
  if(code!==0&&!opts.allow?.includes(code))reject(Error(message||buf.toString()||`git ${code}`));
  else resolve({code,stdout:buf,text:buf.toString().trim()});
 });
});
