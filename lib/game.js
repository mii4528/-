'use strict';
// 게임 규칙 엔진. 모든 상태 변경은 이 파일의 함수를 통해서만 일어납니다.
// Node는 단일 스레드이므로 요청 하나가 끝까지 처리된 뒤 다음 요청이 처리됩니다.
// 따라서 동시 암살·신고·투표도 도착 순서대로 하나씩 확정됩니다.

const crypto = require('crypto');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I 제외
const rnd = (n, alpha = ALPHA) => {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alpha[b[i] % alpha.length];
  return s;
};
const token = () => crypto.randomBytes(18).toString('base64url');
const shuffle = (a) => {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

const DEFAULT_SETTINGS = {
  mafiaCount: 3,
  tasksPerPlayer: 4,
  killCooldown: 90,
  startProtect: 60,
  resumeProtect: 20,
  emergencyPerPlayer: 1,
  emergencyCooldown: 60,
  discussionSec: 180,
  voteSec: 30,
  taskGoalPct: 100,
  revealEjectedRole: false,
  gatherPlace: '본부 (출발 장소)',
};

const SETTING_LIMITS = {
  mafiaCount: [1, 10], tasksPerPlayer: [1, 10], killCooldown: [10, 600],
  startProtect: [0, 600], resumeProtect: [0, 300], emergencyPerPlayer: [0, 5],
  emergencyCooldown: [0, 600], discussionSec: [30, 1200], voteSec: [10, 300],
  taskGoalPct: [10, 100],
};

function defaultLocations() {
  const mk = (name, sign, item, box) => ({ id: rnd(6), name, code: '', qr: '', sign, item, box });
  return [
    mk('정문 게시판', { question: '게시판에 붙은 카드의 색은?', options: ['빨강', '파랑', '노랑', '초록'], answer: '파랑' }, true, false),
    mk('운동장 벤치', null, true, true),
    mk('도서관 앞', { question: '표지판에 그려진 그림은?', options: ['별', '하트', '달', '번개'], answer: '달' }, false, true),
    mk('급식실 입구', null, true, true),
    mk('후문 화단', { question: '화단 팻말의 숫자는?', options: ['3', '5', '7', '9'], answer: '7' }, false, true),
  ];
}

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

// ───────────────────────── 방과 참가자 ─────────────────────────

function createRoom(existingCodes) {
  let code;
  do { code = rnd(4); } while (existingCodes.has(code));
  const room = {
    code,
    hostToken: token(),
    createdAt: Date.now(),
    version: 1,
    gameNo: 1,
    settings: { ...DEFAULT_SETTINGS },
    locations: [],
    players: {},
    order: [],
    history: [],
    missions: [],
  };
  defaultLocations().forEach(l => addLocationCodes(room, l));
  resetGame(room);
  return room;
}

function addLocationCodes(room, loc) {
  loc.code = uniqueShort(room, 4);
  loc.qr = 'L' + rnd(10);
  room.locations.push(loc);
}

function uniqueShort(room, n) {
  const used = new Set([
    ...room.locations.map(l => l.code),
    ...Object.values(room.players || {}).map(p => p.code),
  ]);
  let c;
  do { c = rnd(n); } while (used.has(c));
  return c;
}

function resetGame(room) {
  room.phase = 'lobby';
  room.paused = false;
  room.pausedAt = null;
  room.phaseSeq = (room.phaseSeq || 0) + 1;
  room.phaseEndsAt = null;
  room.emergencyReadyAt = null;
  room.meetingStartedAt = null;
  room.meetings = [];
  room.vote = null;
  room.lastResult = null;
  room.end = null;
  room.log = [];
  room.citizenTaskTotal = 0;
  room.startedAt = null;
  for (const p of Object.values(room.players)) {
    Object.assign(p, {
      role: null, status: 'alive', ack: false, tasks: [], taskIdx: 0,
      emergencyLeft: 0, killReadyAt: null, ready: false,
    });
  }
}

function join(room, rawName) {
  if (room.phase !== 'lobby') fail('이미 게임이 시작되었습니다. 기존 참가자는 복구 코드로 들어오세요.');
  let name = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 12);
  if (!name) fail('이름을 입력하세요.');
  if (room.order.length >= 60) fail('방 인원이 가득 찼습니다.');
  const names = new Set(Object.values(room.players).map(p => p.name));
  if (names.has(name)) {
    let k = 2;
    while (names.has(`${name} (${k})`)) k++;
    name = `${name} (${k})`;
  }
  let recovery;
  const usedRec = new Set(Object.values(room.players).map(p => p.recovery));
  do { recovery = String(crypto.randomInt(100000, 1000000)); } while (usedRec.has(recovery));
  const p = {
    id: rnd(8), name, token: token(), recovery,
    qr: 'P' + rnd(10), code: uniqueShort(room, 4),
    joinedAt: Date.now(),
    role: null, status: 'alive', ack: false, ready: false,
    tasks: [], taskIdx: 0, emergencyLeft: 0, killReadyAt: null,
  };
  room.players[p.id] = p;
  room.order.push(p.id);
  bump(room);
  return p;
}

function recover(room, code) {
  const p = Object.values(room.players).find(x => x.recovery === String(code || '').trim());
  if (!p) fail('복구 코드가 맞지 않습니다.');
  // 복구하면 새 토큰을 발급하여 예전 기기의 접속을 끊습니다.
  p.token = token();
  bump(room);
  return p;
}

// ───────────────────────── 유틸 ─────────────────────────

const now = () => Date.now();
const bump = (room) => { room.version++; };
const list = (room) => room.order.map(id => room.players[id]).filter(Boolean);
const isOut = (p) => p.status !== 'alive';
const ghostable = (p) => p.status === 'deadRevealed' || p.status === 'ejected';

function log(room, type, data = {}) {
  room.log.push({ t: now(), type, ...data });
  if (room.log.length > 2000) room.log.shift();
}

function needPhase(room, ...phases) {
  if (room.phase === 'ended') fail('게임이 종료되었습니다.');
  if (room.paused) fail('일시 정지 중입니다.');
  if (!phases.includes(room.phase)) fail('지금 단계에서는 할 수 없습니다.');
}

function checkSeq(room, seq) {
  // 화면이 오래된 상태에서 누른 버튼은 실행하지 않습니다.
  if (seq !== undefined && seq !== null && Number(seq) !== room.phaseSeq) {
    fail('화면이 오래되었습니다. 다시 확인해 주세요.');
  }
}

function newPhase(room, phase, endsAt = null) {
  room.phase = phase;
  room.phaseSeq++;
  room.phaseEndsAt = endsAt;
}

// ───────────────────────── 설정 (진행자) ─────────────────────────

function updateSettings(room, s) {
  if (room.phase !== 'lobby') fail('설정은 게임 시작 전에만 바꿀 수 있습니다.');
  for (const [k, [lo, hi]] of Object.entries(SETTING_LIMITS)) {
    if (s[k] !== undefined) {
      const v = Math.round(Number(s[k]));
      if (!Number.isFinite(v) || v < lo || v > hi) fail(`설정 값이 범위를 벗어났습니다: ${k}`);
      room.settings[k] = v;
    }
  }
  if (s.revealEjectedRole !== undefined) room.settings.revealEjectedRole = !!s.revealEjectedRole;
  if (s.gatherPlace !== undefined) room.settings.gatherPlace = String(s.gatherPlace).trim().slice(0, 40) || DEFAULT_SETTINGS.gatherPlace;
  bump(room);
}

function saveLocations(room, locs) {
  if (room.phase !== 'lobby') fail('장소는 게임 시작 전에만 바꿀 수 있습니다.');
  if (!Array.isArray(locs) || locs.length < 1 || locs.length > 20) fail('장소는 1~20곳이어야 합니다.');
  const old = new Map(room.locations.map(l => [l.id, l]));
  const next = [];
  room.locations = [];
  for (const raw of locs) {
    const name = String(raw.name || '').trim().slice(0, 30);
    if (!name) fail('장소 이름을 입력하세요.');
    let sign = null;
    if (raw.sign && String(raw.sign.question || '').trim()) {
      const options = (raw.sign.options || []).map(o => String(o).trim().slice(0, 20)).filter(Boolean);
      const answer = String(raw.sign.answer || '').trim();
      if (options.length < 2) fail(`${name}: 보고 선택지는 2개 이상이어야 합니다.`);
      if (!options.includes(answer)) fail(`${name}: 정답이 선택지에 없습니다.`);
      sign = { question: String(raw.sign.question).trim().slice(0, 60), options: [...new Set(options)].slice(0, 6), answer };
    }
    const prev = old.get(raw.id);
    const loc = { id: prev ? prev.id : rnd(6), name, sign, item: !!raw.item, box: !!raw.box, code: prev ? prev.code : '', qr: prev ? prev.qr : '' };
    next.push(loc);
  }
  for (const loc of next) {
    if (!loc.code) { loc.code = uniqueShort({ locations: [...room.locations, ...next], players: room.players }, 4); }
    if (!loc.qr) loc.qr = 'L' + rnd(10);
    room.locations.push(loc);
  }
  bump(room);
}

function kick(room, pid) {
  if (room.phase !== 'lobby') fail('대기 단계에서만 내보낼 수 있습니다.');
  if (!room.players[pid]) fail('참가자를 찾을 수 없습니다.');
  delete room.players[pid];
  room.order = room.order.filter(id => id !== pid);
  bump(room);
}

// ───────────────────────── 역할·임무 배정 ─────────────────────────

function validateSetup(room) {
  const n = room.order.length, m = room.settings.mafiaCount;
  if (n < 3) fail('최소 3명이 필요합니다.');
  if (m < 1) fail('마피아는 1명 이상이어야 합니다.');
  if (m >= n - m) fail(`마피아(${m}명)는 시민(${n - m}명)보다 적어야 합니다.`);
  if (room.locations.length < 1) fail('장소를 1곳 이상 등록하세요.');
}

const qCopy = (sign) => (sign ? { question: sign.question, options: sign.options.slice(), answer: sign.answer } : null);

// 진행자가 직접 등록한 임무 목록. 비어 있으면 장소로 자동 생성합니다.
function saveMissions(room, raw) {
  if (room.phase !== 'lobby') fail('임무는 게임 시작 전에만 바꿀 수 있습니다.');
  if (!Array.isArray(raw) || raw.length > 100) fail('임무는 100개까지 등록할 수 있습니다.');
  const locIds = new Set(room.locations.map(l => l.id));
  const old = new Map((room.missions || []).map(m => [m.id, m]));
  room.missions = raw.map((m, i) => {
    const n = i + 1;
    const type = ['visit', 'report', 'carry'].includes(m.type) ? m.type : fail(`${n}번 임무: 종류를 고르세요.`);
    if (!locIds.has(m.loc)) fail(`${n}번 임무: 장소를 고르세요.`);
    const out = {
      id: old.has(m.id) ? m.id : rnd(6), type, loc: m.loc,
      title: String(m.title || '').trim().slice(0, 30),
      desc: String(m.desc || '').trim().slice(0, 120),
    };
    if (type === 'carry') {
      if (!locIds.has(m.loc2)) fail(`${n}번 임무: 도착 장소를 고르세요.`);
      if (m.loc2 === m.loc) fail(`${n}번 임무: 출발지와 도착지가 같습니다.`);
      out.loc2 = m.loc2;
    }
    if (type === 'report') {
      const question = String((m.q && m.q.question) || '').trim().slice(0, 60);
      const options = [...new Set(((m.q && m.q.options) || []).map(o => String(o).trim().slice(0, 20)).filter(Boolean))].slice(0, 6);
      const answer = String((m.q && m.q.answer) || '').trim();
      if (!question) fail(`${n}번 임무: 보고 질문을 입력하세요.`);
      if (options.length < 2) fail(`${n}번 임무: 선택지는 2개 이상이어야 합니다.`);
      if (!options.includes(answer)) fail(`${n}번 임무: 정답이 선택지에 없습니다.`);
      out.q = { question, options, answer };
    }
    return out;
  });
  bump(room);
}

function missionsUsable(room) {
  const locIds = new Set(room.locations.map(l => l.id));
  for (const [i, m] of (room.missions || []).entries()) {
    if (!locIds.has(m.loc) || (m.type === 'carry' && !locIds.has(m.loc2))) {
      fail(`${i + 1}번 임무의 장소가 삭제되었습니다. 임무 탭에서 장소를 다시 고르세요.`);
    }
  }
}

function makeTasks(room) {
  const pool = room.missions || [];
  if (pool.length) {
    // 등록된 목록에서 겹치지 않게 뽑아 사람마다 다른 순서로 배정
    const picked = shuffle(pool).slice(0, Math.min(pool.length, room.settings.tasksPerPlayer));
    return picked.map(m => {
      const t = { id: rnd(6), mid: m.id, type: m.type, loc: m.loc, step: 0, done: false, title: m.title, desc: m.desc };
      if (m.type === 'carry') t.loc2 = m.loc2;
      if (m.type === 'report') t.q = qCopy(m.q);
      return t;
    });
  }
  const locs = room.locations;
  const boxes = locs.filter(l => l.box);
  const count = room.settings.tasksPerPlayer;
  // 장소 수보다 임무가 많으면 장소를 반복 사용합니다(연속 중복은 피함).
  let seq = [];
  while (seq.length < count) {
    let s = shuffle(locs);
    if (seq.length && s.length > 1 && s[0].id === seq[seq.length - 1].id) s.push(s.shift());
    seq = seq.concat(s);
  }
  seq = seq.slice(0, count);
  // 유형 섞기: 운반 1개, 보고 1개를 우선 넣고 나머지는 방문.
  let wantCarry = 1, wantReport = 1;
  const order = shuffle(seq.map((_, i) => i));
  const types = new Array(count).fill('visit');
  for (const i of order) {
    const l = seq[i];
    const dests = boxes.filter(b => b.id !== l.id);
    if (wantCarry > 0 && l.item && dests.length) { types[i] = 'carry'; wantCarry--; continue; }
    if (wantReport > 0 && l.sign) { types[i] = 'report'; wantReport--; continue; }
  }
  return seq.map((l, i) => {
    const t = { id: rnd(6), type: types[i], loc: l.id, step: 0, done: false };
    if (t.type === 'report') t.q = qCopy(l.sign);
    if (t.type === 'carry') {
      const dests = boxes.filter(b => b.id !== l.id);
      t.loc2 = dests[crypto.randomInt(dests.length)].id;
    }
    return t;
  });
}

function assignRoles(room) {
  if (!['lobby', 'briefing'].includes(room.phase)) fail('대기 단계에서만 역할을 배정합니다.');
  if (room.paused) fail('일시 정지 중입니다.');
  validateSetup(room);
  missionsUsable(room);
  const ps = shuffle(list(room));
  const m = room.settings.mafiaCount;
  ps.forEach((p, i) => {
    p.role = i < m ? 'mafia' : 'citizen';
    p.status = 'alive';
    p.ack = false;
    p.tasks = makeTasks(room);
    p.taskIdx = 0;
    p.emergencyLeft = room.settings.emergencyPerPlayer;
    p.killReadyAt = null;
  });
  room.citizenTaskTotal = ps.filter(p => p.role === 'citizen').reduce((a, p) => a + p.tasks.length, 0);
  newPhase(room, 'briefing');
  log(room, 'assign', { mafia: ps.filter(p => p.role === 'mafia').map(p => p.name) });
  bump(room);
}

function ack(room, p) {
  if (room.phase !== 'briefing') fail('역할 확인 단계가 아닙니다.');
  p.ack = true;
  bump(room);
}

function setReady(room, p, v) {
  if (room.phase !== 'lobby') fail('대기 단계가 아닙니다.');
  p.ready = !!v;
  bump(room);
}

function startGame(room, force) {
  if (room.phase !== 'briefing') fail('먼저 역할을 배정하세요.');
  if (room.paused) fail('일시 정지 중입니다.');
  const notAck = list(room).filter(p => !p.ack);
  if (notAck.length && !force) fail(`아직 확인하지 않은 사람: ${notAck.map(p => p.name).join(', ')}`);
  const t = now();
  room.startedAt = t;
  newPhase(room, 'active');
  room.emergencyReadyAt = t + room.settings.emergencyCooldown * 1000;
  for (const p of list(room)) if (p.role === 'mafia') p.killReadyAt = t + room.settings.startProtect * 1000;
  log(room, 'start');
  bump(room);
}

// ───────────────────────── 진행률·승리 판정 ─────────────────────────

function progress(room) {
  let done = 0;
  for (const p of list(room)) if (p.role === 'citizen') done += p.tasks.filter(t => t.done).length;
  const total = room.citizenTaskTotal;
  return { done, total, pct: total ? Math.floor((done / total) * 100) : 0, goal: room.settings.taskGoalPct };
}

function checkWin(room) {
  if (room.phase === 'ended' || !room.startedAt) return false;
  const ps = list(room);
  const aliveM = ps.filter(p => p.role === 'mafia' && p.status === 'alive').length;
  const aliveC = ps.filter(p => p.role === 'citizen' && p.status === 'alive').length;
  const pr = progress(room);
  let winner = null, reason = null;
  if (aliveM === 0) { winner = 'citizen'; reason = '마피아가 모두 탈락했습니다.'; }
  else if (aliveM >= aliveC) { winner = 'mafia'; reason = `살아 있는 마피아(${aliveM})가 살아 있는 시민(${aliveC}) 이상이 되었습니다.`; }
  else if (pr.total > 0 && pr.done * 100 >= pr.total * pr.goal) { winner = 'citizen'; reason = `시민 임무 진행률 ${pr.goal}%를 달성했습니다.`; }
  if (!winner) return false;
  endGame(room, winner, reason);
  return true;
}

function endGame(room, winner, reason) {
  room.paused = false;
  room.pausedAt = null;
  newPhase(room, 'ended');
  room.vote = null;
  room.end = { winner, reason, at: now() };
  log(room, 'end', { winner, reason });
  bump(room);
}

// ───────────────────────── 암살 ─────────────────────────

function kill(room, actor, targetId, seq) {
  needPhase(room, 'active');
  checkSeq(room, seq);
  if (actor.role !== 'mafia') fail('권한이 없습니다.');
  if (actor.status !== 'alive') fail('탈락한 마피아는 암살할 수 없습니다.');
  const t = now();
  if (t < actor.killReadyAt) fail(`아직 암살할 수 없습니다. ${Math.ceil((actor.killReadyAt - t) / 1000)}초 남았습니다.`);
  const target = room.players[targetId];
  if (!target) fail('대상을 찾을 수 없습니다.');
  if (target.id === actor.id) fail('자신은 선택할 수 없습니다.');
  if (target.role === 'mafia') fail('동료는 선택할 수 없습니다.');
  if (target.status !== 'alive') fail('대상이 이미 사망했거나 추방되었습니다. 대기시간은 소모되지 않았습니다.');
  target.status = 'dead';
  target.diedAt = t;
  actor.killReadyAt = t + room.settings.killCooldown * 1000;
  log(room, 'kill', { by: actor.name, target: target.name });
  bump(room);
  checkWin(room);
  return { ok: true, targetName: target.name };
}

// ───────────────────────── QR 스캔 ─────────────────────────

function normalizeScan(v) {
  let s = String(v || '').trim();
  const m = s.match(/[?&]s=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s.toUpperCase();
}

function resolveCode(room, raw) {
  const s = normalizeScan(raw);
  if (!s) return null;
  const loc = room.locations.find(l => l.qr === s || l.code === s);
  if (loc) return { kind: 'loc', loc };
  const p = Object.values(room.players).find(x => x.qr === s || x.code === s);
  if (p) return { kind: 'player', p };
  return null;
}

function currentTask(p) {
  return p.tasks[p.taskIdx] || null;
}

function canDoTasks(room, p) {
  if (room.phase !== 'active' || room.paused) return '지금은 임무를 완료할 수 없습니다.';
  if (p.status === 'dead') return '사망 상태입니다. 회의가 끝난 뒤 유령으로 임무를 이어 갑니다.';
  return null;
}

function scan(room, p, raw, seq) {
  if (room.phase === 'ended') fail('게임이 종료되었습니다.');
  if (room.paused) fail('일시 정지 중입니다.');
  if (!room.startedAt) fail('게임이 아직 시작되지 않았습니다.');
  checkSeq(room, seq);
  const r = resolveCode(room, raw);
  if (!r) fail('알 수 없는 코드입니다. 다시 확인하세요.');

  if (r.kind === 'player') {
    const q = r.p;
    if (q.id === p.id) return { kind: 'self', message: '내 이름표입니다.' };
    if (q.status === 'dead') {
      const canReport = room.phase === 'active' && p.status === 'alive';
      return {
        kind: 'body', name: q.name, qr: q.qr, canReport,
        message: canReport ? `${q.name} 님이 쓰러져 있습니다.` : `${q.name} 님이 쓰러져 있습니다. 지금은 신고할 수 없습니다.`,
      };
    }
    if (q.status === 'deadRevealed' || q.status === 'ejected') {
      return { kind: 'ghost', name: q.name, message: `${q.name} 님은 이미 확인된 탈락자입니다.` };
    }
    return { kind: 'person', name: q.name, message: `${q.name} 님입니다.` };
  }

  // 장소 QR → 임무 처리
  const why = canDoTasks(room, p);
  if (why) fail(why);
  const task = currentTask(p);
  if (!task) return { kind: 'info', message: `${r.loc.name} — 남은 임무가 없습니다.` };
  const loc = r.loc;
  if (task.type === 'visit') {
    if (loc.id !== task.loc) fail(`${loc.name}은(는) 지금 임무 장소가 아닙니다.`);
    return completeTask(room, p, task);
  }
  if (task.type === 'report') {
    if (loc.id !== task.loc) fail(`${loc.name}은(는) 지금 임무 장소가 아닙니다.`);
    const q = taskQ(room, task);
    if (!q) return completeTask(room, p, task); // 질문이 없으면 방문으로 처리
    task.step = 1;
    bump(room);
    return { kind: 'question', taskId: task.id, question: q.question, options: q.options };
  }
  if (task.type === 'carry') {
    if (task.step === 0) {
      if (loc.id !== task.loc) fail(`먼저 출발지(${locName(room, task.loc)})의 QR을 확인하세요.`);
      task.step = 1;
      bump(room);
      return { kind: 'carry1', message: `물품 하나를 들고 ${locName(room, task.loc2)}의 상자로 옮기세요.` };
    }
    if (loc.id === task.loc) return { kind: 'carry1', message: `이미 출발지를 확인했습니다. ${locName(room, task.loc2)}로 옮기세요.` };
    if (loc.id !== task.loc2) fail(`도착지는 ${locName(room, task.loc2)}입니다.`);
    return completeTask(room, p, task);
  }
  fail('알 수 없는 임무입니다.');
}

function taskQ(room, task) {
  if (task.q) return task.q;
  const L = room.locations.find(l => l.id === task.loc);
  return L && L.sign ? L.sign : null;
}

function answer(room, p, taskId, option, seq) {
  checkSeq(room, seq);
  const why = canDoTasks(room, p);
  if (why) fail(why);
  const task = currentTask(p);
  if (!task || task.id !== taskId || task.type !== 'report') fail('이 임무는 이미 끝났거나 바뀌었습니다.');
  if (task.step !== 1) fail('먼저 장소 QR을 확인하세요.');
  const q = taskQ(room, task);
  if (!q || String(option) !== q.answer) {
    task.step = 0;
    bump(room);
    fail('보고 내용이 맞지 않습니다. 표지를 다시 보고 QR부터 다시 확인하세요.');
  }
  return completeTask(room, p, task);
}

function completeTask(room, p, task, byHost = false) {
  if (task.done) return { kind: 'done', message: '이미 완료한 임무입니다.' };
  task.done = true;
  task.step = 2;
  task.doneAt = now();
  p.taskIdx++;
  log(room, 'task', { by: p.name, role: p.role, status: p.status, type: task.type, host: byHost || undefined });
  bump(room);
  if (p.role === 'citizen') checkWin(room);
  const left = p.tasks.length - p.taskIdx;
  return { kind: 'done', message: left ? `임무 완료! 남은 임무 ${left}개` : '모든 임무를 완료했습니다!' };
}

const locName = (room, id) => (room.locations.find(l => l.id === id) || { name: '?' }).name;

// ───────────────────────── 신고·긴급회의·회의 ─────────────────────────

function report(room, p, qrOrCode, seq) {
  needPhase(room, 'active');
  checkSeq(room, seq);
  if (p.status !== 'alive') fail('탈락한 사람은 신고할 수 없습니다.');
  const r = resolveCode(room, qrOrCode);
  if (!r || r.kind !== 'player') fail('신고 대상을 찾을 수 없습니다.');
  if (r.p.status !== 'dead') fail('신고할 수 있는 시체가 아닙니다.');
  startGathering(room, { trigger: 'report', by: p.name, body: r.p.name });
  return { ok: true };
}

function emergency(room, p, seq) {
  needPhase(room, 'active');
  checkSeq(room, seq);
  if (p.status !== 'alive') fail('탈락한 사람은 긴급회의를 요청할 수 없습니다.');
  if (p.emergencyLeft <= 0) fail('긴급회의 사용 횟수를 모두 썼습니다.');
  const t = now();
  if (t < room.emergencyReadyAt) fail(`긴급회의는 ${Math.ceil((room.emergencyReadyAt - t) / 1000)}초 뒤에 가능합니다.`);
  p.emergencyLeft--;
  startGathering(room, { trigger: 'emergency', by: p.name });
  return { ok: true };
}

function startGathering(room, info) {
  const revealed = [];
  for (const p of list(room)) {
    if (p.status === 'dead') { p.status = 'deadRevealed'; revealed.push(p.name); }
  }
  room.meetingStartedAt = now();
  room.meetings.push({ ...info, revealed, at: now(), result: null });
  newPhase(room, 'gathering');
  log(room, info.trigger === 'host' ? 'hostMeeting' : info.trigger, { by: info.by, body: info.body, revealed });
  bump(room);
}

function startDiscussion(room) {
  needPhase(room, 'gathering');
  newPhase(room, 'discussion', now() + room.settings.discussionSec * 1000);
  bump(room);
}

function extendDiscussion(room, sec = 60) {
  needPhase(room, 'discussion');
  room.phaseEndsAt = Math.max(room.phaseEndsAt, now()) + sec * 1000;
  bump(room);
}

function startVoting(room) {
  needPhase(room, 'discussion', 'gathering');
  const eligible = list(room).filter(p => p.status === 'alive').map(p => p.id);
  room.vote = { eligible, ballots: {} };
  newPhase(room, 'voting', now() + room.settings.voteSec * 1000);
  bump(room);
}

function castVote(room, p, target, seq) {
  needPhase(room, 'voting');
  checkSeq(room, seq);
  if (p.status !== 'alive' || !room.vote.eligible.includes(p.id)) fail('투표권이 없습니다.');
  if (room.vote.ballots[p.id] !== undefined) fail('이미 투표를 확정했습니다.');
  if (target !== 'skip') {
    const q = room.players[target];
    if (!q || q.status !== 'alive') fail('투표할 수 없는 대상입니다.');
  }
  room.vote.ballots[p.id] = target;
  log(room, 'vote', { by: p.name, target: target === 'skip' ? '건너뛰기' : room.players[target].name });
  bump(room);
  if (room.vote.eligible.every(id => room.vote.ballots[id] !== undefined)) closeVoting(room);
  return { ok: true };
}

function closeVoting(room) {
  if (room.phase !== 'voting') return;
  const counts = {};
  let skip = 0;
  for (const id of room.vote.eligible) {
    const b = room.vote.ballots[id];
    if (b === undefined) continue;
    if (b === 'skip') skip++;
    else counts[b] = (counts[b] || 0) + 1;
  }
  const noVote = room.vote.eligible.filter(id => room.vote.ballots[id] === undefined).length;
  const top = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter(id => counts[id] === top);
  let ejected = null, why;
  if (top === 0) why = '아무도 득표하지 않아 추방하지 않습니다.';
  else if (leaders.length > 1) why = '최다 득표가 동률이라 추방하지 않습니다.';
  else if (skip > top) why = '건너뛰기가 가장 많아 추방하지 않습니다.';
  else if (skip === top) why = '건너뛰기와 최다 득표가 같아 추방하지 않습니다.';
  else ejected = room.players[leaders[0]];

  const tally = list(room).filter(p => counts[p.id]).map(p => ({ name: p.name, count: counts[p.id] }))
    .sort((a, b) => b.count - a.count);
  const res = { tally, skip, noVote, ejected: null, ejectedRole: null, why };
  if (ejected) {
    ejected.status = 'ejected';
    res.ejected = ejected.name;
    res.why = `${ejected.name} 님이 추방되었습니다.`;
    if (room.settings.revealEjectedRole) res.ejectedRole = ejected.role;
  }
  room.lastResult = res;
  room.meetings[room.meetings.length - 1].result = res;
  room.vote.closed = true;
  log(room, 'voteResult', { ejected: res.ejected, why: res.why, tally, skip, noVote });
  newPhase(room, 'result');
  bump(room);
  checkWin(room);
}

function resumeActivity(room) {
  needPhase(room, 'result');
  const t = now();
  const frozen = t - (room.meetingStartedAt || t);
  for (const p of list(room)) {
    if (p.role === 'mafia' && p.killReadyAt) {
      // 회의 동안 남은 대기시간을 멈춘 뒤, 재개 보호시간과 비교해 긴 쪽 적용
      p.killReadyAt = Math.max(p.killReadyAt + frozen, t + room.settings.resumeProtect * 1000);
    }
  }
  room.emergencyReadyAt = t + room.settings.emergencyCooldown * 1000;
  room.vote = null;
  room.meetingStartedAt = null;
  newPhase(room, 'active');
  log(room, 'resume');
  bump(room);
}

// ───────────────────────── 타이머 ─────────────────────────

function tick(room) {
  if (room.paused || !room.phaseEndsAt) return false;
  if (now() < room.phaseEndsAt) return false;
  if (room.phase === 'discussion') { startVoting(room); return true; }
  if (room.phase === 'voting') { closeVoting(room); return true; }
  return false;
}

// ───────────────────────── 진행자 관리 ─────────────────────────

function pause(room) {
  if (room.phase === 'ended') fail('종료된 게임입니다.');
  if (room.paused) fail('이미 일시 정지 중입니다.');
  room.paused = true;
  room.pausedAt = now();
  room.phaseSeq++;
  log(room, 'pause');
  bump(room);
}

function unpause(room) {
  if (!room.paused) fail('일시 정지 상태가 아닙니다.');
  const d = now() - room.pausedAt;
  // 모든 기준 시각을 정지한 시간만큼 뒤로 미룹니다.
  if (room.phaseEndsAt) room.phaseEndsAt += d;
  if (room.emergencyReadyAt) room.emergencyReadyAt += d;
  if (room.meetingStartedAt) room.meetingStartedAt += d;
  for (const p of list(room)) if (p.killReadyAt) p.killReadyAt += d;
  room.paused = false;
  room.pausedAt = null;
  room.phaseSeq++;
  log(room, 'unpause');
  bump(room);
  checkWin(room);
}

function needPausedForFix(room) {
  if (!room.startedAt || room.phase === 'ended') fail('진행 중인 게임에서만 수정할 수 있습니다.');
  if (!room.paused) fail('오류 수정은 일시 정지 상태에서만 할 수 있습니다.');
}

function hostRevive(room, pid) {
  needPausedForFix(room);
  const p = room.players[pid];
  if (!p) fail('참가자를 찾을 수 없습니다.');
  if (p.status === 'alive') fail('이미 생존 상태입니다.');
  const before = p.status;
  p.status = 'alive';
  if (room.vote && !room.vote.eligible.includes(p.id) && room.phase === 'voting') room.vote.eligible.push(p.id);
  log(room, 'fix', { action: '생존으로 복구', target: p.name, before });
  bump(room);
}

function hostSetDead(room, pid) {
  needPausedForFix(room);
  const p = room.players[pid];
  if (!p) fail('참가자를 찾을 수 없습니다.');
  if (p.status !== 'alive') fail('이미 탈락 상태입니다.');
  // 활동 중에는 미발견 사망, 회의 중에는 공개된 사망으로 처리
  p.status = room.phase === 'active' ? 'dead' : 'deadRevealed';
  if (room.vote) delete room.vote.ballots[p.id];
  log(room, 'fix', { action: '사망 처리', target: p.name });
  bump(room);
}

function hostCompleteTask(room, pid) {
  needPausedForFix(room);
  const p = room.players[pid];
  if (!p) fail('참가자를 찾을 수 없습니다.');
  const task = currentTask(p);
  if (!task) fail('남은 임무가 없습니다.');
  log(room, 'fix', { action: '임무 수동 완료', target: p.name });
  task.done = true; task.step = 2; task.doneAt = now(); p.taskIdx++;
  bump(room);
}

function hostMeeting(room) {
  needPhase(room, 'active');
  startGathering(room, { trigger: 'host', by: '진행자' });
}

function hostEnd(room) {
  if (room.phase === 'ended') fail('이미 종료되었습니다.');
  if (!room.startedAt) fail('시작된 게임이 없습니다.');
  endGame(room, 'host', '진행자가 게임을 종료했습니다.');
}

function newGame(room) {
  // 지난 판 기록은 보관하고 같은 참가자로 새 판을 준비합니다.
  if (room.startedAt || room.phase !== 'lobby') {
    room.history.push({
      gameNo: room.gameNo, startedAt: room.startedAt, end: room.end,
      roles: list(room).map(p => ({ name: p.name, role: p.role, status: p.status })),
      log: room.log,
    });
    if (room.history.length > 10) room.history.shift();
  }
  room.gameNo++;
  resetGame(room);
  bump(room);
}

// ───────────────────────── 화면 데이터 (역할별 분리) ─────────────────────────

const PUBLIC_STATUS = (p) => (p.status === 'deadRevealed' ? 'dead' : p.status === 'ejected' ? 'ejected' : 'in');

function taskView(room, p) {
  const t = currentTask(p);
  if (!t) return null;
  const v = { id: t.id, type: t.type, step: t.step, loc: locName(room, t.loc), index: p.taskIdx + 1, total: p.tasks.length };
  if (t.type === 'carry') v.loc2 = locName(room, t.loc2);
  if (t.title) v.title = t.title;
  if (t.desc) v.desc = t.desc;
  if (t.type === 'report' && t.step === 1) {
    const q = taskQ(room, t);
    if (q) { v.question = q.question; v.options = q.options; }
  }
  return v;
}

function meetingView(room) {
  const m = room.meetings[room.meetings.length - 1];
  if (!m || !['gathering', 'discussion', 'voting', 'result'].includes(room.phase)) return null;
  return { trigger: m.trigger, by: m.by, body: m.body || null, revealed: m.revealed, place: room.settings.gatherPlace };
}

function playerView(room, p) {
  const started = !!room.startedAt;
  const v = {
    serverNow: now(),
    version: room.version,
    code: room.code,
    gameNo: room.gameNo,
    phase: room.phase,
    paused: room.paused,
    seq: room.phaseSeq,
    phaseEndsAt: room.phaseEndsAt,
    remainMs: room.paused && room.phaseEndsAt ? room.phaseEndsAt - room.pausedAt : null,
    settings: {
      gatherPlace: room.settings.gatherPlace, killCooldown: room.settings.killCooldown,
      discussionSec: room.settings.discussionSec, voteSec: room.settings.voteSec,
    },
    me: {
      id: p.id, name: p.name, recovery: p.recovery, code: p.code, ready: p.ready, ack: p.ack,
      role: room.phase === 'lobby' ? null : p.role,
      status: p.status === 'dead' ? 'dead' : p.status === 'alive' ? 'alive' : 'ghost',
      ghost: ghostable(p),
      emergencyLeft: p.emergencyLeft,
      task: started ? taskView(room, p) : null,
      tasksDone: p.tasks.filter(t => t.done).length,
      tasksTotal: p.tasks.length,
    },
    // 공개 명단: 신고되지 않은 사망자는 'in'으로 보여 정보가 새지 않습니다.
    roster: list(room).map(q => ({
      id: q.id, name: q.name,
      ready: room.phase === 'lobby' ? q.ready : undefined,
      ack: room.phase === 'briefing' ? q.ack : undefined,
      pub: started ? PUBLIC_STATUS(q) : 'in',
    })),
    progress: started ? progress(room) : null,
    emergencyReadyAt: room.emergencyReadyAt,
    meeting: meetingView(room),
    lastResult: room.phase === 'result' ? room.lastResult : null,
  };
  if (p.role === 'mafia' && room.phase !== 'lobby') {
    const mates = list(room).filter(q => q.role === 'mafia' && q.id !== p.id);
    v.mafia = {
      mates: mates.map(q => ({ name: q.name, out: q.status !== 'alive' })),
      killReadyAt: p.killReadyAt,
      killRemainMs: room.paused && p.killReadyAt ? Math.max(0, p.killReadyAt - room.pausedAt) : null,
      targets: p.status === 'alive' && started
        ? list(room).filter(q => q.role !== 'mafia' && q.status === 'alive').map(q => ({ id: q.id, name: q.name }))
        : [],
    };
  }
  if (room.phase === 'voting' && room.vote) {
    const b = room.vote.ballots[p.id];
    v.vote = {
      eligible: room.vote.eligible.includes(p.id),
      cast: b === undefined ? null : (b === 'skip' ? '건너뛰기' : (room.players[b] || {}).name),
      candidates: room.vote.eligible.map(id => room.players[id]).filter(q => q && q.status === 'alive').map(q => ({ id: q.id, name: q.name })),
    };
  }
  if (room.phase === 'ended') {
    v.end = {
      ...room.end,
      roles: list(room).map(q => ({ name: q.name, role: q.role, status: q.status })),
    };
  }
  return v;
}

function hostView(room, connected) {
  const pr = room.startedAt ? progress(room) : null;
  return {
    serverNow: now(),
    version: room.version,
    code: room.code,
    gameNo: room.gameNo,
    phase: room.phase,
    paused: room.paused,
    seq: room.phaseSeq,
    phaseEndsAt: room.phaseEndsAt,
    remainMs: room.paused && room.phaseEndsAt ? room.phaseEndsAt - room.pausedAt : null,
    settings: room.settings,
    locations: room.locations,
    missions: room.missions || [],
    progress: pr,
    emergencyReadyAt: room.emergencyReadyAt,
    meeting: meetingView(room),
    lastResult: room.lastResult,
    end: room.end,
    vote: room.vote ? {
      eligible: room.vote.eligible.length,
      cast: Object.keys(room.vote.ballots).length,
      ballots: room.vote.eligible.map(id => ({ name: room.players[id] && room.players[id].name, voted: room.vote.ballots[id] !== undefined })),
    } : null,
    players: list(room).map(p => ({
      id: p.id, name: p.name, role: p.role, status: p.status, ready: p.ready, ack: p.ack,
      online: !!connected(p.id), recovery: p.recovery, code: p.code,
      tasksDone: p.tasks.filter(t => t.done).length, tasksTotal: p.tasks.length,
      task: room.startedAt ? taskView(room, p) : null,
      emergencyLeft: p.emergencyLeft, killReadyAt: p.killReadyAt,
    })),
    log: room.log.slice(-300),
    historyCount: room.history.length,
  };
}

module.exports = {
  GameError, DEFAULT_SETTINGS, createRoom, join, recover, updateSettings, saveLocations, saveMissions, kick,
  assignRoles, ack, setReady, startGame, kill, scan, answer, report, emergency,
  startDiscussion, extendDiscussion, startVoting, castVote, closeVoting, resumeActivity,
  tick, pause, unpause, hostRevive, hostSetDead, hostCompleteTask, hostMeeting, hostEnd, newGame,
  playerView, hostView, progress, checkWin, normalizeScan, list,
};
