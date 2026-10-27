// EB Manager - login verificado por bio, identificação de patente e entrega de patente.
// Node.js 18+. Chave Open Cloud é configurada somente como variável secreta no Render.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
// Os dados podem ficar em disco persistente no Render usando EB_DATA_DIR=/var/data.
const DATA_DIR = process.env.EB_DATA_DIR || ROOT;
fs.mkdirSync(DATA_DIR, {recursive:true});
const COOKIE = 'eb_session';
const GROUP_ID = Number(process.env.EB_GROUP_ID || 13616747);
const USERS_API_BASE = (process.env.ROBLOX_API_BASE || 'https://users.roblox.com').replace(/\/$/, '');
const GROUPS_API_BASE = (process.env.ROBLOX_GROUPS_API_BASE || 'https://groups.roblox.com').replace(/\/$/, '');
const OPEN_CLOUD_BASE = (process.env.ROBLOX_OPEN_CLOUD_BASE || 'https://apis.roblox.com/cloud/v2').replace(/\/$/, '');
const OPEN_CLOUD_API_KEY = process.env.ROBLOX_OPEN_CLOUD_API_KEY || '';
const ROBLOX_CDP_API_KEY = process.env.ROBLOX_CDP_API_KEY || '';
// Login persistente por até 10 anos, renovado em cada acesso e revogável pelo botão Sair.
const SESSION_TTL = 10 * 365 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL = 10 * 60 * 1000;
const MAX_JSON_BYTES = 1.25 * 1024 * 1024;
const MAX_PHOTO_BYTES = 600 * 1024;
const MAX_TARGETS = 1;
const STORE_PATH = path.join(DATA_DIR, 'promocoes.json');
const CARGO_PATH = path.join(ROOT, 'cargos_eb.json');
const CDP_STORE_PATH = path.join(DATA_DIR, 'cdp.json');
const SESSION_STORE_PATH = path.join(DATA_DIR, 'sessoes.json');
const COOLDOWN_PATH = path.join(DATA_DIR, 'promocao-cooldown.json');
// Ao usar um disco persistente novo no Render, copia os dados iniciais do repositório apenas uma vez.
if (DATA_DIR !== ROOT) {
  for (const name of ['promocoes.json','cdp.json','sessoes.json','promocao-cooldown.json']) {
    const target = path.join(DATA_DIR,name), source = path.join(ROOT,name);
    if (!fs.existsSync(target) && fs.existsSync(source)) { try { fs.copyFileSync(source,target); } catch (_) {} }
  }
}
const sessions = new Map();
const rateLimits = new Map();
function persistJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function loadPersistedSessions() {
  const saved = loadJsonFile(SESSION_STORE_PATH, {sessions:[]});
  const now = Date.now();
  for (const pair of (Array.isArray(saved.sessions) ? saved.sessions : [])) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [id, session] = pair;
    if (!/^[a-f0-9]{64}$/.test(String(id)) || !session || session.authenticated !== true || !session.user || Number(session.expiresAt) <= now) continue;
    sessions.set(String(id), {...session, challenge:null});
  }
}
function savePersistedSessions() {
  const now = Date.now();
  const entries = [...sessions.entries()].filter(([id, session]) => /^[a-f0-9]{64}$/.test(id) && session.authenticated === true && session.user && Number(session.expiresAt) > now);
  try { persistJson(SESSION_STORE_PATH, {sessions:entries}); }
  catch (error) { console.error('Não foi possível salvar as sessões persistentes:', error.message); }
}

const PUBLIC_ASSETS = new Set([
  'app-icon.png','favicon.png','favicon.ico','eb-logo.png',
  'guarita.webp','guarita-1280.webp','guarita.jpg',
  'tropa.webp','tropa-1280.webp','tropa.jpg'
]);
const CONTENT_TYPES = {
  '.html':'text/html; charset=utf-8','.png':'image/png','.jpg':'image/jpeg',
  '.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'
};

function loadJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
loadPersistedSessions();
const cargoConfig = loadJsonFile(CARGO_PATH, {groupId:GROUP_ID,roles:[],promotionOrder:[],promotionRules:{}});
const roleById = new Map((cargoConfig.roles || []).map(r => [String(r.id), r]));
const promotionOrder = Array.isArray(cargoConfig.promotionOrder) ? cargoConfig.promotionOrder : [];
const blockedRoleIds = new Set((cargoConfig.promotionRules?.blockedRoleIds || []).map(String));
const blockedRoleNames = (cargoConfig.promotionRules?.blockedRoleNames || []).map(normalizeName);
const baseRoleIds = new Set((cargoConfig.baseRoleIds || [12884901889]).map(String));
const configuredPromoterRoleIds = new Set(
  (process.env.EB_PROMOTER_ROLE_IDS
    ? process.env.EB_PROMOTER_ROLE_IDS.split(',').map(s => s.trim()).filter(Boolean)
    : (cargoConfig.promotionRules?.promoterRoleIds || []).map(String)).map(String)
);

// Requisitos de horas enviados pelo usuário. As horas creditadas são administradas no painel CDP;
// o tempo de jogo não é contado automaticamente como treinamento.
const CDP_REQUIRED_HOURS_BY_ROLE_ID = new Map(Object.entries({
  '843650047':3, '843894043':6, '843100045':9, '843328046':12, '845214008':15,
  '843170054':18, '843210093':21, '844150047':24, '844004101':27, '843780075':30,
  '845208001':33, '843126091':36, '845782001':39, '842292095':42, '843750090':45,
  '845856000':48, '842814077':51, '842498073':54, '845218008':57, '845208002':60,
  '843610097':63, '845270007':66, '845586003':69, '843044094':72, '842446075':72
}).map(([id,hours]) => [id, Number(hours)]));
let lastPromotionAt = Number(loadJsonFile(COOLDOWN_PATH, {lastPromotionAt:0}).lastPromotionAt || 0);
function loadCdpStore() {
  const value = loadJsonFile(CDP_STORE_PATH, {users:{}});
  if (!value || typeof value !== 'object' || !value.users || typeof value.users !== 'object') return {users:{}};
  return value;
}
function saveCdpStore(store) { persistJson(CDP_STORE_PATH, store); }
function getCdpRecord(userId) {
  const store = loadCdpStore();
  return store.users[String(userId)] || {userId:Number(userId),creditedMinutes:0,inCdp:false,updatedAt:null,history:[]};
}
function getRequiredCdpHours(roleInfo) {
  if (roleInfo?.roleId && CDP_REQUIRED_HOURS_BY_ROLE_ID.has(String(roleInfo.roleId))) return CDP_REQUIRED_HOURS_BY_ROLE_ID.get(String(roleInfo.roleId));
  const name = normalizeName(roleInfo?.roleName || '');
  if (name === 'sub comandante' || name === 'comandante') return 72;
  return null;
}
function formatHours(value) { return Number(value || 0).toLocaleString('pt-BR',{maximumFractionDigits:2}); }
function buildCdpProgress(userId, roleInfo, username='') {
  const record = getCdpRecord(userId);
  const completed = Math.max(0, Number(record.creditedMinutes || 0) / 60);
  const required = getRequiredCdpHours(roleInfo);
  const remaining = required == null ? null : Math.max(0, required - completed);
  const state = record.inCdp ? 'EM CDP' : required == null ? 'REQUISITO NÃO DEFINIDO' : remaining <= 0 ? 'HORAS CUMPRIDAS' : 'EM PROGRESSO';
  const displayText = required == null
    ? `CDP: ${formatHours(completed)}h • ${state}`
    : `CDP: ${formatHours(completed)}h / ${formatHours(required)}h` + (record.inCdp ? ' • EM CDP' : '');
  return {userId:Number(userId),username,roleName:roleInfo?.roleName || 'Patente não identificada',creditedMinutes:Number(record.creditedMinutes||0),hoursCompleted:Number(completed.toFixed(2)),hoursRequired:required,hoursRemaining:remaining==null?null:Number(remaining.toFixed(2)),inCdp:!!record.inCdp,eligibleForPromotion:!record.inCdp && (remaining == null || remaining <= 0),status:state,displayText,updatedAt:record.updatedAt || null,history:(record.history||[]).slice(-10).reverse()};
}
function validCdpApiKey(req) {
  const provided = String(req.headers['x-cdp-api-key'] || '');
  if (!ROBLOX_CDP_API_KEY || !provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(ROBLOX_CDP_API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}

function normalizeName(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function send(res, status, data, headers={}) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const isJson = typeof data !== 'string';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Content-Length': body.length, 'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'strict-origin-when-cross-origin', 'Cache-Control':'no-store', ...headers
  });
  res.end(body);
}
function jsonError(res, status, error) { send(res, status, {ok:false,error}); }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('='); if (i < 0) return;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  });
  return out;
}
function cookieHeader(req, value, clear=false) {
  const secure = process.env.NODE_ENV === 'production' || !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${clear?'':encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear?0:Math.floor(SESSION_TTL/1000)}${secure?'; Secure':''}`;
}
function getSession(req, res) {
  const cookies = parseCookies(req); let id = cookies[COOKIE]; let session = id && sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    if (id) sessions.delete(id);
    id = crypto.randomBytes(32).toString('hex');
    session = {authenticated:false,user:null,challenge:null,expiresAt:Date.now()+SESSION_TTL};
    sessions.set(id, session);
  } else {
    session.expiresAt = Date.now() + SESSION_TTL;
    if (session.authenticated) savePersistedSessions();
  }
  res.setHeader('Set-Cookie', cookieHeader(req, id));
  return {id, session};
}
function requireSession(req, res) {
  const cookies = parseCookies(req); const id = cookies[COOKIE]; const session = id && sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  // Renova a expiração do cookie e persiste o login até o usuário clicar em Sair.
  res.setHeader('Set-Cookie', cookieHeader(req, id));
  if (session.authenticated) savePersistedSessions();
  return {id, session};
}
function ipFor(req) { return req.socket.remoteAddress || 'unknown'; }
function rateLimited(req, key, limit, windowMs) {
  const now = Date.now(), id = ipFor(req) + ':' + key; let entry = rateLimits.get(id);
  if (!entry || now - entry.start > windowMs) { entry = {start:now,count:0}; rateLimits.set(id, entry); }
  entry.count++; return entry.count > limit;
}
async function readJson(req, maxBytes=MAX_JSON_BYTES) {
  return await new Promise((resolve, reject) => {
    let data = ''; let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data, 'utf8') > maxBytes) { tooLarge = true; data = ''; }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('Requisição muito grande. Reduza o tamanho da foto e tente novamente.'));
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}
async function fetchJson(url, options={}, isCloud=false) {
  let response;
  try {
    const headers = {'Accept':'application/json','Content-Type':'application/json','User-Agent':'EB-Manager/2.0',...(options.headers || {})};
    response = await fetch(url, {...options, signal:AbortSignal.timeout(10000), headers});
  } catch (_) {
    throw new Error(isCloud ? 'Não foi possível conectar à API Open Cloud do Roblox.' : 'Não foi possível conectar ao Roblox agora. Tente novamente em alguns instantes.');
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {message:raw.slice(0,500)}; }
  if (!response.ok) {
    if (response.status === 429) throw new Error('O Roblox limitou as consultas. Aguarde um pouco e tente novamente.');
    if (isCloud && (response.status === 401 || response.status === 403)) throw new Error('A chave Open Cloud não tem autorização. Confira a chave e as permissões de grupo no Render.');
    if (isCloud && response.status === 404) throw new Error('A associação do militar não foi encontrada na API Open Cloud. Confirme se ele está no grupo EB.');
    if (response.status >= 500) throw new Error('O serviço do Roblox está temporariamente indisponível. Tente novamente.');
    throw new Error(data.message || data.errors?.[0]?.message || `O Roblox respondeu com erro HTTP ${response.status}.`);
  }
  return data;
}
async function robloxFetch(url, options={}) { return fetchJson(url, options, false); }
async function cloudFetch(url, options={}) {
  if (!OPEN_CLOUD_API_KEY) throw new Error('Falta configurar ROBLOX_OPEN_CLOUD_API_KEY nas variáveis de ambiente do Render.');
  return fetchJson(url, {...options,headers:{'x-api-key':OPEN_CLOUD_API_KEY,...(options.headers || {})}}, true);
}
async function findRobloxUser(username) {
  const result = await robloxFetch(`${USERS_API_BASE}/v1/usernames/users`, {
    method:'POST', body:JSON.stringify({usernames:[username],excludeBannedUsers:false})
  });
  const user = Array.isArray(result.data) ? result.data.find(u => String(u.name || '').toLowerCase() === username.toLowerCase()) : null;
  if (!user || !user.id || !user.name) throw new Error('Não encontrei esse nome de usuário Roblox. Digite o nome de usuário, não o nome de exibição.');
  return {id:Number(user.id),username:user.name,displayName:user.displayName || user.name};
}
async function getRobloxProfile(id) {
  return robloxFetch(`${USERS_API_BASE}/v1/users/${encodeURIComponent(id)}`, {method:'GET'});
}
async function findRobloxUserById(id) {
  const profile = await getRobloxProfile(id);
  if (!profile || !profile.id || !profile.name) throw new Error('Não encontrei essa conta Roblox.');
  return {id:Number(profile.id),username:profile.name,displayName:profile.displayName || profile.name};
}
function validUsername(value) {
  return typeof value === 'string' && value.trim().length >= 3 && value.trim().length <= 20 && /^[A-Za-z0-9_]+$/.test(value.trim());
}
function roleIdFromPath(value) {
  if (value && typeof value === 'object') return value.id != null ? String(value.id) : null;
  const match = String(value || '').match(/(?:^|\/)roles\/(\d+)(?:$|\/)/);
  if (match) return match[1];
  return /^\d+$/.test(String(value || '')) ? String(value) : null;
}
function addRoleCandidate(list, candidate) {
  if (!candidate) return;
  if (Array.isArray(candidate)) { candidate.forEach(item => addRoleCandidate(list, item)); return; }
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    const id = roleIdFromPath(candidate);
    if (id) list.push({id, name:roleById.get(id)?.name || ''});
    return;
  }
  if (typeof candidate === 'object') {
    const id = roleIdFromPath(candidate.id ?? candidate.roleId ?? candidate.path ?? candidate.role);
    if (id) list.push({id, name:candidate.name || roleById.get(id)?.name || '', rank:candidate.rank});
  }
}
function getMappedRole(roleId) {
  const id = String(roleId);
  return promotionOrder.find(item => String(item.id) === id || (item.aliasRoleIds || []).some(alias => String(alias) === id)) || null;
}
function isBlockedRoleId(roleId) { return blockedRoleIds.has(String(roleId)); }
function isBlockedRoleName(name) {
  const normal = normalizeName(name);
  return !!normal && blockedRoleNames.some(blocked => normal === blocked || normal.includes(blocked));
}
function chooseCurrentRole(roleCandidates) {
  const unique = new Map();
  for (const candidate of roleCandidates) {
    const id = String(candidate.id);
    if (!unique.has(id)) unique.set(id, {...candidate, name:candidate.name || roleById.get(id)?.name || ''});
  }
  const candidates = [...unique.values()];
  const blocked = candidates.find(c => isBlockedRoleId(c.id) || isBlockedRoleName(c.name));
  if (blocked) {
    const configRole = roleById.get(String(blocked.id));
    return {roleId:String(blocked.id),roleName:configRole?.name || blocked.name || 'Cargo bloqueado',index:null,blocked:true};
  }
  const actual = candidates.map(c => ({...c, mapped:getMappedRole(c.id)})).filter(c => c.mapped);
  const nonBase = actual.filter(c => !baseRoleIds.has(String(c.id)));
  const chosenList = nonBase.length ? nonBase : actual;
  if (chosenList.length) {
    chosenList.sort((a,b) => promotionOrder.findIndex(r => r.name === a.mapped.name) - promotionOrder.findIndex(r => r.name === b.mapped.name));
    const chosen = chosenList[chosenList.length - 1];
    const index = promotionOrder.findIndex(r => r.name === chosen.mapped.name);
    return {roleId:String(chosen.id),roleName:chosen.mapped.name,index,blocked:false};
  }
  const fallback = candidates[0];
  if (fallback) return {roleId:String(fallback.id),roleName:fallback.name || 'Patente não identificada',index:null,blocked:false};
  return {roleId:null,roleName:'Patente não identificada',index:null,blocked:false};
}
async function getCloudMembership(userId) {
  if (!OPEN_CLOUD_API_KEY) return null;
  const filter = `user == 'users/${Number(userId)}'`;
  const url = `${OPEN_CLOUD_BASE}/groups/${GROUP_ID}/memberships?filter=${encodeURIComponent(filter)}&maxPageSize=10`;
  const result = await cloudFetch(url, {method:'GET'});
  const memberships = result.groupMemberships || result.memberships || [];
  return memberships.find(m => String(m.user || '').endsWith('/' + Number(userId))) || memberships[0] || null;
}
function getMembershipRoleCandidates(membership) {
  const candidates = [];
  if (!membership) return candidates;
  addRoleCandidate(candidates, membership.role);
  addRoleCandidate(candidates, membership.roles);
  return candidates;
}
async function getUserGroupRoleInfo(userId) {
  let publicResponse = null, publicError = null, cloudMembership = null, cloudError = null;
  const publicPromise = robloxFetch(`${GROUPS_API_BASE}/v2/users/${encodeURIComponent(userId)}/groups/roles`, {method:'GET'})
    .then(value => { publicResponse = value; }).catch(error => { publicError = error; });
  const cloudPromise = OPEN_CLOUD_API_KEY
    ? getCloudMembership(userId).then(value => { cloudMembership = value; }).catch(error => { cloudError = error; })
    : Promise.resolve();
  await Promise.all([publicPromise, cloudPromise]);
  const entries = Array.isArray(publicResponse?.data) ? publicResponse.data : [];
  const entry = entries.find(item => Number(item.group?.id ?? item.groupId ?? item.group?.groupId) === GROUP_ID) || null;
  const foundMembership = !!entry || !!cloudMembership;
  if (!foundMembership) {
    if (!publicResponse && cloudError) return {member:null,roleId:null,roleName:'Não foi possível consultar',roleIds:[],blocked:false,error:publicError?.message || cloudError.message};
    if (!publicResponse && publicError && !OPEN_CLOUD_API_KEY) return {member:null,roleId:null,roleName:'Não foi possível consultar',roleIds:[],blocked:false,error:publicError.message};
    return {member:false,roleId:null,roleName:'Não está no grupo EB',roleIds:[],blocked:false};
  }
  const candidates = [];
  if (entry) {
    addRoleCandidate(candidates, entry.role);
    addRoleCandidate(candidates, entry.roles);
    addRoleCandidate(candidates, entry.groupRole);
    addRoleCandidate(candidates, entry.groupRoles);
  }
  candidates.push(...getMembershipRoleCandidates(cloudMembership));
  const roleIds = [...new Set(candidates.map(c => String(c.id)))];
  const current = chooseCurrentRole(candidates);
  const roleNames = candidates.map(c => c.name).filter(Boolean);
  const blocked = current.blocked || roleIds.some(isBlockedRoleId) || roleNames.some(isBlockedRoleName);
  let roleName = current.roleName;
  if (blocked) {
    const blockedCandidate = candidates.find(c => isBlockedRoleId(c.id) || isBlockedRoleName(c.name));
    const blockedConfig = blockedCandidate && roleById.get(String(blockedCandidate.id));
    roleName = blockedConfig?.name || blockedCandidate?.name || roleName;
  }
  const idx = blocked ? null : current.index;
  const nextRole = idx != null && idx >= 0 ? (promotionOrder[idx + 1] || null) : null;
  const nextRoleName = nextRole ? ((isBlockedRoleId(nextRole.id) || isBlockedRoleName(nextRole.name)) ? 'Promoção bloqueada' : nextRole.name) : null;
  return {
    member:true, roleId:current.roleId, roleName, rankIndex:idx, nextRoleName,
    roleIds, blocked, cloudMembership, publicRole:entry?.role || null,
    groupName:entry?.group?.name || 'Exército Brasileiro'
  };
}
function actorCanPromote(info) {
  return !!info?.member && (info.roleIds || []).some(id => configuredPromoterRoleIds.has(String(id)));
}
function safeGroupSummary(info) {
  return {
    member:info?.member ?? null,
    name:info?.roleName || (info?.member === false ? 'Não está no grupo EB' : 'Patente não identificada'),
    roleId:info?.roleId || null,
    blocked:!!info?.blocked,
    nextRoleName:info?.nextRoleName || null,
    error:info?.member === null ? (info.error || 'Não foi possível consultar a patente agora.') : null
  };
}
async function updateUserGroupDetails(user) {
  const info = await getUserGroupRoleInfo(user.id);
  user._roleIds = info.roleIds || [];
  user.groupRole = safeGroupSummary(info);
  user.canPromote = actorCanPromote(info);
  user.promotionApiConfigured = !!OPEN_CLOUD_API_KEY;
  user.nextRoleName = info.nextRoleName || null;
  return info;
}
function publicUserView(user) {
  return {
    id:user.id, username:user.username, displayName:user.displayName, verifiedAt:user.verifiedAt,
    groupRole:user.groupRole || {member:null,name:'Patente não identificada',roleId:null,blocked:false,nextRoleName:null},
    canPromote:!!user.canPromote, promotionApiConfigured:!!user.promotionApiConfigured,
    nextRoleName:user.nextRoleName || null
  };
}
function requireAuthenticated(req, res) {
  const current = requireSession(req, res);
  if (!current || !current.session.authenticated || !current.session.user) {
    jsonError(res, 401, 'Faça login e verifique sua conta primeiro.'); return null;
  }
  return current;
}
async function requirePromotionPermission(req, res) {
  const current = requireAuthenticated(req, res);
  if (!current) return null;
  try { await updateUserGroupDetails(current.session.user); }
  catch (error) { current.session.user.canPromote = false; }
  if (!current.session.user.canPromote) {
    jsonError(res, 403, 'Seu cargo atual não está autorizado a usar Entregar Patente. A permissão é conferida no servidor.');
    return null;
  }
  return current;
}
function sendFile(res, name) {
  const file = path.join(ROOT, name);
  fs.readFile(file, (err, buf) => {
    if (err) return jsonError(res, 500, 'Não foi possível abrir um arquivo do site.');
    const ext = path.extname(name).toLowerCase();
    res.writeHead(200, {'Content-Type':CONTENT_TYPES[ext] || 'application/octet-stream','Content-Length':buf.length,'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':ext === '.html' ? 'no-store' : 'public, max-age=3600'});
    res.end(buf);
  });
}
function currentPromotionRole(info) {
  if (!info || !info.member || info.blocked || info.rankIndex == null) return null;
  const item = promotionOrder[info.rankIndex];
  return item ? {id:Number(info.roleId || item.id),canonicalId:Number(item.id),name:item.name,index:info.rankIndex,baseRoleIds:(item.aliasRoleIds || []).map(Number)} : null;
}
function nextPromotionRole(info) {
  const current = currentPromotionRole(info);
  if (!current) return null;
  const next = promotionOrder[current.index + 1];
  return next ? {id:Number(next.id),name:next.name,index:current.index + 1,blocked:isBlockedRoleId(next.id) || isBlockedRoleName(next.name)} : null;
}
function getRolePath(id) { return `groups/${GROUP_ID}/roles/${String(id)}`; }
function membershipIdFrom(membership) {
  const match = String(membership?.path || '').match(/\/memberships\/([^/]+)$/);
  return match ? match[1] : null;
}
async function cloudAssignRole(membershipId, roleId, action='assignRole') {
  const url = `${OPEN_CLOUD_BASE}/groups/${GROUP_ID}/memberships/${encodeURIComponent(membershipId)}:${action}`;
  return cloudFetch(url, {method:'POST',body:JSON.stringify({role:getRolePath(roleId)})});
}
function membershipHasRole(membership, roleId) {
  const path = getRolePath(roleId);
  const list = Array.isArray(membership?.roles) ? membership.roles : [];
  return list.includes(path);
}
function roleIsBase(id) { return baseRoleIds.has(String(id)); }
function loadPromotionStore() {
  const value = loadJsonFile(STORE_PATH, {batches:[]});
  if (Array.isArray(value)) return {batches:value};
  if (value && Array.isArray(value.batches)) return value;
  return {batches:[]};
}
function savePromotionBatch(batch) {
  const store = loadPromotionStore();
  store.batches.push(batch);
  store.batches = store.batches.slice(-60);
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}
function photoDataFromRequest(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 900 * 1024) throw new Error('A foto ficou muito grande. Selecione uma imagem menor.');
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Formato de foto inválido. Use JPG, PNG ou WEBP.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error('A foto compactada deve ter até 600 KB.');
  return {dataUrl:value,mime:match[1],bytes:bytes.length};
}
async function getTargetPromotionState(userId) {
  const profile = await findRobloxUserById(userId);
  const info = await getUserGroupRoleInfo(profile.id);
  if (info.member !== true) {
    if (info.member === null) throw new Error(info.error || 'Não consegui confirmar se o militar está no grupo EB.');
    throw new Error(`${profile.username} não aparece como membro do grupo EB.`);
  }
  const current = currentPromotionRole(info);
  const next = nextPromotionRole(info);
  return {profile,info,current,next};
}
async function performPromotion(actor, targetState) {
  const {profile,info,current,next} = targetState;
  if (Number(profile.id) === Number(actor.id)) throw new Error('Você não pode promover a própria conta.');
  const cdpRecord = getCdpRecord(profile.id);
  if (cdpRecord.inCdp) throw new Error('Este militar está Em CDP e não pode ser promovido enquanto esse status estiver ativo.');
  const cooldownRemaining = 30*60*1000 - (Date.now() - lastPromotionAt);
  if (lastPromotionAt && cooldownRemaining > 0) {
    const mins = Math.ceil(cooldownRemaining/60000);
    throw new Error(`Intervalo global de promoções ativo. Aguarde aproximadamente ${mins} minuto(s) antes de promover outra pessoa.`);
  }
  if (info.blocked || (info.roleIds || []).some(isBlockedRoleId)) throw new Error('Este militar está em um cargo protegido. Elite Real até Criador não podem receber promoção.');
  if (!current) throw new Error(`Não consegui identificar a patente atual de ${profile.username}. Confira os cargos do grupo e o arquivo cargos_eb.json.`);
  if (!next) throw new Error(`${profile.username} já está no último cargo da sequência configurada.`);
  if (next.blocked || isBlockedRoleId(next.id) || isBlockedRoleName(next.name)) throw new Error(`A próxima patente, ${next.name}, está protegida e não pode ser atribuída.`);
  if (!OPEN_CLOUD_API_KEY) throw new Error('Para promover de verdade, adicione ROBLOX_OPEN_CLOUD_API_KEY nas variáveis de ambiente do Render. A chave não deve ser colocada no código.');
  const membership = info.cloudMembership || await getCloudMembership(profile.id);
  const membershipId = membershipIdFrom(membership);
  if (!membershipId) throw new Error('Não consegui localizar a associação do militar na API Open Cloud. Verifique as permissões group:read e group:write da chave.');
  await cloudAssignRole(membershipId, next.id, 'assignRole');
  // Se a patente anterior era uma função atribuída (não o cargo-base do grupo), removemos a antiga após atribuir a nova.
  if (!roleIsBase(current.id) && membershipHasRole(membership, current.id)) {
    try {
      await cloudAssignRole(membershipId, current.id, 'unassignRole');
    } catch (error) {
      try { await cloudAssignRole(membershipId, next.id, 'unassignRole'); } catch (_) {}
      throw new Error('O Roblox não permitiu remover a patente anterior. A nova atribuição foi revertida quando possível. Detalhe: ' + error.message);
    }
  }
  lastPromotionAt = Date.now();
  try { persistJson(COOLDOWN_PATH,{lastPromotionAt,updatedAt:new Date(lastPromotionAt).toISOString()}); }
  catch (error) { console.error('Não foi possível salvar o intervalo de promoção:',error.message); }
  return {userId:profile.id,username:profile.username,displayName:profile.displayName,fromRole:current.name,toRole:next.name,roleId:next.id,status:'success',message:`Promovido para ${next.name}.`};
}
function promotionHistorySummary(store, limit=8) {
  return (store.batches || []).slice(-limit).reverse().map(batch => ({
    id:batch.id,createdAt:batch.createdAt,promoter:batch.promoter,observations:batch.observations || '',
    hasPhoto:!!batch.photoDataUrl,
    results:(batch.results || []).map(result => ({userId:result.userId,username:result.username,displayName:result.displayName,fromRole:result.fromRole,toRole:result.toRole,status:result.status,message:result.message}))
  }));
}
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost'); const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/') { getSession(req, res); return sendFile(res, 'index.html'); }
  if (req.method === 'GET' && (pathname === '/painel' || pathname === '/dashboard')) {
    const current = requireSession(req, res);
    if (!current || !current.session.authenticated || !current.session.user) { res.writeHead(302,{Location:'/','Cache-Control':'no-store'}); return res.end(); }
    return sendFile(res, 'dashboard.html');
  }
  if (req.method === 'GET' && pathname === '/api/me') {
    const current = requireAuthenticated(req, res); if (!current) return;
    try { await updateUserGroupDetails(current.session.user); }
    catch (error) { current.session.user.groupRole = {member:null,name:'Não foi possível consultar',roleId:null,blocked:false,nextRoleName:null,error:error.message}; current.session.user.canPromote = false; current.session.user.promotionApiConfigured = !!OPEN_CLOUD_API_KEY; }
    return send(res,200,{authenticated:true,user:publicUserView(current.session.user)});
  }
  if (req.method === 'POST' && pathname === '/api/auth/start') {
    if (rateLimited(req,'start',12,15*60*1000)) return jsonError(res,429,'Muitas tentativas. Aguarde 15 minutos e tente novamente.');
    let body; try { body = await readJson(req, 12 * 1024); } catch (e) { return jsonError(res,400,e.message); }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!validUsername(username)) return jsonError(res,400,'Digite um nome de usuário Roblox válido (3 a 20 letras, números ou _).');
    const current = getSession(req, res);
    if (current.session.authenticated) return send(res,200,{ok:true,authenticated:true});
    try {
      const user = await findRobloxUser(username);
      const code = 'EB-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      current.session.challenge = {userId:user.id,username:user.username,displayName:user.displayName,code,expiresAt:Date.now()+CHALLENGE_TTL,attempts:0};
      return send(res,200,{ok:true,code,username:user.username,userId:user.id,expiresIn:600});
    } catch (e) { return jsonError(res, /conectar|temporariamente|limitou/i.test(e.message) ? 503 : 400, e.message || 'Não foi possível iniciar a verificação.'); }
  }
  if (req.method === 'POST' && pathname === '/api/auth/check') {
    if (rateLimited(req,'check',30,15*60*1000)) return jsonError(res,429,'Muitas verificações seguidas. Aguarde um pouco e tente novamente.');
    const current = requireSession(req, res);
    if (!current) return jsonError(res,401,'Sua sessão expirou. Gere um novo código.');
    if (current.session.authenticated) return send(res,200,{ok:true,authenticated:true,user:publicUserView(current.session.user)});
    const challenge = current.session.challenge;
    if (!challenge) return jsonError(res,400,'Gere um código primeiro.');
    if (Date.now() > challenge.expiresAt) { current.session.challenge = null; return jsonError(res,400,'O código expirou. Gere um novo código e tente de novo.'); }
    if (challenge.attempts >= 8) { current.session.challenge = null; return jsonError(res,429,'Limite de verificações atingido. Gere um novo código.'); }
    challenge.attempts++;
    try {
      const profile = await getRobloxProfile(challenge.userId);
      if (String(profile.name || '').toLowerCase() !== challenge.username.toLowerCase()) return jsonError(res,400,'O nome do perfil mudou. Gere um novo código.');
      if (!String(profile.description || '').toUpperCase().includes(challenge.code)) return jsonError(res,400,'Ainda não encontrei o código na bio. Confira se salvou a descrição correta e tente novamente.');
      current.session.authenticated = true;
      current.session.user = {id:challenge.userId,username:challenge.username,displayName:profile.displayName || challenge.displayName || challenge.username,verifiedAt:new Date().toISOString()};
      current.session.challenge = null; current.session.expiresAt = Date.now() + SESSION_TTL;
      savePersistedSessions();
      try { await updateUserGroupDetails(current.session.user); }
      catch (error) { current.session.user.groupRole = {member:null,name:'Não foi possível consultar',roleId:null,blocked:false,nextRoleName:null,error:error.message}; current.session.user.canPromote = false; current.session.user.promotionApiConfigured = !!OPEN_CLOUD_API_KEY; }
      return send(res,200,{ok:true,authenticated:true,user:publicUserView(current.session.user)});
    } catch (e) { return jsonError(res,/conectar|temporariamente|limitou/i.test(e.message) ? 503 : 400,e.message || 'Não foi possível conferir a bio.'); }
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const id = parseCookies(req)[COOKIE];
    if (id) sessions.delete(id);
    savePersistedSessions();
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Set-Cookie':cookieHeader(req,'',true),'Cache-Control':'no-store'}); return res.end(JSON.stringify({ok:true}));
  }
  // API somente servidor-servidor para o script do Roblox. A chave fica no Script do servidor do jogo e no Render.
  if (req.method === 'GET' && pathname === '/api/roblox/cdp') {
    if (!ROBLOX_CDP_API_KEY) return jsonError(res,503,'Falta configurar ROBLOX_CDP_API_KEY no Render.');
    if (!validCdpApiKey(req)) return jsonError(res,401,'Chave da API CDP inválida.');
    if (rateLimited(req,'roblox-cdp-read',1000,60*1000)) return jsonError(res,429,'Muitas consultas CDP em pouco tempo.');
    const userId = Number(url.searchParams.get('userId'));
    if (!Number.isSafeInteger(userId) || userId <= 0) return jsonError(res,400,'Informe um userId Roblox válido.');
    try {
      const profile = await findRobloxUserById(userId);
      const info = await getUserGroupRoleInfo(profile.id);
      if (info.member !== true) return jsonError(res,404,'O usuário não foi encontrado como membro do grupo EB.');
      return send(res,200,{ok:true,cdp:buildCdpProgress(profile.id,{roleId:info.roleId,roleName:info.roleName},profile.username)});
    } catch (error) { return jsonError(res,503,error.message || 'Não foi possível consultar o CDP.'); }
  }
  if (req.method === 'GET' && pathname === '/api/cdp/me') {
    const current = requireAuthenticated(req,res); if (!current) return;
    try {
      const info = await getUserGroupRoleInfo(current.session.user.id);
      if (info.member !== true) return send(res,200,{ok:true,cdp:buildCdpProgress(current.session.user.id,info,current.session.user.username)});
      return send(res,200,{ok:true,cdp:buildCdpProgress(current.session.user.id,info,current.session.user.username)});
    } catch (error) { return jsonError(res,503,error.message || 'Não foi possível consultar seu CDP.'); }
  }
  if (req.method === 'POST' && pathname === '/api/cdp/update') {
    const current = await requirePromotionPermission(req,res); if (!current) return;
    let body; try { body = await readJson(req,MAX_JSON_BYTES); } catch (error) { return jsonError(res,400,error.message); }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!validUsername(username)) return jsonError(res,400,'Digite um nome de usuário Roblox válido.');
    const rawHours = body.hoursToAdd === '' || body.hoursToAdd == null ? 0 : Number(body.hoursToAdd);
    if (!Number.isFinite(rawHours) || rawHours < 0 || rawHours > 10000) return jsonError(res,400,'Informe uma quantidade válida de horas (entre 0 e 10000).');
    const cdpStatus = ['unchanged','active','inactive'].includes(body.cdpStatus) ? body.cdpStatus : 'unchanged';
    const note = typeof body.observations === 'string' ? body.observations.trim() : '';
    if (rawHours === 0 && cdpStatus === 'unchanged' && !note) return jsonError(res,400,'Adicione horas, altere o status Em CDP ou escreva uma observação.');
    try {
      const profile = await findRobloxUser(username);
      const info = await getUserGroupRoleInfo(profile.id);
      if (info.member !== true) return jsonError(res,400,`${profile.username} não pertence ao grupo EB.`);
      const store = loadCdpStore();
      const key = String(profile.id);
      const record = store.users[key] || {userId:profile.id,username:profile.username,creditedMinutes:0,inCdp:false,updatedAt:null,history:[]};
      record.username = profile.username;
      record.creditedMinutes = Math.max(0,Number(record.creditedMinutes||0) + Math.round(rawHours*60));
      if (cdpStatus === 'active') record.inCdp = true;
      if (cdpStatus === 'inactive') record.inCdp = false;
      record.updatedAt = new Date().toISOString();
      record.history = Array.isArray(record.history) ? record.history : [];
      record.history.push({at:record.updatedAt,actorId:current.session.user.id,actor:current.session.user.username,hoursAdded:rawHours,cdpStatus,note});
      record.history = record.history.slice(-100);
      store.users[key] = record;
      saveCdpStore(store);
      return send(res,200,{ok:true,message:'Registro CDP atualizado.',cdp:buildCdpProgress(profile.id,info,profile.username)});
    } catch (error) { return jsonError(res,503,error.message || 'Não foi possível atualizar o CDP.'); }
  }
  if (req.method === 'POST' && pathname === '/api/promotions/lookup') {
    if (rateLimited(req,'promotion-lookup',40,10*60*1000)) return jsonError(res,429,'Muitas consultas seguidas. Aguarde um pouco.');
    const current = await requirePromotionPermission(req, res); if (!current) return;
    let body; try { body = await readJson(req, 12 * 1024); } catch (e) { return jsonError(res,400,e.message); }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!validUsername(username)) return jsonError(res,400,'Digite um nome de usuário Roblox válido.');
    try {
      const found = await findRobloxUser(username);
      const state = await getTargetPromotionState(found.id);
      if (state.profile.id === current.session.user.id) return jsonError(res,400,'Você não pode adicionar a própria conta como militar a ser promovido.');
      const next = state.next;
      return send(res,200,{ok:true,target:{id:state.profile.id,username:state.profile.username,displayName:state.profile.displayName,currentRole:state.info.roleName,blocked:state.info.blocked,nextRole:next?.name || null,nextRoleBlocked:!!next?.blocked}});
    } catch (e) { return jsonError(res,/API Open Cloud|Falta configurar/i.test(e.message) ? 503 : 400,e.message); }
  }
  if (req.method === 'POST' && pathname === '/api/promotions/submit') {
    if (rateLimited(req,'promotion-submit',8,10*60*1000)) return jsonError(res,429,'Limite de promoções atingido. Aguarde antes de tentar novamente.');
    const current = await requirePromotionPermission(req, res); if (!current) return;
    if (!OPEN_CLOUD_API_KEY) return jsonError(res,503,'Para promover de verdade, adicione ROBLOX_OPEN_CLOUD_API_KEY nas variáveis de ambiente do Render. A chave não deve ser colocada no código.');
    let body; try { body = await readJson(req, MAX_JSON_BYTES); } catch (e) { return jsonError(res,400,e.message); }
    const ids = Array.isArray(body.militaryIds) ? [...new Set(body.militaryIds.map(v => Number(v)).filter(v => Number.isSafeInteger(v) && v > 0))] : [];
    if (!ids.length) return jsonError(res,400,'Adicione pelo menos um militar antes de promover.');
    if (ids.length > MAX_TARGETS) return jsonError(res,400,'O intervalo global é de 30 minutos: promova apenas um militar por envio.');
    const observations = typeof body.observations === 'string' ? body.observations.trim() : '';
    if (!observations) return jsonError(res,400,'Escreva as observações do treinamento antes de promover.');
    let photo;
    try { photo = photoDataFromRequest(body.photoDataUrl); }
    catch (e) { return jsonError(res,400,e.message); }
    const batch = {id:crypto.randomUUID(),createdAt:new Date().toISOString(),promoter:{id:current.session.user.id,username:current.session.user.username,displayName:current.session.user.displayName,role:current.session.user.groupRole?.name || 'Não identificada'},observations,photoDataUrl:photo?.dataUrl || null,photoMime:photo?.mime || null,photoBytes:photo?.bytes || 0,results:[]};
    for (const userId of ids) {
      try {
        const targetState = await getTargetPromotionState(userId);
        const result = await performPromotion(current.session.user, targetState);
        batch.results.push(result);
      } catch (error) {
        let target = {userId,username:`ID ${userId}`,displayName:`ID ${userId}`};
        try { const p = await findRobloxUserById(userId); target = {userId:p.id,username:p.username,displayName:p.displayName}; } catch (_) {}
        batch.results.push({...target,status:'error',message:error.message || 'Não foi possível promover.'});
      }
    }
    try { savePromotionBatch(batch); }
    catch (error) { console.error('Erro ao salvar registro de promoção:',error.message); }
    const successCount = batch.results.filter(r => r.status === 'success').length;
    return send(res,successCount ? 200 : 400,{ok:successCount > 0,successCount,total:batch.results.length,results:batch.results.map(r=>({userId:r.userId,username:r.username,displayName:r.displayName,fromRole:r.fromRole || null,toRole:r.toRole || null,status:r.status,message:r.message})),recordSaved:true,photoAttached:!!batch.photoDataUrl});
  }
  if (req.method === 'GET' && pathname === '/api/promotions/history') {
    const current = await requirePromotionPermission(req, res); if (!current) return;
    return send(res,200,{ok:true,records:promotionHistorySummary(loadPromotionStore(),10)});
  }
  if (req.method === 'GET' && PUBLIC_ASSETS.has(pathname.slice(1)) && !pathname.slice(1).includes('/')) {
    const name = pathname.slice(1); const file = path.join(ROOT,name);
    fs.readFile(file,(err,buf)=>{ if(err)return jsonError(res,404,'Arquivo não encontrado.'); res.writeHead(200,{'Content-Type':CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream','Content-Length':buf.length,'X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=86400'}); res.end(buf); }); return;
  }
  if (req.method === 'GET' && pathname === '/robots.txt') { res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('User-agent: *\nDisallow: /painel\n'); }
  return jsonError(res,404,'Página não encontrada.');
}
const server = http.createServer((req,res)=>{route(req,res).catch(error=>{console.error('Erro interno:',error && error.message);if(!res.headersSent)jsonError(res,500,'Erro interno do servidor. Tente novamente.');else res.destroy();});});
server.listen(PORT,HOST,()=>console.log(`EB Manager rodando em http://localhost:${PORT} | Grupo EB ${GROUP_ID} | Open Cloud ${OPEN_CLOUD_API_KEY?'configurada':'não configurada'} | API CDP ${ROBLOX_CDP_API_KEY?'configurada':'não configurada'} | Sessão persistente`));
setInterval(()=>{const now=Date.now();let changed=false;for(const [id,s] of sessions){if(s.expiresAt<now){sessions.delete(id);changed=true;}}for(const [id,r] of rateLimits){if(now-r.start>30*60*1000)rateLimits.delete(id);}if(changed)savePersistedSessions();},10*60*1000).unref();
