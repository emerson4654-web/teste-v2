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
const DIVISIONS_CONFIG_PATH = path.join(ROOT, 'divisoes.json');
const CDP_STORE_PATH = path.join(DATA_DIR, 'cdp.json');
const DIVISION_HISTORY_PATH = path.join(DATA_DIR, 'historico-divisoes.json');
const TRAINING_STORE_PATH = path.join(DATA_DIR, 'treinamentos.json');
const CDE_ACCESS_ROLE_ID = '908892004';
// Acesso ao painel CGEx: [CGEx] Corregedoria OU [S-CR] Sub Criador OU [CR] Criador no grupo EB.
const CGEX_PANEL_ALLOWED_ROLE_IDS = new Set(['849818027','843780076','844132065']);
// Cargos que podem ser escolhidos no painel CGEx: Recruta até Marechal, pulando Vice Presidente e Presidente.
const CGEX_ASSIGNABLE_ROLE_IDS = [
  '843650047', // [REC] Recruta
  '843894043', // [CB] Cabo
  '843100045', // [T SGT] Terceiro Sargento
  '843328046', // [S SGT] Segundo Sargento
  '845214008', // [P-SGT] Primeiro Sargento
  '843170054', // [ST] Subtenente
  '843210093', // [CT] Cadete
  '844150047', // [ASP] Aspirante a Oficial
  '844004101', // [2 TEN] Segundo Tenente
  '843780075', // [1 TEN] Primeiro Tenente
  '845208001', // [CAP] Capitão
  '843126091', // [MAJ] Major
  '845782001', // [TEN-CEL] Tenente Coronel
  '842292095', // [CEL] Coronel
  '843750090', // [GEN-BDA] General de Brigada
  '845856000', // [GEN-DIV] General de Divisão
  '842814077', // [GEN-EX] General do Exército
  '843610097', // [EM] Elite Militar
  '845270007', // [ES] Elite Secreta
  '845586003', // [ER] Elite Real
  '843044094', // [SCMT] Sub Comandante
  '842446075', // [CMT] Comandante
  '845208002'  // [MAR] Marechal
];
const CGEX_ASSIGNABLE_ROLE_ID_SET = new Set(CGEX_ASSIGNABLE_ROLE_IDS);
const SESSION_STORE_PATH = path.join(DATA_DIR, 'sessoes.json');
const COOLDOWN_PATH = path.join(DATA_DIR, 'promocao-cooldown.json');
// Ao usar um disco persistente novo no Render, copia os dados iniciais do repositório apenas uma vez.
if (DATA_DIR !== ROOT) {
  for (const name of ['promocoes.json','cdp.json','sessoes.json','promocao-cooldown.json','historico-divisoes.json','treinamentos.json']) {
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
const divisionConfig = loadJsonFile(DIVISIONS_CONFIG_PATH, {divisions:[]});
const roleById = new Map((cargoConfig.roles || []).map(r => [String(r.id), r]));
const promotionOrder = Array.isArray(cargoConfig.promotionOrder) ? cargoConfig.promotionOrder : [];
const blockedRoleIds = new Set((cargoConfig.promotionRules?.blockedRoleIds || []).map(String));
const blockedRoleNames = (cargoConfig.promotionRules?.blockedRoleNames || []).map(normalizeName);
const baseRoleIds = new Set((cargoConfig.baseRoleIds || [12884901889]).map(String));
// Fail closed: cargos bloqueados para receber promoção NUNCA são reutilizados como promotores.
// Autorize os cargos do grupo principal explicitamente via EB_PROMOTER_ROLE_IDS no Render.
const configuredPromoterRoleIds = new Set(
  String(process.env.EB_PROMOTER_ROLE_IDS || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(String)
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
let promotionInProgress = false;
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
  // Preserve requisitos específicos de cargos alias (Vice Presidente/Presidente),
  // e só depois use a patente canônica para cargos-base/aliases sem uma linha própria.
  if (roleInfo?.roleId != null && CDP_REQUIRED_HOURS_BY_ROLE_ID.has(String(roleInfo.roleId))) return CDP_REQUIRED_HOURS_BY_ROLE_ID.get(String(roleInfo.roleId));
  const mapped = roleInfo?.roleId ? getMappedRole(roleInfo.roleId) : null;
  const canonicalId = mapped?.id ?? roleInfo?.roleId;
  if (canonicalId != null && CDP_REQUIRED_HOURS_BY_ROLE_ID.has(String(canonicalId))) return CDP_REQUIRED_HOURS_BY_ROLE_ID.get(String(canonicalId));
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
    const detail = data.message || data.errors?.[0]?.message || data.error || '';
    if (response.status === 429) throw new Error('O Roblox limitou as consultas. Aguarde um pouco e tente novamente.');
    if (isCloud && (response.status === 401 || response.status === 403)) throw new Error('A chave Open Cloud não tem autorização para esta ação. Confira a chave, as permissões group:read/group:write e se o grupo está incluído no escopo. ' + detail);
    if (isCloud && response.status === 404 && String(url).includes('/join-requests')) throw new Error('A solicitação de entrada não foi encontrada ou já foi processada. Confirme se o usuário enviou uma solicitação pendente para este grupo. ' + detail);
    if (isCloud && response.status === 404) throw new Error('A associação não foi encontrada na API Open Cloud. Confirme se o usuário já pertence ao grupo. ' + detail);
    if (response.status >= 500) throw new Error('O serviço do Roblox está temporariamente indisponível. Tente novamente.');
    throw new Error(detail || `O Roblox respondeu com erro HTTP ${response.status}.`);
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
  addRoleCandidate(candidates, membership.rolesets);
  addRoleCandidate(candidates, membership.assignedRoles);
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
    addRoleCandidate(candidates, entry.rolesets);
    addRoleCandidate(candidates, entry.assignedRoles);
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
    cdeAccess:!!user.cdeAccess, cgexAccess:!!user.cgexAccess,
    divisionPromoterCodes:Array.isArray(user.divisionPromoterCodes)?user.divisionPromoterCodes:[], canManageStaff:!!user.canManageStaff,
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

async function requireStaffPermission(req,res) {
  const current = requireAuthenticated(req,res); if (!current) return null;
  try {
    await updateUserGroupDetails(current.session.user);
    const allowed = await userCanManageStaff(current.session.user);
    if (!allowed) { jsonError(res,403,'Você não tem permissão para gerenciar CDP/treinamentos.'); return null; }
    return current;
  } catch (error) { jsonError(res,503,'Não foi possível validar suas permissões: '+error.message); return null; }
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
  // blockedRoleIds protegem quem JÁ ocupa aquele cargo. Não impedem um militar abaixo de chegar ao cargo-limite.
  return next ? {id:Number(next.id),name:next.name,index:current.index + 1,blocked:false} : null;
}
function getRolePath(id) { return `groups/${GROUP_ID}/roles/${String(id)}`; }
function membershipIdFrom(membership) {
  const match = String(membership?.path || '').match(/\/memberships\/([^/]+)$/);
  return match ? match[1] : null;
}
async function cloudAssignRoleInGroup(groupId, membershipId, roleId, action='assignRole') {
  const url = `${OPEN_CLOUD_BASE}/groups/${Number(groupId)}/memberships/${encodeURIComponent(membershipId)}:${action}`;
  return cloudFetch(url, {method:'POST',body:JSON.stringify({role:`groups/${Number(groupId)}/roles/${Number(roleId)}`})});
}
async function cloudAssignRole(membershipId, roleId, action='assignRole') {
  return cloudAssignRoleInGroup(GROUP_ID,membershipId,roleId,action);
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
  if (promotionInProgress) throw new Error('Outra promoção está sendo processada. Aguarde e tente novamente.');
  promotionInProgress = true;
  try {
    const {profile,info,current,next} = targetState;
    if (Number(profile.id) === Number(actor.id)) throw new Error('Você não pode promover a própria conta.');
    const cdpRecord = getCdpRecord(profile.id);
    if (cdpRecord.inCdp) throw new Error('Este militar está Em CDP e não pode ser promovido enquanto esse status estiver ativo.');
    const requiredHours = getRequiredCdpHours({roleId:info.roleId,roleName:info.roleName});
    const creditedHours = Math.max(0, Number(cdpRecord.creditedMinutes || 0) / 60);
    if (requiredHours != null && creditedHours < requiredHours) {
      throw new Error(`Este militar precisa completar ${formatHours(requiredHours)} hora(s) de CDP na patente atual; possui ${formatHours(creditedHours)} hora(s).`);
    }
    const cooldownRemaining = 30*60*1000 - (Date.now() - lastPromotionAt);
    if (lastPromotionAt && cooldownRemaining > 0) {
      const mins = Math.ceil(cooldownRemaining/60000);
      throw new Error(`Intervalo global de promoções ativo. Aguarde aproximadamente ${mins} minuto(s) antes de promover outra pessoa.`);
    }
    if (info.blocked || (info.roleIds || []).some(isBlockedRoleId)) throw new Error('Este militar ocupa um cargo protegido e não pode receber promoção.');
    if (!current) throw new Error(`Não consegui identificar a patente atual de ${profile.username}. Confira os cargos do grupo e o arquivo cargos_eb.json.`);
    if (!next) throw new Error(`${profile.username} já está no último cargo da sequência configurada.`);
    if (!OPEN_CLOUD_API_KEY) throw new Error('Para promover de verdade, adicione ROBLOX_OPEN_CLOUD_API_KEY nas variáveis de ambiente do Render. A chave não deve ser colocada no código.');
    const membership = info.cloudMembership || await getCloudMembership(profile.id);
    const membershipId = membershipIdFrom(membership);
    if (!membershipId) throw new Error('Não consegui localizar a associação do militar na API Open Cloud. Verifique as permissões group:read e group:write da chave.');
    await cloudAssignRole(membershipId, next.id, 'assignRole');
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
  } finally {
    promotionInProgress = false;
  }
}
function promotionHistorySummary(store, limit=8) {
  return (store.batches || []).slice(-limit).reverse().map(batch => ({
    id:batch.id,createdAt:batch.createdAt,promoter:batch.promoter,observations:batch.observations || '',
    hasPhoto:!!batch.photoDataUrl,
    results:(batch.results || []).map(result => ({userId:result.userId,username:result.username,displayName:result.displayName,fromRole:result.fromRole,toRole:result.toRole,status:result.status,message:result.message}))
  }));
}

function getDivisionByCode(code) {
  return (divisionConfig.divisions || []).find(d => String(d.code).toUpperCase() === String(code || '').toUpperCase()) || null;
}
function getDivisionByGroupId(groupId) {
  const id = Number(groupId);
  if (id === GROUP_ID) return {code:'EB',name:'Exército Brasileiro',groupId:GROUP_ID,roles:cargoConfig.roles || [],promotionOrderRoleIds:promotionOrder.map(r=>Number(r.id)),promoterRoleIds:[],cdeMaxRoleId:null,joinRoleIds:[843650047]};
  return (divisionConfig.divisions || []).find(d => Number(d.groupId) === id) || null;
}
function divisionRoleName(division, roleId) {
  return (division?.roles || []).find(r => String(r.roleId ?? r.id) === String(roleId))?.name || `Cargo ${roleId}`;
}
function divisionRoleId(role) { return String(role.roleId ?? role.id); }
function listGroupRoleIds(entry) {
  const candidates = [];
  if (entry) {
    addRoleCandidate(candidates, entry.role);
    addRoleCandidate(candidates, entry.roles);
    addRoleCandidate(candidates, entry.groupRole);
    addRoleCandidate(candidates, entry.groupRoles);
    addRoleCandidate(candidates, entry.rolesets);
    addRoleCandidate(candidates, entry.assignedRoles);
  }
  return [...new Map(candidates.map(c => [String(c.id), c])).values()];
}
async function getUserRolesInGroup(userId, groupId) {
  const response = await robloxFetch(`${GROUPS_API_BASE}/v2/users/${encodeURIComponent(userId)}/groups/roles`, {method:'GET'});
  const data = Array.isArray(response.data) ? response.data : [];
  const entry = data.find(item => Number(item.group?.id ?? item.groupId ?? item.group?.groupId) === Number(groupId)) || null;
  if (!entry) return {member:false,roleIds:[],roles:[],entry:null};
  const roles = listGroupRoleIds(entry);
  return {member:true,roleIds:roles.map(r=>String(r.id)),roles,entry,roleName:entry.role?.name || roles[0]?.name || 'Membro'};
}
async function getCloudMembershipForGroup(userId, groupId) {
  if (!OPEN_CLOUD_API_KEY) return null;
  const filter = `user == 'users/${Number(userId)}'`;
  const url = `${OPEN_CLOUD_BASE}/groups/${Number(groupId)}/memberships?filter=${encodeURIComponent(filter)}&maxPageSize=10`;
  const result = await cloudFetch(url,{method:'GET'});
  const memberships = result.groupMemberships || result.memberships || [];
  return memberships.find(m => String(m.user || '').endsWith('/' + Number(userId))) || memberships[0] || null;
}
async function getDivisionAccess(userId, division) {
  const info = await getUserRolesInGroup(userId, division.groupId);
  const allowed = new Set((division.promoterRoleIds || []).map(String));
  return {...info,canPromote:info.member && info.roleIds.some(id=>allowed.has(String(id)))};
}
async function isCdeUser(userId) {
  const info = await getUserGroupRoleInfo(userId);
  return info.member === true && (info.roleIds || []).some(id => String(id) === CDE_ACCESS_ROLE_ID);
}
async function userCanManageStaff(user) {
  if (user?.canPromote) return true;
  if (await isCdeUser(user.id)) return true;
  for (const division of (divisionConfig.divisions || [])) {
    try { const info = await getDivisionAccess(user.id,division); if (info.canPromote) return true; } catch (_) {}
  }
  return false;
}
async function requireCdePermission(req,res) {
  const current = requireAuthenticated(req,res); if (!current) return null;
  try {
    const allowed = await isCdeUser(current.session.user.id);
    if (!allowed) { jsonError(res,403,'Acesso ao painel CDE negado. É necessário ter o cargo 908892004 no grupo EB 13616747.'); return null; }
    return current;
  } catch (error) { jsonError(res,503,'Não foi possível verificar o cargo do CDE no Roblox: ' + error.message); return null; }
}
async function requireCgexPanelPermission(req,res) {
  const current = requireAuthenticated(req,res); if (!current) return null;
  try {
    // Sempre consulta os cargos atuais no Roblox; não confia apenas em um valor vindo do navegador.
    const info = await getUserGroupRoleInfo(current.session.user.id);
    const allowed = info.member === true && (info.roleIds || []).some(id => CGEX_PANEL_ALLOWED_ROLE_IDS.has(String(id)));
    if (!allowed) {
      jsonError(res,403,'Acesso ao painel CGEx negado. É necessário ter [CGEx] Corregedoria, [S-CR] Sub Criador ou [CR] Criador no grupo EB 13616747.');
      return null;
    }
    current.cgexRoleInfo = info;
    current.session.user.cgexAccess = true;
    return current;
  } catch (error) {
    jsonError(res,503,'Não foi possível verificar seu cargo para o painel CGEx: ' + error.message);
    return null;
  }
}
async function requireDivisionPermission(req,res,code) {
  const current = requireAuthenticated(req,res); if (!current) return null;
  const division = getDivisionByCode(code);
  if (!division) { jsonError(res,400,'Divisão inválida.'); return null; }
  try {
    const info = await getDivisionAccess(current.session.user.id,division);
    if (!info.canPromote) { jsonError(res,403,`Seu cargo no grupo ${division.code} não está autorizado a promover. Somente os cargos de Subcomandante até Criador configurados para essa divisão podem promover.`); return null; }
    current.division = division;
    current.divisionRoleInfo = info;
    return current;
  } catch (error) { jsonError(res,503,'Não foi possível verificar sua permissão na divisão: ' + error.message); return null; }
}
function loadArrayStore(file, prop) {
  const data = loadJsonFile(file, {[prop]:[]});
  return data && Array.isArray(data[prop]) ? data : {[prop]:[]};
}
function saveDivisionEvent(event) {
  const store = loadArrayStore(DIVISION_HISTORY_PATH,'events');
  store.events.push({...event,id:event.id || crypto.randomUUID(),createdAt:event.createdAt || new Date().toISOString()});
  store.events = store.events.slice(-2000);
  persistJson(DIVISION_HISTORY_PATH,store);
}
function loadTrainingStore() { return loadArrayStore(TRAINING_STORE_PATH,'events'); }
function saveTrainingEvent(event) {
  const store = loadTrainingStore();
  store.events.push({...event,id:event.id || crypto.randomUUID(),createdAt:event.createdAt || new Date().toISOString()});
  store.events = store.events.slice(-10000);
  persistJson(TRAINING_STORE_PATH,store);
}
function trainingRanking() {
  const store = loadTrainingStore(), grouped = new Map();
  for (const e of store.events) {
    const key = String(e.userId);
    const current = grouped.get(key) || {userId:Number(e.userId),username:e.username || `ID ${e.userId}`,count:0,lastTrainingAt:null};
    current.count++;
    if (!current.lastTrainingAt || String(e.createdAt) > current.lastTrainingAt) current.lastTrainingAt = e.createdAt;
    grouped.set(key,current);
  }
  return [...grouped.values()].sort((a,b)=>b.count-a.count || String(a.username).localeCompare(String(b.username))).map((item,i)=>({...item,position:i+1}));
}
function extractIdFromResource(value, expected) {
  if (value && typeof value === 'object') value = value.path || value.id || value.name || '';
  const raw = String(value || '');
  const m = expected ? raw.match(new RegExp(`(?:^|/)${expected}/([^/]+)$`)) : null;
  return (m ? m[1] : (/^[A-Za-z0-9_-]+$/.test(raw) ? raw : null));
}
function parseJoinRequestUserId(item) {
  const userValue = item?.user?.path || item?.user?.id || item?.user?.name || item?.user || item?.userId || item?.pathUser || '';
  const match = String(userValue).match(/(?:^|\/)users\/(\d+)(?:$|\/)|^(\d+)$/);
  if (match) return Number(match[1] || match[2]);
  const numeric = Number(userValue);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}
function parseJoinRequestId(item, userId) {
  const candidates = [item?.path, item?.name, item?.id, item?.joinRequestId, item?.requestId];
  for (const candidate of candidates) {
    const raw = String(candidate || '');
    const pathMatch = raw.match(/join-requests\/([^/?]+)$/i) || raw.match(/joinRequests\/([^/?]+)$/i);
    if (pathMatch && /^[A-Za-z0-9_-]+$/.test(pathMatch[1])) return pathMatch[1];
    if (/^\d+$/.test(raw)) return raw;
  }
  // Na Open Cloud, o ID do pedido é o ID do utilizador que pediu entrada.
  return userId ? String(userId) : '';
}
async function listJoinRequestsForGroup(groupId) {
  const mapped = [];
  const seen = new Set();
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({maxPageSize:'100'});
    if (pageToken) params.set('pageToken', pageToken);
    const result = await cloudFetch(`${OPEN_CLOUD_BASE}/groups/${Number(groupId)}/join-requests?${params.toString()}`, {method:'GET'});
    const requests = Array.isArray(result.groupJoinRequests) ? result.groupJoinRequests
      : Array.isArray(result.joinRequests) ? result.joinRequests
      : Array.isArray(result.requests) ? result.requests
      : Array.isArray(result.data?.groupJoinRequests) ? result.data.groupJoinRequests : [];
    for (const item of requests) {
      const userId = parseJoinRequestUserId(item);
      const requestId = parseJoinRequestId(item, userId);
      if (!requestId || seen.has(String(requestId))) continue;
      seen.add(String(requestId));
      let profile = {id:userId,username:userId ? `ID ${userId}` : 'Usuário pendente',displayName:userId ? `ID ${userId}` : 'Usuário pendente'};
      if (userId) { try { profile = await findRobloxUserById(userId); } catch (_) {} }
      mapped.push({requestId:String(requestId),userId:profile.id || userId,username:profile.username,displayName:profile.displayName,createdAt:item.createTime || item.createdAt || null,rawPath:item.path || item.name || null});
      if (mapped.length >= 500) break;
    }
    if (mapped.length >= 500) break;
    pageToken = String(result.nextPageToken || result.nextPageCursor || '');
    if (!pageToken) break;
  }
  return mapped.filter(r=>r.requestId && Number(r.userId)>0);
}
async function findPendingJoinRequestByUsername(groupId, username) {
  const profile = await findRobloxUser(username);
  const requests = await listJoinRequestsForGroup(groupId);
  const request = requests.find(r => Number(r.userId) === Number(profile.id) || String(r.username).toLowerCase() === profile.username.toLowerCase());
  if (!request) throw new Error(`${profile.username} ainda não tem uma solicitação pendente para este grupo. Peça para a pessoa abrir o grupo Roblox e clicar em Entrar primeiro.`);
  return {profile,request};
}
async function applyJoinNomenclature(groupId, userId, roleId) {
  const gid = Number(groupId), uid = Number(userId), rid = Number(roleId);
  let membership = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try { membership = await getCloudMembershipForGroup(uid, gid); } catch (_) {}
    if (membership) break;
    await new Promise(resolve => setTimeout(resolve, 650));
  }
  if (!membership) throw new Error('A pessoa foi aceita, mas a associação ainda não apareceu na Open Cloud para aplicar a nomenclatura. Recarregue o painel e confira o cargo em alguns segundos.');
  const membershipId = membershipIdFrom(membership);
  if (!membershipId) throw new Error('A pessoa foi aceita, mas não consegui obter o ID da associação para aplicar a nomenclatura.');
  const desiredPath = `groups/${gid}/roles/${rid}`;
  const rawRoles = [];
  const pushRolePath = value => {
    const path = typeof value === 'string' ? value : value?.path || value?.name || value?.id || '';
    const m = String(path).match(/groups\/(\d+)\/roles\/(\d+)/);
    if (m && Number(m[1]) === gid) rawRoles.push({id:Number(m[2]),path:String(path)});
  };
  pushRolePath(membership.role);
  for (const role of (Array.isArray(membership.roles) ? membership.roles : [])) pushRolePath(role);
  await cloudAssignRoleInGroup(gid, membershipId, rid, 'assignRole');
  const oldIds = [...new Set(rawRoles.map(r=>r.id).filter(id=>id !== rid))];
  for (const oldId of oldIds) {
    try { await cloudAssignRoleInGroup(gid, membershipId, oldId, 'unassignRole'); } catch (_) {}
  }
  return {roleId:rid,roleName:divisionRoleName(getDivisionByGroupId(gid),rid),membershipId,desiredPath};
}
async function requireGroupRequestPermission(req,res,groupId) {
  const current = requireAuthenticated(req,res); if (!current) return null;
  const group = getDivisionByGroupId(groupId);
  if (!group) { jsonError(res,400,'Grupo não cadastrado em divisoes.json ou grupo EB principal inválido.'); return null; }
  try {
    if (await isCdeUser(current.session.user.id)) return {current,group,canCde:true};
    if (Number(groupId) === GROUP_ID) { jsonError(res,403,'Somente CDE pode gerenciar solicitações do grupo principal.'); return null; }
    const division = getDivisionByCode(group.code);
    if (!division) { jsonError(res,403,'Somente CDE pode gerenciar solicitações deste grupo.'); return null; }
    const access = await getDivisionAccess(current.session.user.id,division);
    if (!access.canPromote) { jsonError(res,403,'Você não tem permissão para gerenciar solicitações deste grupo.'); return null; }
    return {current,group,canCde:false};
  } catch (error) { jsonError(res,503,'Não foi possível confirmar permissões: ' + error.message); return null; }
}
async function assignRoleToUserInGroup(userId, groupId, roleId) {
  const membership = await getCloudMembershipForGroup(userId,groupId);
  const membershipId = membershipIdFrom(membership);
  if (!membershipId) throw new Error('Não consegui localizar a associação do usuário ao grupo na Open Cloud. Confira group:read e group:write.');
  const rolePath = `groups/${Number(groupId)}/roles/${Number(roleId)}`;
  const assigned = await cloudAssignRoleInGroup(groupId,membershipId,roleId,'assignRole');
  return {membership,assigned,rolePath};
}
async function promoteInDivision(actor, targetUsername, division) {
  if (promotionInProgress) throw new Error('Outra promoção está sendo processada. Aguarde e tente novamente.');
  promotionInProgress = true;
  try {
    if (!OPEN_CLOUD_API_KEY) throw new Error('Falta configurar ROBLOX_OPEN_CLOUD_API_KEY no Render para alterar cargos de verdade.');
    const profile = await findRobloxUser(targetUsername);
    if (profile.id === Number(actor.id)) throw new Error('Você não pode promover a própria conta.');
    const cdp = getCdpRecord(profile.id);
    if (cdp.inCdp) throw new Error(`${profile.username} está Em CDP e não pode receber promoção.`);
    const cooldownRemaining = 30*60*1000 - (Date.now()-lastPromotionAt);
    if (lastPromotionAt && cooldownRemaining > 0) throw new Error(`O intervalo global está ativo. Aguarde ${Math.ceil(cooldownRemaining/60000)} minuto(s).`);
    const membershipInfo = await getUserRolesInGroup(profile.id,division.groupId);
    if (!membershipInfo.member) throw new Error(`${profile.username} ainda não é membro de ${division.code}.`);
    const order = (division.promotionOrderRoleIds || []).map(String);
    const currentRoles = membershipInfo.roleIds.filter(id=>order.includes(String(id)));
    if (!currentRoles.length) throw new Error(`Não consegui identificar o cargo atual de ${profile.username} em ${division.code}.`);
    const currentId = currentRoles.sort((a,b)=>order.indexOf(a)-order.indexOf(b)).at(-1);
    if (!(division.promotionOrderRoleIds || []).map(Number).some(id=>Number(id)===Number(currentId))) throw new Error('A patente atual não consta na sequência de promoção configurada.');
    const currentIndex = order.indexOf(currentId);
    const nextId = order[currentIndex+1];
    if (!nextId) throw new Error(`${profile.username} já está no último cargo configurado de ${division.code}.`);
    const membership = await getCloudMembershipForGroup(profile.id,division.groupId);
    const membershipId = membershipIdFrom(membership);
    if (!membershipId) throw new Error('Não consegui localizar a associação na Open Cloud. Confira permissões para esse grupo.');
    await cloudAssignRoleInGroup(division.groupId,membershipId,nextId,'assignRole');
    const assigned = Array.isArray(membership?.roles) ? membership.roles : [];
    const oldPath = `groups/${division.groupId}/roles/${currentId}`;
    if (assigned.includes(oldPath)) {
      try { await cloudAssignRoleInGroup(division.groupId,membershipId,currentId,'unassignRole'); }
      catch (error) { try { await cloudAssignRoleInGroup(division.groupId,membershipId,nextId,'unassignRole'); } catch (_) {} throw new Error('Não consegui remover o cargo anterior; a nova atribuição foi revertida quando possível. ' + error.message); }
    }
    lastPromotionAt = Date.now(); persistJson(COOLDOWN_PATH,{lastPromotionAt,updatedAt:new Date(lastPromotionAt).toISOString()});
    const result = {userId:profile.id,username:profile.username,displayName:profile.displayName,division:division.code,groupId:division.groupId,fromRole:divisionRoleName(division,currentId),toRole:divisionRoleName(division,nextId),fromRoleId:Number(currentId),toRoleId:Number(nextId),status:'success'};
    saveDivisionEvent({kind:'promotion',actorId:actor.id,actor:actor.username,division:division.code,groupId:division.groupId,...result});
    return result;
  } finally {
    promotionInProgress = false;
  }
}
async function refreshAccessInfo(user) {
  try {
    user.cdeAccess = (user._roleIds || []).some(id=>String(id)===CDE_ACCESS_ROLE_ID);
    user.cgexAccess = (user._roleIds || []).some(id=>CGEX_PANEL_ALLOWED_ROLE_IDS.has(String(id)));
  } catch (_) { user.cdeAccess = false; user.cgexAccess = false; }
  const codes=[];
  for (const division of (divisionConfig.divisions || [])) {
    try { const info = await getDivisionAccess(user.id,division); if (info.canPromote) codes.push(division.code); } catch (_) {}
  }
  user.divisionPromoterCodes = codes;
  user.canManageStaff = !!user.canPromote || !!user.cdeAccess || codes.length > 0;
  return user;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost'); const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/healthz') return send(res,200,{ok:true,service:'EB Manager',groupId:GROUP_ID});
  if (req.method === 'GET' && pathname === '/') { getSession(req, res); return sendFile(res, 'index.html'); }
  if (req.method === 'GET' && (pathname === '/painel' || pathname === '/dashboard')) {
    const current = requireSession(req, res);
    if (!current || !current.session.authenticated || !current.session.user) { res.writeHead(302,{Location:'/','Cache-Control':'no-store'}); return res.end(); }
    return sendFile(res, 'dashboard.html');
  }
  if (req.method === 'GET' && pathname === '/api/me') {
    const current = requireAuthenticated(req, res); if (!current) return;
    try { await updateUserGroupDetails(current.session.user); await refreshAccessInfo(current.session.user); }
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
      try { await updateUserGroupDetails(current.session.user); await refreshAccessInfo(current.session.user); }
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
    const current = await requireStaffPermission(req,res); if (!current) return;
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
      const cdp = getCdpRecord(state.profile.id);
      const requiredHours = getRequiredCdpHours({roleId:state.info.roleId,roleName:state.info.roleName});
      const hoursCompleted = Math.max(0, Number(cdp.creditedMinutes || 0) / 60);
      return send(res,200,{ok:true,target:{id:state.profile.id,username:state.profile.username,displayName:state.profile.displayName,currentRole:state.info.roleName,blocked:state.info.blocked,inCdp:!!cdp.inCdp,hoursCompleted:Number(hoursCompleted.toFixed(2)),hoursRequired:requiredHours,hoursMet:requiredHours==null || hoursCompleted>=requiredHours,nextRole:next?.name || null,nextRoleBlocked:!!next?.blocked}});
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
        // Uma promoção concluída por este formulário também conta como um treinamento no Ranking.
        if (result.status === 'success') {
          try {
            saveTrainingEvent({
              userId: result.userId,
              username: result.username,
              displayName: result.displayName,
              trainingName: 'Treinamento para promoção de patente',
              observations,
              actorId: current.session.user.id,
              actor: current.session.user.username,
              source: 'site-promotion',
              promotionBatchId: batch.id,
              photoAttached: !!photo?.dataUrl,
              createdAt: batch.createdAt
            });
          } catch (trainingError) {
            console.error('A promoção foi concluída, mas o treinamento não entrou no ranking:', trainingError.message);
          }
        }
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
    const current = requireAuthenticated(req, res); if (!current) return;
    return send(res,200,{ok:true,records:promotionHistorySummary(loadPromotionStore(),10)});
  }

  if (req.method === 'GET' && pathname === '/api/divisions/config') {
    const current = requireAuthenticated(req,res); if (!current) return;
    const divisions = (divisionConfig.divisions||[]).map(d=>({code:d.code,name:d.name,groupId:d.groupId,roles:d.roles.map(r=>({roleId:Number(r.roleId ?? r.id),name:r.name,rank:Number(r.rank||0)})),joinRoleIds:(d.joinRoleIds||[]).map(Number),promoterRoleIds:d.promoterRoleIds||[],promotionOrderRoleIds:d.promotionOrderRoleIds||[],cdeMaxRoleId:d.cdeMaxRoleId,cdeMaxRoleName:divisionRoleName(d,d.cdeMaxRoleId)}));
    const mainGroup = {code:'EB',name:'Exército Brasileiro',groupId:GROUP_ID,roles:(cargoConfig.roles||[]).map(r=>({roleId:Number(r.id ?? r.roleId),name:r.name,rank:Number(r.rank||0)})),joinRoleIds:[843650047]};
    return send(res,200,{ok:true,mainGroup,divisions});
  }
  if (req.method === 'GET' && pathname === '/api/hierarchy') {
    const current = requireAuthenticated(req,res); if (!current) return;
    const mainRoles = (cargoConfig.roles||[]).map((r,i)=>({groupId:GROUP_ID,groupName:'Exército Brasileiro',roleId:Number(r.id),name:r.name,rank:Number(r.rank||0),sourceOrder:i+1,usedForPromotionOrder:promotionOrder.some(p=>Number(p.id)===Number(r.id)||(p.aliasRoleIds||[]).map(Number).includes(Number(r.id)))}));
    const divisions = (divisionConfig.divisions||[]).map(d=>({code:d.code,name:d.name,groupId:d.groupId,roles:d.roles.map(r=>({roleId:Number(r.roleId),name:r.name,rank:Number(r.rank||0)}))}));
    return send(res,200,{ok:true,groupId:GROUP_ID,mainRoles,divisions});
  }
  if (req.method === 'GET' && pathname === '/api/divisions/history') {
    const current = requireAuthenticated(req,res); if (!current) return;
    const store = loadArrayStore(DIVISION_HISTORY_PATH,'events');
    return send(res,200,{ok:true,events:store.events.slice(-200).reverse()});
  }
  if (req.method === 'POST' && pathname === '/api/divisions/promote') {
    const body = await readJson(req,MAX_JSON_BYTES).catch(e=>({__error:e.message}));
    if (body.__error) return jsonError(res,400,body.__error);
    const division = getDivisionByCode(body.division);
    if (!division) return jsonError(res,400,'Selecione uma divisão válida.');
    const current = await requireDivisionPermission(req,res,division.code); if (!current) return;
    const username = typeof body.username==='string' ? body.username.trim() : '';
    if (!validUsername(username)) return jsonError(res,400,'Digite um nome de usuário Roblox válido.');
    try {
      const result = await promoteInDivision(current.session.user,username,division);
      return send(res,200,{ok:true,result,message:`${result.username} foi promovido de ${result.fromRole} para ${result.toRole} em ${division.code}.`});
    } catch (error) { return jsonError(res,/Open Cloud|Falta configurar|Não consegui localizar a associação/i.test(error.message)?503:400,error.message); }
  }
  if (req.method === 'GET' && pathname === '/api/cgex/config') {
    const current = await requireCgexPanelPermission(req,res); if (!current) return;
    const roles = CGEX_ASSIGNABLE_ROLE_IDS.map((id, index) => {
      const item = roleById.get(String(id));
      return item ? {roleId:Number(id),name:item.name,position:index+1} : null;
    }).filter(Boolean);
    if (roles.length !== CGEX_ASSIGNABLE_ROLE_IDS.length) return jsonError(res,503,'Alguns cargos permitidos do painel CGEx não estão cadastrados em cargos_eb.json. Atualize esse arquivo antes de usar o painel.');
    return send(res,200,{ok:true,groupId:GROUP_ID,groupName:'Exército Brasileiro',roles,apiConfigured:!!OPEN_CLOUD_API_KEY});
  }
  if (req.method === 'POST' && pathname === '/api/cgex/assign-role') {
    const current = await requireCgexPanelPermission(req,res); if (!current) return;
    if (!OPEN_CLOUD_API_KEY) return jsonError(res,503,'Falta configurar ROBLOX_OPEN_CLOUD_API_KEY no Render com permissão group:write para o grupo EB.');
    let body; try { body = await readJson(req,MAX_JSON_BYTES); } catch (e) { return jsonError(res,400,e.message); }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const roleId = String(body.roleId || '');
    if (!validUsername(username)) return jsonError(res,400,'Digite o nome de usuário Roblox exato, sem @.');
    if (!CGEX_ASSIGNABLE_ROLE_ID_SET.has(roleId)) return jsonError(res,400,'Selecione uma patente permitida entre Recruta e Marechal. Vice Presidente e Presidente são pulados.');
    if (promotionInProgress) return jsonError(res,429,'Outra alteração de patente está em andamento. Tente novamente em instantes.');
    const remaining = 30 * 60 * 1000 - (Date.now() - lastPromotionAt);
    if (lastPromotionAt && remaining > 0) return jsonError(res,429,`Intervalo global de promoções ativo. Aguarde aproximadamente ${Math.ceil(remaining/60000)} minuto(s).`);
    promotionInProgress = true;
    try {
      const actor = current.session.user;
      const target = await findRobloxUser(username);
      if (Number(target.id) === Number(actor.id)) return jsonError(res,400,'Você não pode alterar a própria patente por este painel.');
      const targetInfo = await getUserGroupRoleInfo(target.id);
      if (targetInfo.member !== true) return jsonError(res,400,`${target.username} não pertence ao grupo Exército Brasileiro (${GROUP_ID}).`);
      const cdp = getCdpRecord(target.id);
      if (cdp.inCdp) return jsonError(res,403,`${target.username} está Em CDP e não pode receber alteração de patente enquanto esse status estiver ativo.`);
      const role = roleById.get(roleId);
      if (!role) return jsonError(res,503,'A patente selecionada não está no arquivo cargos_eb.json.');
      const cloudMembership = await getCloudMembershipForGroup(target.id,GROUP_ID);
      const membershipId = membershipIdFrom(cloudMembership);
      if (!membershipId) throw new Error('Não consegui localizar a associação do militar na Open Cloud. Confira se ele pertence ao grupo EB e se a chave tem group:read/group:write.');

      const cloudRoleIds = getMembershipRoleCandidates(cloudMembership).map(r=>String(r.id));
      const existingRoleIds = [...new Set([...(targetInfo.roleIds || []).map(String), ...cloudRoleIds])];
      const oldRankIds = existingRoleIds.filter(id => CGEX_ASSIGNABLE_ROLE_ID_SET.has(id) && id !== roleId);
      const alreadyHasTarget = existingRoleIds.includes(roleId);
      if (alreadyHasTarget && oldRankIds.length === 0) {
        return send(res,200,{ok:true,alreadyAssigned:true,message:`${target.username} já possui o cargo ${role.name}. Nenhuma alteração foi necessária.`});
      }

      let assignedNewRole = false;
      try {
        if (!alreadyHasTarget) {
          await cloudAssignRoleInGroup(GROUP_ID,membershipId,Number(roleId),'assignRole');
          assignedNewRole = true;
        }
        for (const oldRoleId of oldRankIds) {
          await cloudAssignRoleInGroup(GROUP_ID,membershipId,Number(oldRoleId),'unassignRole');
        }
      } catch (changeError) {
        if (assignedNewRole) {
          try { await cloudAssignRoleInGroup(GROUP_ID,membershipId,Number(roleId),'unassignRole'); } catch (_) {}
        }
        throw new Error('Não consegui concluir a troca da patente. Confira se a chave Open Cloud pode atribuir e remover cargos abaixo do seu maior cargo. ' + changeError.message);
      }

      const now = Date.now();
      lastPromotionAt = now;
      persistJson(COOLDOWN_PATH,{lastPromotionAt,updatedAt:new Date(now).toISOString(),source:'cgex'});
      const fromRoles = oldRankIds.map(id=>roleById.get(id)?.name || `Cargo ${id}`);
      const previousRoleText = fromRoles.join(', ') || (targetInfo.roleName || 'Cargo anterior não identificado');
      saveDivisionEvent({
        kind:'cgex-role-assigned', groupName:'Exército Brasileiro', division:'CGEx', groupId:GROUP_ID,
        actorId:actor.id, actor:actor.username, targetId:target.id, targetUsername:target.username,
        fromRole:previousRoleText, toRole:role.name, roleId:Number(roleId), roleName:role.name, createdAt:new Date(now).toISOString()
      });
      try {
        savePromotionBatch({
          id:crypto.randomUUID(), createdAt:new Date(now).toISOString(), promoter:{userId:actor.id,username:actor.username},
          observations:'Atribuição manual de patente pelo painel CGEx.', hasPhoto:false,
          results:[{userId:target.id,username:target.username,displayName:target.displayName,fromRole:previousRoleText,toRole:role.name,status:'success',message:'Patente atribuída pelo painel CGEx.'}],
          source:'cgex'
        });
      } catch (historyError) { console.error('A patente foi alterada, mas não consegui salvar o histórico de patentes:',historyError.message); }
      return send(res,200,{ok:true,message:`Patente de ${target.username} alterada para ${role.name}.`,target:{userId:target.id,username:target.username},fromRoles,toRole:role.name,roleId:Number(roleId)});
    } catch (error) {
      const detail = String(error.message || error);
      const status = /ROBLOX_OPEN_CLOUD_API_KEY|Open Cloud|permissão|associação/i.test(detail) ? 503 : /conectar|temporariamente|limitou/i.test(detail) ? 503 : 400;
      return jsonError(res,status,detail);
    } finally {
      promotionInProgress = false;
    }
  }
  if (req.method === 'POST' && pathname === '/api/cde/assign-role') {
    const current = await requireCdePermission(req,res); if (!current) return;
    if (!OPEN_CLOUD_API_KEY) return jsonError(res,503,'Falta configurar ROBLOX_OPEN_CLOUD_API_KEY no Render.');
    let body; try { body=await readJson(req,MAX_JSON_BYTES); } catch(e) { return jsonError(res,400,e.message); }
    const division=getDivisionByCode(body.division);
    const username=typeof body.username==='string'?body.username.trim():'';
    const roleId=String(body.roleId||'');
    if (!division) return jsonError(res,400,'Selecione uma divisão válida.');
    if (!validUsername(username)) return jsonError(res,400,'Digite um nome de usuário Roblox válido.');
    const allowed=division.roles.filter(r=>division.promotionOrderRoleIds.map(String).includes(String(r.roleId)) && division.promotionOrderRoleIds.indexOf(Number(r.roleId)) <= division.promotionOrderRoleIds.indexOf(Number(division.cdeMaxRoleId)));
    const targetRole=division.roles.find(r=>String(r.roleId)===roleId);
    if (!targetRole || !allowed.some(r=>String(r.roleId)===roleId)) return jsonError(res,403,'O CDE pode atribuir apenas cargos até Dono, inclusive, nessa divisão.');
    if (promotionInProgress) return jsonError(res,429,'Outra promoção está sendo processada. Tente novamente após alguns instantes.');
    const cdeCooldownRemaining = 30*60*1000 - (Date.now()-lastPromotionAt);
    if (lastPromotionAt && cdeCooldownRemaining > 0) return jsonError(res,429,`Intervalo global de promoção ativo. Aguarde aproximadamente ${Math.ceil(cdeCooldownRemaining/60000)} minuto(s).`);
    promotionInProgress = true;
    try {
      const profile=await findRobloxUser(username);
      const membershipInfo=await getUserRolesInGroup(profile.id,division.groupId);
      if (!membershipInfo.member) return jsonError(res,400,`${profile.username} ainda não pertence ao grupo ${division.code}. Use Aceitar solicitações para aprovar uma solicitação pendente primeiro.`);
      const allowedOrder=(division.promotionOrderRoleIds||[]).map(Number);
      const maxRoleIndex=allowedOrder.indexOf(Number(division.cdeMaxRoleId));
      const existingRoles=membershipInfo.roleIds.map(id=>({id:String(id),rank:Number(division.roles.find(r=>String(r.roleId)===String(id))?.rank ?? 0),index:allowedOrder.indexOf(Number(id))}));
      if (existingRoles.some(r=>r.rank>=254 || r.index>maxRoleIndex)) return jsonError(res,403,'Este militar já possui um cargo acima do limite que o CDE pode atribuir.');
      const targetCdp=getCdpRecord(profile.id);
      if (targetCdp.inCdp) return jsonError(res,403,'Este militar está Em CDP e não pode receber promoção.');
      const cloudMembership=await getCloudMembershipForGroup(profile.id,division.groupId);
      const membershipId=membershipIdFrom(cloudMembership);
      if (!membershipId) throw new Error('A associação não foi localizada na Open Cloud. Confirme as permissões para o grupo.');
      await cloudAssignRoleInGroup(division.groupId,membershipId,Number(roleId),'assignRole');
      const currentIds=membershipInfo.roleIds.filter(id=>division.promotionOrderRoleIds.map(String).includes(String(id)) && String(id)!==roleId);
      for (const oldRoleId of currentIds) {
        const path=`groups/${division.groupId}/roles/${oldRoleId}`;
        const cloudRoles=Array.isArray(cloudMembership?.roles)?cloudMembership.roles:[];
        if (cloudRoles.includes(path)) { try { await cloudAssignRoleInGroup(division.groupId,membershipId,Number(oldRoleId),'unassignRole'); } catch (_) {} }
      }
      lastPromotionAt = Date.now(); persistJson(COOLDOWN_PATH,{lastPromotionAt,updatedAt:new Date(lastPromotionAt).toISOString()});
      saveDivisionEvent({kind:'cde-role-assigned',actorId:current.session.user.id,actor:current.session.user.username,targetId:profile.id,targetUsername:profile.username,division:division.code,groupId:division.groupId,roleId:Number(roleId),roleName:targetRole.name});
      return send(res,200,{ok:true,message:`Cargo ${targetRole.name} atribuído a ${profile.username} em ${division.code}.`});
    } catch(error) { return jsonError(res,/Open Cloud|Falta configurar|associação/i.test(error.message)?503:400,error.message); }
    finally { promotionInProgress = false; }
  }
  if (req.method === 'GET' && pathname === '/api/groups/join-requests') {
    const groupId=Number(url.searchParams.get('groupId'));
    if (!Number.isSafeInteger(groupId)||groupId<=0) return jsonError(res,400,'Informe groupId válido.');
    const access=await requireGroupRequestPermission(req,res,groupId); if(!access)return;
    if (!OPEN_CLOUD_API_KEY) return jsonError(res,503,'Falta configurar ROBLOX_OPEN_CLOUD_API_KEY no Render.');
    try { const requests=await listJoinRequestsForGroup(groupId); return send(res,200,{ok:true,groupId,groupName:access.group.name,requests}); }
    catch(error) { return jsonError(res,503,'Não foi possível carregar solicitações: '+error.message); }
  }
  if (req.method === 'POST' && pathname === '/api/groups/join-requests/decision') {
    let body; try { body=await readJson(req,64*1024); } catch(e) { return jsonError(res,400,e.message); }
    const groupId=Number(body.groupId), decision=String(body.decision||'');
    let requestId=String(body.requestId||'').trim();
    const username=String(body.username||'').trim();
    const requestedRoleId=String(body.roleId||'').trim();
    if (!Number.isSafeInteger(groupId)||groupId<=0||!['accept','decline'].includes(decision)||(!requestId&&!username)) return jsonError(res,400,'Informe o grupo e o nome de usuário ou ID de solicitação, além de escolher aceitar ou recusar.');
    const access=await requireGroupRequestPermission(req,res,groupId); if(!access)return;
    if (!OPEN_CLOUD_API_KEY) return jsonError(res,503,'Falta configurar ROBLOX_OPEN_CLOUD_API_KEY no Render com permissões group:read e group:write nos grupos corretos.');
    let targetProfile = null;
    try {
      let pending = null;
      if (username) {
        if (!validUsername(username)) return jsonError(res,400,'Digite o nome de usuário Roblox exato, sem @ e não o nome de exibição.');
        const found = await findPendingJoinRequestByUsername(groupId, username);
        targetProfile = found.profile;
        pending = found.request;
        requestId = String(pending.requestId);
      } else {
        if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return jsonError(res,400,'ID de solicitação inválido.');
        // O ID do pedido na Open Cloud geralmente é o userId. Tentamos enriquecer o registro se ainda estiver pendente.
        try {
          const requests = await listJoinRequestsForGroup(groupId);
          pending = requests.find(r=>String(r.requestId)===requestId);
          if (!pending && decision === 'accept') return jsonError(res,409,'Essa solicitação não aparece mais como pendente. Atualize a lista e tente novamente.');
          if (pending) targetProfile = {id:Number(pending.userId),username:pending.username,displayName:pending.displayName};
        } catch (_) { /* A ação ainda será validada pelo endpoint de decisão da Open Cloud. */ }
      }
      let selectedJoinRoleId = 0;
      const allowedRoleIds = (access.group.joinRoleIds || []).map(Number).filter(Number.isSafeInteger);
      if (decision === 'accept') {
        selectedJoinRoleId = requestedRoleId ? Number(requestedRoleId) : Number(allowedRoleIds[0] || 0);
        if (!Number.isSafeInteger(selectedJoinRoleId) || !allowedRoleIds.includes(selectedJoinRoleId)) {
          return jsonError(res,400,'Escolha uma nomenclatura de entrada válida para este grupo. Confira joinRoleIds em divisoes.json.');
        }
      }
      const action=decision==='accept'?'accept':'decline';
      await cloudFetch(`${OPEN_CLOUD_BASE}/groups/${groupId}/join-requests/${encodeURIComponent(requestId)}:${action}`,{method:'POST',body:JSON.stringify({})});
      let nomenclatureMessage = '';
      let appliedRole = null;
      if (decision === 'accept' && targetProfile?.id && selectedJoinRoleId) {
        try {
          appliedRole = await applyJoinNomenclature(groupId, targetProfile.id, selectedJoinRoleId);
          nomenclatureMessage = ` Nomenclatura aplicada: ${appliedRole.roleName}.`;
        } catch (roleError) {
          nomenclatureMessage = ` A pessoa foi aceita, mas não consegui aplicar a nomenclatura automaticamente: ${roleError.message}`;
        }
      }
      saveDivisionEvent({kind:`join-request-${decision}`,actorId:access.current.session.user.id,actor:access.current.session.user.username,groupId,groupName:access.group.name,requestId,decision,targetId:targetProfile?.id||null,targetUsername:targetProfile?.username||username||null,roleId:appliedRole?.roleId||null,roleName:appliedRole?.roleName||null});
      const baseMessage = decision==='accept'?'Solicitação aceita.':'Solicitação recusada.';
      return send(res,200,{ok:true,message:baseMessage+nomenclatureMessage,requestId,userId:targetProfile?.id||null,username:targetProfile?.username||username||null,roleId:appliedRole?.roleId||null,roleName:appliedRole?.roleName||null});
    } catch(error) {
      const detail = String(error.message || error);
      const code = /permiss|Open Cloud|ROBLOX_OPEN_CLOUD_API_KEY|conectar à API/i.test(detail) ? 503 : /solicitação pendente|não tem uma solicitação/i.test(detail) ? 404 : 400;
      return jsonError(res,code,'Não consegui concluir a ação no grupo '+access.group.name+': '+detail);
    }
  }
  if (req.method === 'GET' && pathname === '/api/ranking') {
    const current = requireAuthenticated(req,res); if (!current) return;
    return send(res,200,{ok:true,ranking:trainingRanking(),updatedAt:new Date().toISOString(),totalTrainings:loadTrainingStore().events.length});
  }
  if (req.method === 'POST' && pathname === '/api/trainings/record') {
    const current=requireAuthenticated(req,res); if(!current)return;
    try { await updateUserGroupDetails(current.session.user); await refreshAccessInfo(current.session.user); }
    catch (_) { return jsonError(res,503,'Não foi possível atualizar suas permissões.'); }
    if (!(await userCanManageStaff(current.session.user))) return jsonError(res,403,'Você não tem permissão para registrar treinamentos.');
    let body; try { body=await readJson(req,MAX_JSON_BYTES); } catch(e) { return jsonError(res,400,e.message); }
    const username=typeof body.username==='string'?body.username.trim():'';
    const observations=typeof body.observations==='string'?body.observations.trim():'';
    const trainingName=typeof body.trainingName==='string'?body.trainingName.trim():'Treinamento';
    if(!validUsername(username)) return jsonError(res,400,'Digite um nome de usuário Roblox válido.');
    try {
      const profile=await findRobloxUser(username);
      const info=await getUserGroupRoleInfo(profile.id);
      if(info.member!==true) return jsonError(res,400,`${profile.username} não pertence ao grupo EB.`);
      const event={userId:profile.id,username:profile.username,displayName:profile.displayName,trainingName,observations,actorId:current.session.user.id,actor:current.session.user.username,source:'site',createdAt:new Date().toISOString()};
      saveTrainingEvent(event);
      return send(res,200,{ok:true,message:`Treinamento registrado para ${profile.username}.`,event,ranking:trainingRanking()});
    } catch(error) { return jsonError(res,503,error.message); }
  }
  if (req.method === 'POST' && pathname === '/api/roblox/trainings') {
    if (!ROBLOX_CDP_API_KEY) return jsonError(res,503,'Falta configurar ROBLOX_CDP_API_KEY no Render.');
    if (!validCdpApiKey(req)) return jsonError(res,401,'Chave da API de treinamento inválida.');
    let body; try { body=await readJson(req,64*1024); } catch(e) { return jsonError(res,400,e.message); }
    const userId=Number(body.userId), trainingName=typeof body.trainingName==='string'?body.trainingName.trim():'Treinamento Roblox', observations=typeof body.observations==='string'?body.observations.trim():'';
    if(!Number.isSafeInteger(userId)||userId<=0) return jsonError(res,400,'Informe userId Roblox válido.');
    try {
      const profile=await findRobloxUserById(userId); const info=await getUserGroupRoleInfo(userId);
      if(info.member!==true) return jsonError(res,400,'O usuário precisa pertencer ao grupo EB.');
      const event={userId:profile.id,username:profile.username,displayName:profile.displayName,trainingName,observations,actor:'Roblox Server',actorId:null,source:'roblox-game',createdAt:new Date().toISOString()};
      saveTrainingEvent(event);
      return send(res,200,{ok:true,message:'Treinamento registrado.',rankingPosition:trainingRanking().find(x=>x.userId===userId)?.position||null});
    } catch(error) { return jsonError(res,503,error.message); }
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
