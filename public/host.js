// 진행자 화면
'use strict';

const qp = new URLSearchParams(location.search);
const H = {
  code: null, token: null, view: null, online: false, tab: 'run', stream: null, busy: false,
  locDraft: null, settingsDirty: false,
};
const app = $('#app');

// 다른 기기에서 진행자 링크(/host?code=..&key=..)로 들어온 경우
if (qp.get('code') && qp.get('key')) {
  store.set('mafia:host:' + qp.get('code').toUpperCase(), qp.get('key'));
  store.set('mafia:hostlast', qp.get('code').toUpperCase());
  history.replaceState(null, '', '/host');
}
H.code = store.get('mafia:hostlast');
if (H.code) H.token = store.get('mafia:host:' + H.code);

function renderStart(err = '') {
  app.innerHTML = `<main>
    <h1>🎛 진행자</h1>
    <div class="card">
      <p>새 방을 만들면 방 코드와 입장 QR이 생깁니다. 이 휴대폰(또는 노트북)이 진행자 기기가 됩니다.</p>
      ${err ? `<p style="color:var(--bad);font-weight:700">${esc(err)}</p>` : ''}
      <button class="primary" id="create" style="margin-top:12px">새 방 만들기</button>
    </div>
    <p class="center small"><a href="/" style="color:var(--accent)">참가자 화면으로</a></p>
  </main>`;
  $('#create').onclick = async () => {
    const r = await postJSON('/api/rooms', {});
    if (!r.ok) return renderStart(r.error);
    H.code = r.code; H.token = r.hostToken;
    store.set('mafia:host:' + r.code, r.hostToken);
    store.set('mafia:hostlast', r.code);
    connect();
  };
}

function connect() {
  if (H.stream) H.stream.close();
  app.innerHTML = '<main><p class="muted center" style="margin-top:40vh">연결 중…</p></main>';
  H.stream = connectStream(H.code, H.token, {
    onState: (v) => {
      const prev = H.view; H.view = v;
      if (prev && prev.version === v.version && document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        renderBars(); return; // 입력 중에는 화면을 다시 그리지 않음
      }
      if (prev && prev.version === v.version && H.tab !== 'run' && H.tab !== 'players') { renderBars(); return; }
      render();
    },
    onDenied: (msg) => { store.del('mafia:hostlast'); H.stream = null; renderStart(msg); },
    onKicked: () => {},
    onStatus: (on) => { if (H.online !== on) { H.online = on; renderBars(); } },
  });
}

async function act(action, extra = {}, okMsg) {
  if (!H.online) { toast('연결이 끊겨 있습니다.', 'bad'); return null; }
  if (H.busy) return null;
  H.busy = true;
  try {
    const r = await postJSON('/api/act', { code: H.code, token: H.token, action, ...extra });
    if (r.view) { syncClock(r.view); H.view = r.view; render(); }
    if (!r.ok) { toast(r.error, 'bad', 3500); return null; }
    if (okMsg) toast(okMsg, 'good');
    return r;
  } finally { H.busy = false; }
}

// ───────────── 화면 ─────────────
function renderBars() {
  const v = H.view, top = $('#topbar');
  if (!v || !top) return;
  top.innerHTML = `<span class="dot ${H.online ? '' : 'off'}"></span><span class="who">진행자 · 방 ${esc(v.code)} · ${v.gameNo}판</span>
    <span class="chip">${esc(PHASE_NAME[v.phase])}${v.paused ? ' ⏸' : ''}</span>`;
}

function render() {
  const v = H.view;
  if (!v) return;
  const tabs = [['run', '진행'], ['players', `참가자 ${v.players.length}`], ['settings', '설정'], ['places', '장소·QR'], ['missions', `임무 ${v.missions.length || '자동'}`], ['log', '기록']];
  let body = '';
  if (H.tab === 'run') body = tabRun(v);
  if (H.tab === 'players') body = tabPlayers(v);
  if (H.tab === 'settings') body = tabSettings(v);
  if (H.tab === 'places') body = tabPlaces(v);
  if (H.tab === 'missions') body = tabMissions(v);
  if (H.tab === 'log') body = tabLog(v);
  const scrollY = window.scrollY;
  app.innerHTML = `<div class="topbar" id="topbar"></div>
    ${!H.online ? '<div class="banner off">연결 끊김 — 재연결 중</div>' : ''}
    ${v.paused ? '<div class="banner pause">⏸ 일시 정지 중 — 참가자 행동이 모두 막혀 있습니다</div>' : ''}
    <div class="tabs">${tabs.map(([k, n]) => `<button class="${H.tab === k ? 'on' : ''}" data-tab="${k}">${n}</button>`).join('')}</div>
    <main>${body}</main>`;
  renderBars();
  window.scrollTo(0, scrollY);
}

function counts(v) {
  const ps = v.players;
  const c = (f) => ps.filter(f).length;
  return {
    total: ps.length,
    aliveM: c(p => p.role === 'mafia' && p.status === 'alive'),
    aliveC: c(p => p.role === 'citizen' && p.status === 'alive'),
    hidden: c(p => p.status === 'dead'),
    online: c(p => p.online),
  };
}

function tabRun(v) {
  const k = counts(v);
  const joinUrl = `${location.origin}/?room=${v.code}`;
  let main = '';
  const pauseBtn = v.phase !== 'lobby' && v.phase !== 'ended' && v.phase !== 'briefing'
    ? (v.paused ? '<button class="good" data-run="unpause">일시 정지 해제 (게임 재개)</button>' : '<button data-run="pause">일시 정지</button>') : '';

  if (v.phase === 'lobby') {
    const m = v.settings.mafiaCount, n = k.total;
    const okSetup = n >= 3 && m < n - m;
    main = `<div class="card hl center">
        <div class="phase">입장 받는 중</div>
        <div class="big" style="font-size:44px;letter-spacing:6px">${esc(v.code)}</div>
        <div class="qrbox"><img src="/qr.svg?text=${encodeURIComponent(joinUrl)}" alt="입장 QR"></div>
        <p class="small muted" style="word-break:break-all">${esc(joinUrl)}</p>
        <button class="sm" data-run="copyJoin">입장 링크 복사</button>
      </div>
      <div class="grid2"><div class="stat"><b>${n}</b>입장</div><div class="stat"><b>${v.players.filter(p => p.ready).length}</b>준비</div></div>
      <div class="card"><p>배정 예정: 마피아 <b>${m}</b>명 · 시민 <b>${Math.max(0, n - m)}</b>명 <button class="sm" data-tab="settings">변경</button></p>
        ${okSetup ? '' : `<p style="color:var(--warn)">${n < 3 ? '최소 3명이 필요합니다.' : '마피아는 시민보다 적어야 합니다.'}</p>`}
        <button class="primary" data-run="assign" ${okSetup ? '' : 'disabled'}>역할 무작위 배정</button>
        <p class="small muted">배정 전에 장소 QR과 이름표 QR을 출력해 두세요 (장소·QR 탭).</p>
      </div>`;
  } else if (v.phase === 'briefing') {
    const acked = v.players.filter(p => p.ack).length;
    main = `<div class="card hl"><div class="phase">역할 확인 중</div>
        <p class="big">${acked} / ${k.total}명 확인</p>
        <p class="small muted">아직: ${v.players.filter(p => !p.ack).map(p => esc(p.name)).join(', ') || '없음'}</p>
        <div class="btns"><button class="primary" data-run="start">게임 시작</button><button data-run="assign">역할 다시 배정</button></div></div>`;
  } else if (v.phase === 'active') {
    const pr = v.progress;
    main = `<div class="card hl"><div class="phase">활동 중</div>
        <div class="row" style="margin-top:6px"><b>시민 임무 ${pr.done}/${pr.total} (${pr.pct}%)</b><span class="muted small" style="flex:0;white-space:nowrap">목표 ${pr.goal}%</span></div>
        <div class="progress" style="margin-top:8px"><div style="width:${Math.min(100, pr.pct)}%"></div></div></div>
      <div class="grid2"><div class="stat"><b style="color:var(--bad)">${k.aliveM}</b>생존 마피아</div><div class="stat"><b style="color:var(--blue)">${k.aliveC}</b>생존 시민</div>
        <div class="stat"><b>${k.hidden}</b>미발견 사망</div><div class="stat"><b>${k.online}/${k.total}</b>접속</div></div>
      <div class="btns" style="margin-top:12px"><button data-run="meeting">📢 회의 강제 소집</button></div>`;
  } else if (['gathering', 'discussion'].includes(v.phase)) {
    const m = v.meeting || {};
    main = `<div class="card hl"><div class="phase">${v.phase === 'gathering' ? '회의 집결' : '토론'}</div>
        <p>${m.trigger === 'report' ? `🚨 ${esc(m.by)} → ${esc(m.body)} 신고` : m.trigger === 'emergency' ? `📢 ${esc(m.by)} 긴급회의` : '📢 진행자 소집'}</p>
        <p>공개된 탈락자: <b>${(m.revealed || []).map(esc).join(', ') || '없음'}</b></p>
        <p class="small muted">집결 장소: ${esc(m.place)}</p>
        ${v.phase === 'discussion' ? `<div class="timer" data-until="${v.phaseEndsAt}" ${v.paused ? `data-frozen="${v.remainMs}"` : ''}></div>` : ''}</div>
      <div class="btns">${v.phase === 'gathering'
        ? '<button class="primary" data-run="discussion">모두 모였음 → 토론 시작</button><button data-run="vote">토론 없이 바로 투표</button>'
        : '<button class="primary" data-run="vote">지금 투표 시작</button><button data-run="extend">토론 1분 연장</button>'}</div>`;
  } else if (v.phase === 'voting') {
    const vt = v.vote || { cast: 0, eligible: 0, ballots: [] };
    main = `<div class="card hl"><div class="phase">투표 중</div>
        <div class="timer" data-until="${v.phaseEndsAt}" ${v.paused ? `data-frozen="${v.remainMs}"` : ''}></div>
        <p class="big center">${vt.cast} / ${vt.eligible}명 투표</p>
        <p class="small muted">미투표: ${vt.ballots.filter(b => !b.voted).map(b => esc(b.name)).join(', ') || '없음'}</p></div>
      <button data-run="closeVote">지금 투표 마감</button>`;
  } else if (v.phase === 'result') {
    const r = v.lastResult || {};
    main = `<div class="card hl"><div class="phase">투표 결과</div><p class="big" style="font-size:24px">${esc(r.why)}</p>
        <ul class="list">${(r.tally || []).map(t => `<li><span class="name">${esc(t.name)}</span><b>${t.count}표</b></li>`).join('')}
        <li><span class="name">건너뛰기</span><b>${r.skip}</b></li><li><span class="name muted">미투표</span>${r.noVote}</li></ul></div>
      <button class="primary" data-run="resume">▶ 활동 재개</button>`;
  } else if (v.phase === 'ended') {
    const e = v.end || {};
    main = `<div class="card hl center"><div class="phase">게임 종료</div>
        <div class="big">${e.winner === 'citizen' ? '🎉 시민 승리' : e.winner === 'mafia' ? '🔪 마피아 승리' : '⏹ 진행자 종료'}</div><p>${esc(e.reason)}</p></div>
      <button class="primary" data-run="newGame">같은 참가자로 새 게임 준비</button>`;
  }

  const dangerZone = v.phase !== 'lobby' ? `<div class="card"><h3>관리</h3><div class="btns">
      ${pauseBtn}
      ${v.phase !== 'ended' && v.phase !== 'briefing' ? '<button class="danger" data-run="end">게임 종료 (진행자 종료로 기록)</button>' : ''}
      ${v.phase !== 'ended' ? '<button class="ghostbtn" data-run="newGame">게임 초기화 → 대기 화면</button>' : ''}
    </div><p class="small muted">사망 오처리 복구·임무 수동 완료는 일시 정지 후 참가자 탭에서 합니다.</p></div>` : '';
  return main + dangerZone + `<details class="card"><summary style="font-weight:800;cursor:pointer">다른 기기에서 진행하기</summary>
    <p class="small muted">이 링크를 연 기기도 진행자가 됩니다. 참가자에게 보여 주지 마세요.</p>
    <button class="sm" data-run="copyHost">진행자 링크 복사</button>
    <p class="small muted" style="margin-top:14px">완전히 새 방이 필요하면:</p>
    <button class="sm" data-run="newRoom">이 기기에서 새 방 만들기</button></details>`;
}

const STATUS_NAME = { alive: '생존', dead: '미발견 사망', deadRevealed: '사망(공개)', ejected: '추방' };
function tabPlayers(v) {
  const fixable = v.paused && v.phase !== 'ended' && v.phase !== 'lobby' && v.phase !== 'briefing';
  return `${!fixable && v.phase !== 'lobby' ? '<p class="small muted">오류 수정 버튼은 일시 정지 중에만 나타납니다.</p>' : ''}
  <table class="ptable">${v.players.map(p => {
    const task = p.task ? `${p.tasksDone}/${p.tasksTotal} · 현재: ${esc(p.task.loc)}${p.task.type === 'carry' ? '→' + esc(p.task.loc2) : ''}` : (p.tasksTotal ? `${p.tasksDone}/${p.tasksTotal} 완료` : '');
    return `<tr><td>
      <div class="row" style="gap:6px"><span class="dot ${p.online ? '' : 'off'}" style="flex:0 0 12px"></span>
      <b style="flex:1">${esc(p.name)}</b>
      ${p.role ? `<span class="chip ${p.role}" style="flex:0">${ROLE_NAME[p.role]}</span>` : ''}
      ${v.phase !== 'lobby' ? `<span class="chip ${p.status === 'alive' ? 'alive' : 'dead'}" style="flex:0">${STATUS_NAME[p.status]}</span>` : p.ready ? '<span class="chip alive" style="flex:0">준비</span>' : ''}</div>
      <div class="small muted">복구 코드 <span class="kbd">${esc(p.recovery)}</span> · 이름표 코드 <span class="kbd">${esc(p.code)}</span> ${task ? '· 임무 ' + task : ''}</div>
      <div class="acts">
        ${v.phase === 'lobby' ? `<button class="sm" data-pact="kick" data-id="${p.id}" data-name="${esc(p.name)}">내보내기</button>` : ''}
        ${fixable && p.status !== 'alive' ? `<button class="sm good" data-pact="revive" data-id="${p.id}" data-name="${esc(p.name)}">생존으로 복구</button>` : ''}
        ${fixable && p.status === 'alive' ? `<button class="sm" data-pact="setDead" data-id="${p.id}" data-name="${esc(p.name)}">사망 처리</button>` : ''}
        ${fixable && p.task ? `<button class="sm" data-pact="completeTask" data-id="${p.id}" data-name="${esc(p.name)}">현재 임무 완료 처리</button>` : ''}
      </div></td></tr>`;
  }).join('') || '<tr><td class="muted">아직 입장한 사람이 없습니다.</td></tr>'}</table>`;
}

const SETTING_FIELDS = [
  ['mafiaCount', '마피아 수', '명'], ['tasksPerPlayer', '1인당 임무 수', '개'], ['taskGoalPct', '시민 임무 승리 목표', '%'],
  ['killCooldown', '암살 대기시간', '초'], ['startProtect', '시작 직후 암살 보호', '초'], ['resumeProtect', '회의 후 암살 보호', '초'],
  ['emergencyPerPlayer', '긴급회의 1인당 횟수', '회'], ['emergencyCooldown', '긴급회의 대기 (시작·재개 후)', '초'],
  ['discussionSec', '토론 시간', '초'], ['voteSec', '투표 시간', '초'],
];
function tabSettings(v) {
  const s = v.settings, locked = v.phase !== 'lobby';
  return `${locked ? '<div class="card">설정은 대기 단계에서만 바꿀 수 있습니다. 바꾸려면 새 게임을 준비하세요.</div>' : ''}
  <form id="setForm" class="card">
    <div class="grid2">${SETTING_FIELDS.map(([key, label, unit]) => `<div><label>${label} (${unit})</label><input type="number" inputmode="numeric" name="${key}" value="${s[key]}" ${locked ? 'disabled' : ''}></div>`).join('')}</div>
    <label>회의 집결 장소</label><input name="gatherPlace" value="${esc(s.gatherPlace)}" ${locked ? 'disabled' : ''}>
    <label class="check"><input type="checkbox" name="revealEjectedRole" ${s.revealEjectedRole ? 'checked' : ''} ${locked ? 'disabled' : ''}> 추방된 사람의 역할 공개</label>
    ${locked ? '' : '<button class="primary" style="margin-top:12px">설정 저장</button>'}
  </form>
  <div class="card small muted">20명 기준 제안: 마피아 3명, 장소 4~5곳, 1인당 임무 4개. 현장 시험 후 조정하세요.</div>`;
}

function tabPlaces(v) {
  const locked = v.phase !== 'lobby';
  if (!H.locDraft || locked) H.locDraft = JSON.parse(JSON.stringify(v.locations));
  const printBase = `/print?code=${v.code}&token=${encodeURIComponent(H.token)}`;
  return `<div class="card"><h3>QR 출력</h3><div class="btns">
      <a class="btn primary" href="${printBase}&what=all" target="_blank">🖨 전체 출력 (입장·장소·이름표)</a>
      <div class="row"><a class="btn" href="${printBase}&what=places" target="_blank">장소 QR</a><a class="btn" href="${printBase}&what=players" target="_blank">이름표 QR</a></div></div>
      <p class="small muted">이름표 QR은 참가자가 모두 입장한 뒤 출력하세요. 장소를 바꾸면 다시 출력해야 합니다.</p></div>
    ${locked ? '<div class="card">장소는 대기 단계에서만 바꿀 수 있습니다.</div>' : ''}
    <div id="locs">${H.locDraft.map((l, i) => `<div class="locedit" data-i="${i}">
      <div class="row"><input data-f="name" value="${esc(l.name)}" placeholder="장소 이름" ${locked ? 'disabled' : ''} style="flex:3">
        ${l.code ? `<span class="kbd" style="flex:0">${esc(l.code)}</span>` : ''}
        ${locked ? '' : `<button class="sm" data-loc="del" data-i="${i}" style="flex:0">삭제</button>`}</div>
      <label class="check"><input type="checkbox" data-f="item" ${l.item ? 'checked' : ''} ${locked ? 'disabled' : ''}> 물품 출발지 (운반할 물건 비치)</label>
      <label class="check"><input type="checkbox" data-f="box" ${l.box ? 'checked' : ''} ${locked ? 'disabled' : ''}> 도착 상자 비치</label>
      <label class="check"><input type="checkbox" data-f="hasSign" ${l.sign ? 'checked' : ''} ${locked ? 'disabled' : ''}> 현장 보고 표지 있음</label>
      ${l.sign ? `<input data-f="q" value="${esc(l.sign.question)}" placeholder="질문 (예: 카드 색은?)" ${locked ? 'disabled' : ''} style="margin-top:6px">
        <input data-f="opts" value="${esc(l.sign.options.join(', '))}" placeholder="선택지 (쉼표로 구분)" ${locked ? 'disabled' : ''} style="margin-top:6px">
        <input data-f="ans" value="${esc(l.sign.answer)}" placeholder="정답 (선택지 중 하나)" ${locked ? 'disabled' : ''} style="margin-top:6px">` : ''}
    </div>`).join('')}</div>
    ${locked ? '' : `<div class="btns"><button data-loc="add">+ 장소 추가</button><button class="primary" data-loc="save">장소 저장</button></div>
    <p class="small muted">운반 임무는 '물품 출발지'에서 다른 장소의 '도착 상자'로 갑니다. 출발지와 상자가 모두 있어야 배정됩니다.</p>`}`;
}

const MTYPE = { visit: '방문 점검', report: '현장 보고', carry: '물품 운반' };
function tabMissions(v) {
  const locked = v.phase !== 'lobby';
  if (!H.misDraft || locked) H.misDraft = JSON.parse(JSON.stringify(v.missions));
  const d = H.misDraft, per = v.settings.tasksPerPlayer;
  const dis = locked ? 'disabled' : '';
  const locOpts = (sel) => `<option value="">장소 선택</option>` + v.locations.map(l => `<option value="${esc(l.id)}" ${l.id === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const head = d.length
    ? `<p>등록된 임무 <b>${d.length}개</b> 중에서 한 사람에게 <b>${Math.min(per, d.length)}개</b>씩, 사람마다 다른 순서로 배정합니다.</p>
       ${d.length < per ? `<p style="color:var(--warn)">1인당 임무 수(${per}개)보다 목록이 적어 ${d.length}개씩만 배정됩니다.</p>` : ''}`
    : '<p>임무 목록이 비어 있어 <b>장소 정보로 자동 배정</b>합니다. 직접 정하려면 임무를 추가하거나 아래 버튼으로 기본 임무를 채운 뒤 고치세요.</p>';
  return `${locked ? '<div class="card">임무는 대기 단계에서만 바꿀 수 있습니다.</div>' : ''}
    <div class="card">${head}<p class="small muted">장소를 먼저 장소·QR 탭에서 저장해야 여기에서 고를 수 있습니다.</p></div>
    <div id="missions">${d.map((m, i) => `<div class="locedit" data-mi="${i}">
      <div class="row"><b style="flex:0;white-space:nowrap">${i + 1}.</b>
        <select data-m="type" ${dis} style="flex:2">${Object.entries(MTYPE).map(([k, n]) => `<option value="${k}" ${m.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        ${locked ? '' : `<button class="sm" data-mis="del" data-i="${i}" style="flex:0">삭제</button>`}</div>
      <input data-m="title" value="${esc(m.title || '')}" placeholder="임무 이름 (선택, 예: 소화기 점검)" ${dis} style="margin-top:8px">
      <label>${m.type === 'carry' ? '출발 장소' : '장소'}</label><select data-m="loc" ${dis}>${locOpts(m.loc)}</select>
      ${m.type === 'carry' ? `<label>도착 장소</label><select data-m="loc2" ${dis}>${locOpts(m.loc2)}</select>` : ''}
      <input data-m="desc" value="${esc(m.desc || '')}" placeholder="참가자에게 보일 안내 (선택, 예: 빨간 공 하나를 옮기세요)" ${dis} style="margin-top:8px">
      ${m.type === 'report' ? `<input data-m="q" value="${esc((m.q && m.q.question) || '')}" placeholder="질문 (예: 표지판의 그림은?)" ${dis} style="margin-top:8px">
        <input data-m="opts" value="${esc(((m.q && m.q.options) || []).join(', '))}" placeholder="선택지 (쉼표로 구분)" ${dis} style="margin-top:8px">
        <input data-m="ans" value="${esc((m.q && m.q.answer) || '')}" placeholder="정답 (선택지 중 하나)" ${dis} style="margin-top:8px">` : ''}
    </div>`).join('')}</div>
    ${locked ? '' : `<div class="btns"><button data-mis="add">+ 임무 추가</button>
      <button data-mis="fill">장소 정보로 기본 임무 채우기</button>
      <button class="primary" data-mis="save">임무 저장</button>
      ${d.length ? '<button class="ghostbtn" data-mis="clear">목록 비우기 (자동 배정으로)</button>' : ''}</div>
      <p class="small muted">현장 보고 임무의 정답은 QR 인쇄 페이지의 정답표에도 나옵니다. 저장하지 않고 다른 탭으로 가면 고친 내용이 사라집니다.</p>`}`;
}
function syncMisDraft() {
  document.querySelectorAll('[data-mi]').forEach(el => {
    const m = H.misDraft[Number(el.dataset.mi)];
    const g = (f) => el.querySelector(`[data-m="${f}"]`);
    m.type = g('type').value; m.title = g('title').value; m.loc = g('loc').value; m.desc = g('desc').value;
    if (g('loc2')) m.loc2 = g('loc2').value;
    if (g('q')) m.q = { question: g('q').value, options: g('opts').value.split(',').map(x => x.trim()).filter(Boolean), answer: g('ans').value.trim() };
  });
}
function defaultMissions(v) {
  const out = [];
  for (const l of v.locations) {
    out.push({ type: 'visit', loc: l.id, title: '', desc: '' });
    if (l.sign) out.push({ type: 'report', loc: l.id, title: '', desc: '', q: JSON.parse(JSON.stringify(l.sign)) });
    const dest = l.item && v.locations.find(b => b.box && b.id !== l.id);
    if (dest) out.push({ type: 'carry', loc: l.id, loc2: dest.id, title: '', desc: '' });
  }
  return out;
}
function renderKeepMis() { const d = H.misDraft; render(); H.misDraft = d; }

function syncLocDraft() {
  document.querySelectorAll('.locedit').forEach(el => {
    const l = H.locDraft[Number(el.dataset.i)];
    const g = (f) => el.querySelector(`[data-f="${f}"]`);
    l.name = g('name').value;
    l.item = g('item').checked; l.box = g('box').checked;
    if (g('hasSign').checked) {
      l.sign = l.sign || { question: '', options: [], answer: '' };
      if (g('q')) { l.sign.question = g('q').value; l.sign.options = g('opts').value.split(',').map(s => s.trim()).filter(Boolean); l.sign.answer = g('ans').value.trim(); }
    } else l.sign = null;
  });
}

const LOG_FMT = {
  assign: (l) => `역할 배정 (마피아: ${l.mafia.join(', ')})`, start: () => '게임 시작',
  kill: (l) => `🔪 ${l.by} → ${l.target} 암살`, report: (l) => `🚨 ${l.by}이(가) ${l.body} 신고 (공개: ${l.revealed.join(', ') || '없음'})`,
  emergency: (l) => `📢 ${l.by} 긴급회의 (공개: ${l.revealed.join(', ') || '없음'})`, hostMeeting: (l) => `📢 진행자 회의 소집 (공개: ${l.revealed.join(', ') || '없음'})`,
  task: (l) => `✅ ${l.by}(${ROLE_NAME[l.role]}${l.status !== 'alive' ? '·유령' : ''}) 임무 완료`,
  vote: (l) => `🗳 ${l.by} → ${l.target}`, voteResult: (l) => `투표 결과: ${l.why}`,
  resume: () => '▶ 활동 재개', pause: () => '⏸ 일시 정지', unpause: () => '▶ 일시 정지 해제',
  fix: (l) => `🛠 진행자 수정: ${l.target} ${l.action}`, end: (l) => `🏁 종료: ${l.reason}`,
};
function tabLog(v) {
  const t = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `<p class="small muted">진행자만 볼 수 있는 기록입니다. 참가자에게 보여 주지 마세요.</p>
    <div class="card log">${v.log.slice().reverse().map(l => `<div><span class="muted">${t(l.t)}</span> ${esc((LOG_FMT[l.type] || (() => l.type))(l))}</div>`).join('') || '기록 없음'}</div>`;
}

// ───────────── 이벤트 ─────────────
app.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { H.tab = tab.dataset.tab; if (H.tab === 'places') H.locDraft = null; if (H.tab === 'missions') H.misDraft = null; return render(); }

  const run = e.target.closest('[data-run]');
  if (run && !run.disabled) {
    const a = run.dataset.run, v = H.view;
    if (a === 'copyJoin' || a === 'copyHost') {
      const text = a === 'copyJoin' ? `${location.origin}/?room=${v.code}` : `${location.origin}/host?code=${v.code}&key=${encodeURIComponent(H.token)}`;
      try { await navigator.clipboard.writeText(text); toast('복사했습니다.', 'good'); } catch (_) { prompt('복사하세요', text); }
      return;
    }
    if (a === 'newRoom') {
      if (!(await confirmBox('새 방을 만들까요?', '현재 방은 서버에 남지만, 이 기기에서는 진행자 링크로만 다시 열 수 있습니다. 먼저 진행자 링크를 복사해 두세요.', '새 방으로'))) return;
      if (H.stream) H.stream.close();
      store.del('mafia:hostlast'); H.view = null; H.tab = 'run';
      return renderStart();
    }
    if (a === 'start') {
      const notAck = v.players.filter(p => !p.ack);
      if (notAck.length && !(await confirmBox('아직 확인하지 않은 사람이 있습니다', `${notAck.map(p => esc(p.name)).join(', ')}<br>그래도 시작할까요?`, '그래도 시작'))) return;
      return act('start', { force: notAck.length > 0 }, '게임을 시작했습니다.');
    }
    if (a === 'assign' && v.phase === 'briefing' && !(await confirmBox('역할을 다시 배정할까요?', '모든 역할과 임무가 새로 정해집니다.', '다시 배정'))) return;
    if (a === 'end' && !(await confirmBox('게임을 종료할까요?', '팀 승리 없이 "진행자 종료"로 기록되고 전체 역할이 공개됩니다.', '게임 종료', true))) return;
    if (a === 'newGame' && v.phase !== 'ended' && !(await confirmBox('게임을 초기화할까요?', '진행 중인 판은 기록으로 보관되고, 같은 참가자로 대기 화면으로 돌아갑니다.', '초기화', true))) return;
    if (a === 'meeting' && !(await confirmBox('회의를 강제로 소집할까요?', '지금까지의 사망자가 모두 공개됩니다.', '소집'))) return;
    if (a === 'closeVote' && !(await confirmBox('투표를 지금 마감할까요?', '투표하지 않은 사람은 미투표로 처리됩니다.', '마감'))) return;
    if (a === 'extend') return act('extend', { sec: 60 }, '1분 연장했습니다.');
    return act(a);
  }

  const pact = e.target.closest('[data-pact]');
  if (pact) {
    const a = pact.dataset.pact, label = { kick: '내보내기', revive: '생존으로 복구', setDead: '사망 처리', completeTask: '현재 임무 완료 처리' }[a];
    if (!(await confirmBox(`${pact.dataset.name}: ${label}`, a === 'kick' ? '' : '수정 이력이 기록됩니다.', label, a !== 'revive'))) return;
    return act(a, { pid: pact.dataset.id }, '처리했습니다.');
  }

  const mis = e.target.closest('[data-mis]');
  if (mis) {
    syncMisDraft();
    const a = mis.dataset.mis;
    if (a === 'add') { H.misDraft.push({ type: 'visit', loc: '', title: '', desc: '' }); return renderKeepMis(); }
    if (a === 'del') { H.misDraft.splice(Number(mis.dataset.i), 1); return renderKeepMis(); }
    if (a === 'fill') {
      if (H.misDraft.length && !(await confirmBox('기본 임무로 채울까요?', '지금 목록 뒤에 장소마다 기본 임무가 추가됩니다.', '채우기'))) return;
      H.misDraft = H.misDraft.concat(defaultMissions(H.view)); return renderKeepMis();
    }
    if (a === 'clear') {
      if (!(await confirmBox('임무 목록을 비울까요?', '저장하면 장소 정보로 자동 배정하는 방식으로 돌아갑니다.', '비우기', true))) return;
      H.misDraft = []; return renderKeepMis();
    }
    if (a === 'save') {
      const r = await act('missions', { missions: H.misDraft });
      if (r) { H.misDraft = null; toast('임무를 저장했습니다.', 'good'); render(); }
      return;
    }
  }

  const loc = e.target.closest('[data-loc]');
  if (loc) {
    syncLocDraft();
    if (loc.dataset.loc === 'add') { H.locDraft.push({ name: '', item: false, box: true, sign: null }); return renderKeepDraft(); }
    if (loc.dataset.loc === 'del') { H.locDraft.splice(Number(loc.dataset.i), 1); return renderKeepDraft(); }
    if (loc.dataset.loc === 'save') {
      const r = await act('locations', { locations: H.locDraft });
      if (r) { H.locDraft = null; toast('장소를 저장했습니다. QR을 다시 출력하세요.', 'good'); render(); }
    }
  }
});
app.addEventListener('change', (e) => {
  if (e.target.matches('[data-m="type"]')) { syncMisDraft(); return renderKeepMis(); }
  if (e.target.matches('[data-f="hasSign"]')) { syncLocDraft(); renderKeepDraft(); }
});
function renderKeepDraft() {
  const d = H.locDraft; render(); H.locDraft = d; // tabPlaces는 대기 단계에서 초안을 유지
}
app.addEventListener('submit', async (e) => {
  if (e.target.id !== 'setForm') return;
  e.preventDefault();
  const f = new FormData(e.target), settings = {};
  SETTING_FIELDS.forEach(([k]) => { settings[k] = Number(f.get(k)); });
  settings.gatherPlace = f.get('gatherPlace');
  settings.revealEjectedRole = f.get('revealEjectedRole') === 'on';
  act('settings', { settings }, '설정을 저장했습니다.');
});

if (H.code && H.token) connect();
else renderStart();
