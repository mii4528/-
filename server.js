'use strict';
// 야외 마피아 게임 서버. 외부 패키지 없이 Node.js 18 이상에서 실행됩니다.
// 실시간 전송: Server-Sent Events(SSE). 행동 요청: POST /api/act.

const http = require('http');
const fs = require('fs');
const path = require('path');
const G = require('./lib/game');
const QR = require('./lib/qr');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC = path.join(__dirname, 'public');
const ROOM_TTL = 3 * 24 * 3600 * 1000;

const rooms = new Map();
const clients = new Map(); // code -> Set<{res, who, pid}>

// ───────────── 저장 ─────────────
function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const r of arr) rooms.set(r.code, r);
    console.log(`저장된 방 ${rooms.size}개를 불러왔습니다.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('저장 파일을 읽지 못했습니다:', e.message);
  }
}
let saveTimer = null;
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...rooms.values()]));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('저장 실패:', e.message); }
}
function save() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 200);
}
// 서버 재시작·재배포 시 마지막 상태를 저장하고 종료
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { saveNow(); process.exit(0); });
}

// ───────────── 실시간 전송 ─────────────
function isOnline(code, pid) {
  const set = clients.get(code);
  if (!set) return false;
  for (const c of set) if (c.pid === pid) return true;
  return false;
}
function viewFor(room, c) {
  if (c.who === 'host') return G.hostView(room, (pid) => isOnline(room.code, pid));
  const p = room.players[c.pid];
  return p ? G.playerView(room, p) : null;
}
function send(c, event, data) {
  try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* 끊긴 연결 */ }
}
function broadcast(room) {
  room.lastActive = Date.now();
  save();
  const set = clients.get(room.code);
  if (!set) return;
  for (const c of set) {
    if (c.who === 'player') {
      const p = room.players[c.pid];
      if (!p || p.token !== c.token) { send(c, 'kicked', { reason: p ? '다른 기기에서 복구 코드로 접속했습니다.' : '방에서 나갔습니다.' }); c.res.end(); set.delete(c); continue; }
    }
    const v = viewFor(room, c);
    if (v) send(c, 'state', v);
  }
}
function notifyHosts(room) {
  const set = clients.get(room.code);
  if (!set) return;
  for (const c of set) if (c.who === 'host') send(c, 'state', viewFor(room, c));
}

// ───────────── 도우미 ─────────────
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > 100000) { reject(new Error('too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function auth(code, tok) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw new G.GameError('방을 찾을 수 없습니다. 방 코드를 확인하세요.');
  if (tok && tok === room.hostToken) return { room, who: 'host' };
  const p = tok && Object.values(room.players).find(x => x.token === tok);
  if (!p) throw new G.GameError('접속 정보가 없습니다. 다시 입장하거나 복구 코드를 입력하세요.');
  return { room, who: 'player', p };
}
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const createLimit = new Map();
function allowCreate(ip) {
  const t = Date.now(), arr = (createLimit.get(ip) || []).filter(x => t - x < 3600e3);
  if (arr.length >= 30) return false;
  arr.push(t); createLimit.set(ip, arr); return true;
}

// ───────────── 행동 처리 ─────────────
const HOST_ACTIONS = {
  settings: (r, b) => G.updateSettings(r, b.settings || {}),
  locations: (r, b) => G.saveLocations(r, b.locations),
  missions: (r, b) => G.saveMissions(r, b.missions),
  kick: (r, b) => G.kick(r, b.pid),
  assign: (r) => G.assignRoles(r),
  start: (r, b) => G.startGame(r, !!b.force),
  discussion: (r) => G.startDiscussion(r),
  extend: (r, b) => G.extendDiscussion(r, Math.min(600, Math.max(10, Number(b.sec) || 60))),
  vote: (r) => G.startVoting(r),
  closeVote: (r) => { if (r.phase !== 'voting' || r.paused) throw new G.GameError('투표 중이 아닙니다.'); G.closeVoting(r); },
  resume: (r) => G.resumeActivity(r),
  pause: (r) => G.pause(r),
  unpause: (r) => G.unpause(r),
  revive: (r, b) => G.hostRevive(r, b.pid),
  setDead: (r, b) => G.hostSetDead(r, b.pid),
  completeTask: (r, b) => G.hostCompleteTask(r, b.pid),
  meeting: (r) => G.hostMeeting(r),
  end: (r) => G.hostEnd(r),
  newGame: (r) => G.newGame(r),
};
const PLAYER_ACTIONS = {
  ready: (r, p, b) => G.setReady(r, p, b.ready),
  ack: (r, p) => G.ack(r, p),
  kill: (r, p, b) => G.kill(r, p, b.target, b.seq),
  scan: (r, p, b) => G.scan(r, p, b.value, b.seq),
  answer: (r, p, b) => G.answer(r, p, b.taskId, b.option, b.seq),
  report: (r, p, b) => G.report(r, p, b.qr, b.seq),
  emergency: (r, p, b) => G.emergency(r, p, b.seq),
  vote: (r, p, b) => G.castVote(r, p, b.target, b.seq),
};

async function api(req, res, url) {
  const route = url.pathname;
  if (route === '/api/ping') return json(res, 200, { ok: true, t: Date.now() });

  if (route === '/api/events' && req.method === 'GET') {
    let a;
    try { a = auth(url.searchParams.get('code'), url.searchParams.get('token')); }
    catch (e) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.end(`event: denied\ndata: ${JSON.stringify({ error: e.message })}\n\n`); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const c = { res, who: a.who, pid: a.p ? a.p.id : null, token: url.searchParams.get('token') };
    if (!clients.has(a.room.code)) clients.set(a.room.code, new Set());
    const wasOnline = c.pid && isOnline(a.room.code, c.pid);
    clients.get(a.room.code).add(c);
    send(c, 'state', viewFor(a.room, c));
    if (c.pid && !wasOnline) notifyHosts(a.room);
    req.on('close', () => {
      const set = clients.get(a.room.code);
      if (set) set.delete(c);
      if (c.pid && !isOnline(a.room.code, c.pid) && rooms.has(a.room.code)) notifyHosts(a.room);
    });
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: '허용되지 않은 요청입니다.' });
  let b;
  try { b = await readBody(req); } catch (_) { return json(res, 400, { error: '잘못된 요청입니다.' }); }

  try {
    if (route === '/api/rooms') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!allowCreate(ip)) return json(res, 429, { error: '방을 너무 많이 만들었습니다. 잠시 후 다시 시도하세요.' });
      const room = G.createRoom(new Set(rooms.keys()));
      room.lastActive = Date.now();
      rooms.set(room.code, room);
      save();
      return json(res, 200, { code: room.code, hostToken: room.hostToken });
    }
    if (route === '/api/join') {
      const room = rooms.get(String(b.code || '').trim().toUpperCase());
      if (!room) throw new G.GameError('방을 찾을 수 없습니다. 방 코드를 확인하세요.');
      const p = G.join(room, b.name);
      broadcast(room);
      return json(res, 200, { code: room.code, token: p.token, name: p.name, recovery: p.recovery });
    }
    if (route === '/api/recover') {
      const room = rooms.get(String(b.code || '').trim().toUpperCase());
      if (!room) throw new G.GameError('방을 찾을 수 없습니다. 방 코드를 확인하세요.');
      const p = G.recover(room, b.recovery);
      broadcast(room); // 예전 기기 연결 종료
      return json(res, 200, { code: room.code, token: p.token, name: p.name });
    }
    if (route === '/api/state') {
      const a = auth(b.code, b.token);
      return json(res, 200, { view: viewFor(a.room, { who: a.who, pid: a.p && a.p.id }) });
    }
    if (route === '/api/act') {
      const a = auth(b.code, b.token);
      const action = String(b.action || '');
      let result;
      if (a.who === 'host') {
        const fn = HOST_ACTIONS[action];
        if (!fn) throw new G.GameError('알 수 없는 진행자 명령입니다.');
        result = fn(a.room, b);
      } else {
        const fn = PLAYER_ACTIONS[action];
        if (!fn) throw new G.GameError('권한이 없습니다.');
        result = fn(a.room, a.p, b);
      }
      broadcast(a.room);
      return json(res, 200, { ok: true, result: result || null, view: viewFor(a.room, { who: a.who, pid: a.p && a.p.id }) });
    }
    return json(res, 404, { error: '없는 주소입니다.' });
  } catch (e) {
    if (e instanceof G.GameError) {
      // 실패 응답에도 최신 상태를 붙여 화면을 바로잡습니다.
      let view = null;
      try { const a = auth(b.code, b.token); view = viewFor(a.room, { who: a.who, pid: a.p && a.p.id }); if (route === '/api/act') broadcast(a.room); } catch (_) { /* 무시 */ }
      return json(res, 400, { error: e.message, view });
    }
    console.error(e);
    return json(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
}

// ───────────── 인쇄 페이지 (진행자 전용) ─────────────
function printPage(req, res, url) {
  let a;
  try { a = auth(url.searchParams.get('code'), url.searchParams.get('token')); } catch (e) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(e.message); }
  if (a.who !== 'host') { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('진행자만 볼 수 있습니다.'); }
  const room = a.room, origin = originOf(req);
  const what = url.searchParams.get('what') || 'all';
  const joinUrl = `${origin}/?room=${room.code}`;
  const scanUrl = (v) => `${origin}/?room=${room.code}&s=${v}`;
  let cards = '';
  if (what === 'all' || what === 'join') {
    cards += `<section class="sheet"><div class="card big"><h2>야외 마피아 입장</h2>${QR.svg(joinUrl)}<p class="code">방 코드 <b>${room.code}</b></p><p class="small">${esc(joinUrl)}</p></div></section>`;
  }
  if (what === 'all' || what === 'places') {
    cards += '<section class="sheet grid">';
    for (const l of room.locations) {
      const tags = [l.item ? '물품 출발지' : '', l.box ? '도착 상자' : '', l.sign ? '현장 보고 표지' : ''].filter(Boolean).join(' · ');
      cards += `<div class="card"><h3>📍 ${esc(l.name)}</h3>${QR.svg(scanUrl(l.qr))}<p class="code">코드 <b>${l.code}</b></p><p class="small">${esc(tags || '방문 점검')}</p></div>`;
    }
    cards += '</section>';
    // 임무 목록을 직접 만든 경우 그 질문을, 아니면 장소 표지 질문을 정답표에 넣습니다.
    const custom = (room.missions || []).filter(m => m.type === 'report');
    const rows = (room.missions || []).length
      ? custom.map(m => ({ place: (room.locations.find(l => l.id === m.loc) || {}).name || '?', q: m.q.question, a: m.q.answer }))
      : room.locations.filter(l => l.sign).map(l => ({ place: l.name, q: l.sign.question, a: l.sign.answer }));
    if (rows.length) {
      cards += '<section class="sheet"><h2 class="title">진행자용 표지 정답표 (참가자에게 보이지 않게 보관)</h2><table><tr><th>장소</th><th>질문</th><th>표지에 표시할 정답</th></tr>';
      for (const r of rows) cards += `<tr><td>${esc(r.place)}</td><td>${esc(r.q)}</td><td><b>${esc(r.a)}</b></td></tr>`;
      cards += '</table></section>';
    }
  }
  if (what === 'all' || what === 'players') {
    cards += '<section class="sheet grid">';
    for (const p of G.list(room)) {
      cards += `<div class="card tag"><h3>${esc(p.name)}</h3>${QR.svg(scanUrl(p.qr))}<p class="code">이름표 코드 <b>${p.code}</b></p><p class="small">쓰러진 사람을 발견했을 때만 스캔</p></div>`;
    }
    if (!G.list(room).length) cards += '<p>아직 입장한 참가자가 없습니다. 참가자가 입장한 뒤 다시 인쇄하세요.</p>';
    cards += '</section>';
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR 인쇄 - ${room.code}</title>
<style>
body{font-family:system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;margin:0;color:#111;background:#fff}
.bar{padding:12px 16px;background:#111;color:#fff;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.bar button,.bar a{font-size:16px;padding:8px 14px;border-radius:8px;border:0;background:#ffd23f;color:#111;text-decoration:none;font-weight:700}
.sheet{padding:10mm;page-break-after:always}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8mm}
.card{border:2px dashed #999;border-radius:6mm;padding:6mm;text-align:center;break-inside:avoid}
.card svg{width:55mm;height:55mm}
.card.big svg{width:120mm;height:120mm}
.card.tag svg{width:45mm;height:45mm}
h2{font-size:28px;margin:0 0 6mm}h3{font-size:22px;margin:0 0 3mm}
.code{font-size:20px;margin:3mm 0 1mm;letter-spacing:2px}.small{font-size:12px;color:#555;margin:0;word-break:break-all}
.title{font-size:20px}table{border-collapse:collapse;width:100%;font-size:15px}td,th{border:1px solid #999;padding:6px;text-align:left}
@media print{.bar{display:none}.sheet{padding:6mm}}
</style></head><body>
<div class="bar"><b>방 ${room.code} QR 인쇄</b>
<a href="?code=${room.code}&token=${encodeURIComponent(room.hostToken)}&what=all">전체</a>
<a href="?code=${room.code}&token=${encodeURIComponent(room.hostToken)}&what=join">입장 QR</a>
<a href="?code=${room.code}&token=${encodeURIComponent(room.hostToken)}&what=places">장소 QR</a>
<a href="?code=${room.code}&token=${encodeURIComponent(room.hostToken)}&what=players">이름표 QR</a>
<button onclick="print()">🖨 인쇄</button></div>
${cards}</body></html>`);
}

// ───────────── 정적 파일 ─────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, url) {
  let p = url.pathname;
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/host') p = '/host.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('페이지를 찾을 수 없습니다.'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => { console.error(e); try { json(res, 500, { error: '서버 오류' }); } catch (_) { /* 무시 */ } });
    return;
  }
  if (url.pathname === '/print') return printPage(req, res, url);
  if (url.pathname === '/qr.svg') {
    const text = (url.searchParams.get('text') || '').slice(0, 200);
    try { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' }); return res.end(QR.svg(text)); }
    catch (_) { res.writeHead(400); return res.end(); }
  }
  serveStatic(req, res, url);
});

// 타이머: 토론·투표 자동 전환, 오래된 방 정리, 연결 유지 신호
setInterval(() => {
  for (const room of rooms.values()) {
    if (G.tick(room)) broadcast(room);
  }
}, 500);
setInterval(() => {
  const t = Date.now();
  for (const [code, room] of rooms) {
    if (t - (room.lastActive || room.createdAt) > ROOM_TTL && !(clients.get(code) || new Set()).size) { rooms.delete(code); clients.delete(code); save(); }
  }
  // 15초마다 현재 상태를 다시 보내 시계를 맞추고 연결을 유지합니다.
  for (const [code, set] of clients) {
    const room = rooms.get(code);
    if (!room) continue;
    for (const c of set) { const v = viewFor(room, c); if (v) send(c, 'state', v); }
  }
}, 15000);

load();
server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`야외 마피아 서버 실행 중: http://localhost:${PORT}`));

module.exports = { server, rooms };
