// EB Manager - servidor e verificação de identidade por bio do Roblox.
// Requer Node.js 18 ou superior. Sem dependências externas e sem subpastas.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const COOKIE = 'eb_session';
const ROBLOX_API_BASE = (process.env.ROBLOX_API_BASE || 'https://users.roblox.com').replace(/\/$/, '');
const SESSION_TTL = 12 * 60 * 60 * 1000;
const CHALLENGE_TTL = 10 * 60 * 1000;
const sessions = new Map();
const rateLimits = new Map();
const PUBLIC_ASSETS = new Set([
  'app-icon.png','favicon.png','favicon.ico','eb-logo.png',
  'guarita.webp','guarita-1280.webp','guarita.jpg',
  'tropa.webp','tropa-1280.webp','tropa.jpg'
]);
const CONTENT_TYPES = {
  '.html':'text/html; charset=utf-8','.png':'image/png','.jpg':'image/jpeg',
  '.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'
};

function send(res, status, data, headers={}) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const isJson = typeof data !== 'string';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'strict-origin-when-cross-origin',
    'Cache-Control':'no-store',
    ...headers
  });
  res.end(body);
}
function jsonError(res, status, error) { send(res, status, {ok:false,error}); }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i=part.indexOf('='); if(i<0)return;
    const k=part.slice(0,i).trim(); const v=part.slice(i+1).trim();
    try { out[k]=decodeURIComponent(v); } catch (_) { out[k]=v; }
  });
  return out;
}
function cookieHeader(req, value, clear=false) {
  const secure = process.env.NODE_ENV === 'production' || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${clear?'':encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear?0:Math.floor(SESSION_TTL/1000)}${secure?'; Secure':''}`;
}
function getSession(req,res) {
  const cookies=parseCookies(req); let id=cookies[COOKIE]; let session=id && sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    if (id) sessions.delete(id);
    id=crypto.randomBytes(32).toString('hex');
    session={authenticated:false,user:null,challenge:null,expiresAt:Date.now()+SESSION_TTL};
    sessions.set(id,session); res.setHeader('Set-Cookie',cookieHeader(req,id));
  } else {
    session.expiresAt=Date.now()+SESSION_TTL;
  }
  return {id,session};
}
function requireSession(req,res) {
  const cookies=parseCookies(req); const id=cookies[COOKIE]; const s=id && sessions.get(id);
  if(!s || s.expiresAt < Date.now()) { if(id)sessions.delete(id); return null; }
  s.expiresAt=Date.now()+SESSION_TTL; return {id,session:s};
}
function ipFor(req) { return req.socket.remoteAddress || 'unknown'; }
function rateLimited(req, key, limit, windowMs) {
  const now=Date.now(), id=ipFor(req)+':'+key;
  let entry=rateLimits.get(id);
  if(!entry || now-entry.start>windowMs) { entry={start:now,count:0}; rateLimits.set(id,entry); }
  entry.count++; return entry.count>limit;
}
async function readJson(req) {
  return await new Promise((resolve,reject)=>{
    let data='';
    req.on('data',chunk=>{ data+=chunk; if(data.length>12*1024){ reject(new Error('Requisição muito grande.')); req.destroy(); } });
    req.on('end',()=>{ if(!data) return resolve({}); try{resolve(JSON.parse(data));}catch(_){reject(new Error('JSON inválido.'));} });
    req.on('error',reject);
  });
}
async function robloxFetch(url, options={}) {
  let response;
  try {
    response=await fetch(url,{...options,signal:AbortSignal.timeout(9000),headers:{'Accept':'application/json','Content-Type':'application/json','User-Agent':'EB-Manager-Bio-Verification/1.0',...(options.headers||{})}});
  } catch (_) { throw new Error('Não foi possível conectar ao Roblox agora. Tente novamente em alguns instantes.'); }
  if(response.status===429) throw new Error('O Roblox limitou as consultas. Aguarde um pouco e tente novamente.');
  if(response.status>=500) throw new Error('O serviço do Roblox está temporariamente indisponível. Tente novamente.');
  if(!response.ok) throw new Error('O Roblox não conseguiu responder à consulta do perfil. Confira o usuário e tente de novo.');
  try { return await response.json(); } catch (_) { throw new Error('O Roblox devolveu uma resposta inválida. Tente novamente.'); }
}
async function findRobloxUser(username) {
  const result=await robloxFetch(`${ROBLOX_API_BASE}/v1/usernames/users`,{
    method:'POST', body:JSON.stringify({usernames:[username],excludeBannedUsers:false})
  });
  const user=Array.isArray(result.data)?result.data.find(u=>String(u.name||'').toLowerCase()===username.toLowerCase()):null;
  if(!user || !user.id || !user.name) throw new Error('Não encontrei esse nome de usuário. Confira o NOME DE USUÁRIO, não o nome de exibição.');
  return {id:Number(user.id),username:user.name,displayName:user.displayName||user.name};
}
async function getRobloxProfile(id) {
  return await robloxFetch(`${ROBLOX_API_BASE}/v1/users/${encodeURIComponent(id)}`,{method:'GET',headers:{'Content-Type':'application/json'}});
}
function validUsername(value) {
  return typeof value==='string' && value.trim().length>=3 && value.trim().length<=20 && /^[A-Za-z0-9_]+$/.test(value.trim());
}
function sendFile(res,name) {
  const file=path.join(ROOT,name);
  fs.readFile(file,(err,buf)=>{
    if(err)return jsonError(res,500,'Não foi possível abrir um arquivo do site.');
    const ext=path.extname(name).toLowerCase();
    res.writeHead(200,{'Content-Type':CONTENT_TYPES[ext]||'application/octet-stream','Content-Length':buf.length,'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':ext==='.html'?'no-store':'public, max-age=3600'});
    res.end(buf);
  });
}
async function route(req,res) {
  const url=new URL(req.url,'http://localhost'); const pathname=url.pathname;
  if(req.method==='GET' && pathname==='/') { getSession(req,res); return sendFile(res,'index.html'); }
  if(req.method==='GET' && (pathname==='/painel' || pathname==='/dashboard')) {
    const current=requireSession(req,res);
    if(!current || !current.session.authenticated || !current.session.user) {
      res.writeHead(302,{Location:'/', 'Cache-Control':'no-store'}); return res.end();
    }
    return sendFile(res,'dashboard.html');
  }
  if(req.method==='GET' && pathname==='/api/me') {
    const current=requireSession(req,res);
    if(!current || !current.session.authenticated || !current.session.user) return send(res,401,{authenticated:false});
    return send(res,200,{authenticated:true,user:current.session.user});
  }
  if(req.method==='POST' && pathname==='/api/auth/start') {
    if(rateLimited(req,'start',12,15*60*1000)) return jsonError(res,429,'Muitas tentativas. Aguarde 15 minutos e tente novamente.');
    let body; try{body=await readJson(req);}catch(e){return jsonError(res,400,e.message);}
    const username=typeof body.username==='string'?body.username.trim():'';
    if(!validUsername(username)) return jsonError(res,400,'Digite um nome de usuário Roblox válido (3 a 20 letras, números ou _).');
    const current=getSession(req,res);
    if(current.session.authenticated) return send(res,200,{ok:true,authenticated:true});
    try {
      const user=await findRobloxUser(username);
      const code='EB-'+crypto.randomBytes(4).toString('hex').toUpperCase();
      current.session.challenge={userId:user.id,username:user.username,displayName:user.displayName,code,expiresAt:Date.now()+CHALLENGE_TTL,attempts:0};
      return send(res,200,{ok:true,code,username:user.username,userId:user.id,expiresIn:600});
    } catch(e) { return jsonError(res, e.message.includes('Não foi possível conectar')||e.message.includes('temporariamente')||e.message.includes('limitou')?503:400, e.message || 'Não foi possível iniciar a verificação.'); }
  }
  if(req.method==='POST' && pathname==='/api/auth/check') {
    if(rateLimited(req,'check',30,15*60*1000)) return jsonError(res,429,'Muitas verificações seguidas. Aguarde um pouco e tente novamente.');
    const current=requireSession(req,res);
    if(!current) return jsonError(res,401,'Sua sessão expirou. Gere um novo código.');
    if(current.session.authenticated) return send(res,200,{ok:true,authenticated:true});
    const challenge=current.session.challenge;
    if(!challenge) return jsonError(res,400,'Gere um código primeiro.');
    if(Date.now()>challenge.expiresAt) { current.session.challenge=null; return jsonError(res,400,'O código expirou. Gere um novo código e tente de novo.'); }
    if(challenge.attempts>=8) { current.session.challenge=null; return jsonError(res,429,'Limite de verificações atingido. Gere um novo código.'); }
    challenge.attempts++;
    try {
      const profile=await getRobloxProfile(challenge.userId);
      if(String(profile.name||'').toLowerCase()!==challenge.username.toLowerCase()) return jsonError(res,400,'O nome do perfil mudou. Gere um novo código.');
      const description=String(profile.description||'').toUpperCase();
      if(!description.includes(challenge.code)) return jsonError(res,400,'Ainda não encontrei o código na bio. Confira se salvou a descrição correta e tente novamente.');
      current.session.authenticated=true;
      current.session.user={id:challenge.userId,username:challenge.username,displayName:profile.displayName||challenge.displayName||challenge.username,verifiedAt:new Date().toISOString()};
      current.session.challenge=null;
      current.session.expiresAt=Date.now()+SESSION_TTL;
      return send(res,200,{ok:true,authenticated:true,user:current.session.user});
    } catch(e) { return jsonError(res,e.message.includes('Não foi possível conectar')||e.message.includes('temporariamente')||e.message.includes('limitou')?503:400,e.message||'Não foi possível conferir a bio.'); }
  }
  if(req.method==='POST' && pathname==='/api/auth/logout') {
    const current=requireSession(req,res); if(current)sessions.delete(current.id);
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Set-Cookie':cookieHeader(req,'',true),'Cache-Control':'no-store'}); return res.end(JSON.stringify({ok:true}));
  }
  if(req.method==='GET' && PUBLIC_ASSETS.has(pathname.slice(1)) && !pathname.slice(1).includes('/')) {
    const name=pathname.slice(1); const file=path.join(ROOT,name);
    fs.readFile(file,(err,buf)=>{if(err)return jsonError(res,404,'Arquivo não encontrado.');res.writeHead(200,{'Content-Type':CONTENT_TYPES[path.extname(name).toLowerCase()]||'application/octet-stream','Content-Length':buf.length,'X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=86400'});res.end(buf);}); return;
  }
  if(req.method==='GET' && pathname==='/robots.txt') { res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('User-agent: *\nDisallow: /painel\n'); }
  return jsonError(res,404,'Página não encontrada.');
}
const server=http.createServer((req,res)=>{route(req,res).catch(err=>{console.error('Erro interno:',err&&err.message);if(!res.headersSent)jsonError(res,500,'Erro interno do servidor. Tente novamente.');else res.destroy();});});
server.listen(PORT,HOST,()=>console.log(`EB Manager rodando em http://localhost:${PORT}`));
// Limpeza periódica para não deixar sessões e limites expirados em memória.
setInterval(()=>{const now=Date.now();for(const [id,s] of sessions){if(s.expiresAt<now)sessions.delete(id);}for(const [id,r] of rateLimits){if(now-r.start>30*60*1000)rateLimits.delete(id);}},10*60*1000).unref();
