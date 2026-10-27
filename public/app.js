// 참가자 화면
'use strict';

const params = new URLSearchParams(location.search);
const S = {
  code: (params.get('room') || store.get('mafia:last') || '').toUpperCase(),
  token: null,
  view: null,
  online: false,
  roleShown: false,
  secretOpen: false,
  pendingScan: params.get('s'),
  busy: false,
  stream: null,
  prev: null,
  notice: null,
};
if (S.code) S.token = store.get('mafia:p:' + S.code);
if (S.pendingScan) {
  // 주소창에서 스캔 값을 지워 새로고침 시 다시 실행되지 않게 합니다.
  const u = new URL(location.href); u.searchParams.delete('s');
  history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams : ''));
}

const app = $('#app');

// ───────────── 입장 ─────────────
function renderHome(mode = 'join', err = '') {
  app.innerHTML = `<main>
    <h1>🕵️ 야외 마피아</h1>
    ${S.notice ? `<div class="card danger">${esc(S.notice)}</div>` : ''}
    <div class="card">
      ${mode === 'join' ? `
      <form id="joinForm" autocomplete="off">
        <label>방 코드</label>
        <input id="fCode" class="code" maxlength="4" value="${esc(S.code)}" placeholder="ABCD" autocapitalize="characters">
        <label>이름 (현장에서 부르는 이름)</label>
        <input id="fName" maxlength="12" placeholder="예: 김지민" value="${esc(store.get('mafia:name') || '')}">
        ${err ? `<p style="color:var(--bad);font-weight:700">${esc(err)}</p>` : ''}
        <button class="primary" style="margin-top:16px">입장하기</button>
      </form>
      <button class="ghostbtn" id="toRecover" style="margin-top:10px">복구 코드로 다시 들어가기</button>` : `
      <form id="recForm" autocomplete="off">
        <h2>다시 들어가기</h2>
        <p class="muted small">입장할 때 받은 6자리 복구 코드를 입력하세요. 모르면 진행자에게 물어보세요.</p>
        <label>방 코드</label>
        <input id="fCode" class="code" maxlength="4" value="${esc(S.code)}" autocapitalize="characters">
        <label>복구 코드</label>
        <input id="fRec" class="code" maxlength="6" inputmode="numeric" placeholder="000000">
        ${err ? `<p style="color:var(--bad);font-weight:700">${esc(err)}</p>` : ''}
        <button class="primary" style="margin-top:16px">복구하기</button>
      </form>
      <button class="ghostbtn" id="toJoin" style="margin-top:10px">처음 입장하기</button>`}
    </div>
    <p class="center small muted">진행자이신가요? <a href="/host" style="color:var(--accent)">방 만들기</a></p>
  </main>`;
  const j = $('#joinForm'), r = $('#recForm');
  if (j) j.onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#fCode').value.trim().toUpperCase(), name = $('#fName').value.trim();
    if (!code || !name) return renderHome('join', '방 코드와 이름을 입력하세요.');
    const res = await postJSON('/api/join', { code, name });
    if (!res.ok) return renderHome('join', res.error);
    store.set('mafia:name', name);
    enter(res.code, res.token);
  };
  if (r) r.onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#fCode').value.trim().toUpperCase();
    const res = await postJSON('/api/recover', { code, recovery: $('#fRec').value.trim() });
    if (!res.ok) return renderHome('recover', res.error);
    enter(res.code, res.token);
  };
  const tr = $('#toRecover'), tj = $('#toJoin');
  if (tr) tr.onclick = () => { S.notice = null; renderHome('recover'); };
  if (tj) tj.onclick = () => { S.notice = null; renderHome('join'); };
}

function enter(code, token) {
  S.code = code; S.token = token; S.notice = null;
  store.set('mafia:p:' + code, token);
  store.set('mafia:last', code);
  const u = new URL(location.href); u.searchParams.set('room', code);
  history.replaceState(null, '', u.pathname + '?' + u.searchParams);
  connect();
}

function leave(msg) {
  if (S.stream) S.stream.close();
  S.stream = null; S.view = null; S.token = null;
  store.del('mafia:p:' + S.code);
  Scanner.close(); closeModal();
  S.notice = msg || null;
  renderHome();
}

function connect() {
  if (S.stream) S.stream.close();
  app.innerHTML = '<main><p class="muted center" style="margin-top:40vh">연결 중…</p></main>';
  S.stream = connectStream(S.code, S.token, {
    onState: (v) => {
      const prev = S.view; S.view = v;
      // 주기적 동기화로 같은 상태가 다시 오면 화면을 다시 그리지 않습니다(펼친 메뉴 유지).
      if (prev && prev.version === v.version) return;
      onChange(prev, v); render();
    },
    onDenied: (msg) => leave(msg),
    onKicked: (msg) => leave(msg),
    onStatus: (on) => { if (S.online !== on) { S.online = on; renderBars(); } },
  });
}

// ───────────── 상태 변화 반응 ─────────────
function onChange(prev, v) {
  if (!prev) {
    if (S.pendingScan && v.phase !== 'lobby') { const s = S.pendingScan; S.pendingScan = null; setTimeout(() => handleScan(s), 300); }
    else S.pendingScan = null;
    return;
  }
  const vib = (p) => { if (navigator.vibrate) try { navigator.vibrate(p); } catch (_) { /* 무시 */ } };
  if (prev.seq !== v.seq) {
    // 단계가 바뀌면 열려 있던 선택 창은 닫습니다(오래된 선택 방지).
    closeModal(); closeModal('confirm');
  }
  if (prev.phase !== v.phase) {
    if (v.phase !== 'active') Scanner.close();
    if (v.phase === 'gathering') { vib([300, 100, 300, 100, 300]); S.secretOpen = false; }
    if (v.phase === 'voting' || v.phase === 'ended' || v.phase === 'briefing') vib(200);
    S.roleShown = false;
  }
  if (prev.me.status !== 'dead' && v.me.status === 'dead') { Scanner.close(); vib([600, 200, 600]); }
  if (prev.paused !== v.paused) Scanner.close();
}

// ───────────── 행동 ─────────────
async function act(action, extra = {}) {
  if (!S.online) { toast('연결이 끊겨 있습니다. 연결되면 다시 눌러 주세요.', 'bad'); return null; }
  if (S.busy) return null;
  S.busy = true;
  try {
    const res = await postJSON('/api/act', { code: S.code, token: S.token, action, seq: S.view && S.view.seq, ...extra });
    if (res.view) { syncClock(res.view); const prev = S.view; S.view = res.view; onChange(prev, res.view); render(); }
    if (!res.ok) { toast(res.error, 'bad', 3200); return null; }
    return res.result || {};
  } finally { S.busy = false; }
}

async function handleScan(value) {
  const r = await act('scan', { value });
  if (!r) return;
  if (r.kind === 'done') toast('✅ ' + r.message, 'good', 3000);
  else if (r.kind === 'body') {
    if (!r.canReport) return toast(r.message, '', 3000);
    openModal(`<div class="center"><div class="emoji">🚨</div><h2>${esc(r.name)} 님이 쓰러져 있습니다</h2>
      <p class="muted">직접 쓰러진 사람을 발견했을 때만 신고하세요.</p></div>
      <div class="btns" style="margin-top:16px"><button class="danger" data-act="report">시체 신고 → 회의 소집</button><button data-act="close">취소</button></div>`, {
      report: async () => { closeModal(); const x = await act('report', { qr: value }); if (x) toast('신고했습니다. 집결 장소로 모이세요!', 'good'); },
    });
  } else if (r.kind === 'question') toast('표지를 보고 아래에서 답을 고르세요.', '', 3000);
  else toast(r.message || '확인했습니다.', '', 3000);
}

function openScan() { Scanner.open('장소 QR 또는 쓰러진 사람의 이름표', handleScan); }

function openKill() {
  const v = S.view, m = v.mafia;
  if (!m.targets.length) return toast('선택할 수 있는 대상이 없습니다.', 'bad');
  openModal(`<h2>🔪 대상 선택</h2>
    <p class="muted small">약 3m 안에서 상대를 직접 보고 있을 때만 실행하세요. 앱은 거리를 확인하지 않습니다.</p>
    ${m.targets.map(t => `<button class="choice" data-act="pick" data-id="${esc(t.id)}" data-name="${esc(t.name)}">${esc(t.name)}</button>`).join('')}
    <button data-act="close" style="margin-top:16px">취소</button>`, {
    pick: async (b) => {
      closeModal();
      const yes = await confirmBox(`${b.dataset.name} 님을 암살합니까?`, '실행하면 되돌릴 수 없습니다.', '암살 실행', true);
      if (!yes) return;
      const r = await act('kill', { target: b.dataset.id });
      if (r) toast(`${r.targetName} 님을 암살했습니다. 자연스럽게 자리를 떠나세요.`, 'good', 3500);
    },
  });
}

async function doEmergency() {
  const yes = await confirmBox('긴급회의를 요청합니까?', `남은 횟수 ${S.view.me.emergencyLeft}회. 모두가 집결 장소로 모입니다.`, '긴급회의 요청', true);
  if (!yes) return;
  const r = await act('emergency');
  if (r) toast('긴급회의를 요청했습니다.', 'good');
}

function openVote(id, name) {
  confirmBox(id === 'skip' ? '건너뛰기에 투표합니까?' : `${name} 님에게 투표합니까?`, '확정하면 바꿀 수 없습니다.', '투표 확정').then(async (yes) => {
    if (!yes) return;
    const r = await act('vote', { target: id });
    if (r) toast('투표를 확정했습니다.', 'good');
  });
}

// ───────────── 화면 그리기 ─────────────
function statusChip(me) {
  if (me.status === 'alive') return '<span class="chip alive">생존</span>';
  if (me.status === 'dead') return '<span class="chip dead">사망</span>';
  return '<span class="chip ghost">유령</span>';
}

function renderBars() {
  const v = S.view;
  const top = $('#topbar'), ban = $('#banners');
  if (!v || !top) return;
  top.innerHTML = `<span class="dot ${S.online ? '' : 'off'}" title="${S.online ? '연결됨' : '연결 끊김'}"></span>
    <span class="who">${esc(v.me.name)}</span>
    <span class="chip">${esc(PHASE_NAME[v.phase] || v.phase)}</span>
    ${v.phase !== 'lobby' && v.phase !== 'briefing' && v.phase !== 'ended' ? statusChip(v.me) : ''}`;
  ban.innerHTML = (!S.online ? '<div class="banner off">연결 끊김 — 재연결 중입니다. 지금은 행동할 수 없습니다.</div>' : '')
    + (v.paused ? '<div class="banner pause">⏸ 일시 정지 — 진행자 안내를 기다리세요</div>' : '');
  document.querySelectorAll('[data-needs-online]').forEach(b => { b.disabled = !S.online || v.paused || b.dataset.off === '1'; });
}

function render() {
  const v = S.view;
  if (!v) return;
  let body = '';
  switch (v.phase) {
    case 'lobby': body = viewLobby(v); break;
    case 'briefing': body = viewBriefing(v); break;
    case 'active': body = v.me.status === 'dead' ? viewDead(v) : viewActive(v); break;
    case 'gathering': case 'discussion': body = viewMeeting(v); break;
    case 'voting': body = viewVoting(v); break;
    case 'result': body = viewResult(v); break;
    case 'ended': body = viewEnded(v); break;
    default: body = '<p>알 수 없는 단계</p>';
  }
  app.innerHTML = `<div class="topbar" id="topbar"></div><div id="banners"></div><main>${body}</main>`;
  renderBars();
}

function viewLobby(v) {
  return `
    <div class="card hl center">
      <div class="phase">대기 중 · 방 ${esc(v.code)}</div>
      <div class="big" style="margin:8px 0">${esc(v.me.name)}</div>
      <p class="muted small">진행자가 역할을 배정할 때까지 기다리세요.</p>
      <button class="${v.me.ready ? 'good' : 'primary'}" data-a="ready" data-needs-online style="margin-top:12px">${v.me.ready ? '✔ 준비 완료 (누르면 취소)' : '준비 완료 누르기'}</button>
    </div>
    <div class="card">
      <h3>복구 코드</h3>
      <p><span class="kbd" style="font-size:24px">${esc(v.me.recovery)}</span></p>
      <p class="muted small">휴대폰을 바꾸거나 화면이 사라지면 이 코드로 다시 들어옵니다. 다른 사람에게 보여 주지 마세요.</p>
    </div>
    <div class="card">
      <h3>입장한 사람 ${v.roster.length}명</h3>
      <ul class="list">${v.roster.map(r => `<li><span class="name">${esc(r.name)}</span>${r.ready ? '<span class="chip alive">준비</span>' : ''}</li>`).join('')}</ul>
    </div>
    ${rulesCard()}`;
}

function rulesCard() {
  return `<details class="card"><summary style="font-weight:800;cursor:pointer">게임 규칙 보기</summary>
    <ul class="small" style="padding-left:20px">
      <li><b>시민</b>: 장소 QR을 찍어 임무를 하고, 회의에서 마피아를 찾아 추방합니다. 임무를 모두 끝내거나 마피아를 모두 추방하면 승리.</li>
      <li><b>마피아</b>: 위장 임무를 하며 몰래 암살합니다. 살아 있는 마피아 수가 시민 수 이상이 되면 승리.</li>
      <li><b>암살</b>: 약 3m 안에서 상대를 직접 보고 있을 때만. 당한 사람은 그 자리에 멈추고 말하지 않습니다.</li>
      <li><b>신고</b>: 쓰러진 사람의 이름표 QR을 찍으면 회의가 열립니다. 직접 발견했을 때만 찍으세요.</li>
      <li><b>유령</b>: 회의 후 탈락자는 유령으로 임무만 계속합니다. 말하거나 힌트를 주면 안 됩니다.</li>
    </ul></details>`;
}

function roleBlock(v, compact) {
  const role = v.me.role;
  const shown = S.roleShown;
  const mates = v.mafia ? v.mafia.mates : [];
  return `<div class="rolecard ${shown ? 'shown ' + role : ''}" data-a="toggleRole" ${compact ? 'style="padding:14px"' : ''}>
    ${shown ? `<div class="muted small">나의 역할</div><div class="rname" ${compact ? 'style="font-size:32px"' : ''}>${ROLE_NAME[role]}</div>
      ${role === 'mafia' ? `<p>동료: <b>${mates.length ? mates.map(m => esc(m.name) + (m.out ? ' (탈락)' : '')).join(', ') : '없음'}</b></p>` : ''}
      <p class="small muted">눌러서 숨기기</p>`
    : `<div class="emoji">🂠</div><p style="font-weight:800">눌러서 역할 보기</p><p class="small muted">주변에서 보지 않게 확인하세요</p>`}
  </div>`;
}

function viewBriefing(v) {
  const role = v.me.role;
  return `
    <h1>역할 확인</h1>
    ${roleBlock(v)}
    <div class="card">
      ${role === 'mafia'
        ? `<p><b>마피아 할 일</b></p><ul class="small" style="padding-left:20px"><li>위장 임무를 하며 시민처럼 행동하세요(진행률에는 반영되지 않습니다).</li><li>암살은 <b>약 3m 안에서 직접 보고 있을 때만</b>. 대기시간이 있습니다.</li><li>동료를 감싸 주되 들키지 마세요.</li></ul>`
        : `<p><b>시민 할 일</b></p><ul class="small" style="padding-left:20px"><li>안내되는 장소로 가서 QR을 찍어 임무를 완료하세요.</li><li>쓰러진 사람을 발견하면 이름표 QR로 신고하세요.</li><li>회의에서 수상한 사람을 찾아 투표하세요.</li></ul>`}
    </div>
    ${v.me.ack ? '<div class="card good center">✔ 확인 완료. 진행자가 시작할 때까지 기다리세요.</div>'
      : '<button class="primary" data-a="ack" data-needs-online>역할과 규칙을 확인했습니다</button>'}
    <p class="center muted small" style="margin-top:12px">확인 ${v.roster.filter(r => r.ack).length} / ${v.roster.length}명</p>`;
}

function taskCard(v) {
  const t = v.me.task;
  if (!t) return `<div class="card good center"><div class="emoji">🎉</div><h2>내 임무를 모두 끝냈습니다</h2><p class="muted small">다른 사람을 도우며 수상한 행동을 지켜보세요.</p></div>`;
  let how = '';
  if (t.type === 'visit') how = `<b>${esc(t.loc)}</b>에 가서 장소 QR을 찍으세요.`;
  if (t.type === 'carry') how = t.step === 0
    ? `<b>${esc(t.loc)}</b>에서 QR을 찍고 물품 하나를 집으세요. 도착지: <b>${esc(t.loc2)}</b>`
    : `물품을 들고 <b>${esc(t.loc2)}</b>로 가서 상자에 넣고 QR을 찍으세요.`;
  if (t.type === 'report') how = t.step === 1 && t.options
    ? `<b>${esc(t.question)}</b>`
    : `<b>${esc(t.loc)}</b>에 가서 QR을 찍고 표지를 확인하세요.`;
  const label = t.title ? esc(t.title) : { visit: '방문 점검', carry: '물품 운반', report: '현장 보고' }[t.type];
  return `<div class="card hl">
    <div class="row"><h3 style="margin:0">임무 ${t.index} / ${t.total} · ${label}</h3></div>
    <p style="font-size:20px;margin-top:8px">📍 ${how}</p>
    ${t.desc ? `<p class="small" style="color:var(--accent)">${esc(t.desc)}</p>` : ''}
    ${t.type === 'report' && t.step === 1 && t.options ? t.options.map(o => `<button class="choice" data-a="answer" data-task="${esc(t.id)}" data-opt="${esc(o)}" data-needs-online>${esc(o)}</button>`).join('') : ''}
    ${t.type === 'carry' && t.step === 1 ? '<p class="small muted">출발지 확인 완료 ✔</p>' : ''}
  </div>`;
}

function viewActive(v) {
  const me = v.me, pr = v.progress;
  const ghost = me.status === 'ghost';
  const emLeft = serverNow() < v.emergencyReadyAt;
  const mafiaPanel = v.mafia && me.status === 'alive' ? `
    <div class="card" style="border-color:${S.secretOpen ? 'var(--bad)' : 'var(--line)'}">
      <button class="ghostbtn sm" data-a="toggleSecret" style="width:100%">${S.secretOpen ? '비밀 메뉴 닫기' : '비밀 메뉴 열기'}</button>
      ${S.secretOpen ? `
        <p class="small" style="margin-top:10px">동료: <b>${v.mafia.mates.map(m => esc(m.name) + (m.out ? ' (탈락)' : '')).join(', ') || '없음'}</b></p>
        ${(() => {
          const ready = v.mafia.killReadyAt <= serverNow() && !v.paused;
          return `<button class="danger" data-a="kill" data-needs-online ${ready ? '' : 'data-off="1"'} style="margin-top:8px">${ready ? '🔪 암살하기' : `🔪 암살 대기 <span data-until="${v.mafia.killReadyAt}" ${v.paused ? `data-frozen="${v.mafia.killRemainMs}"` : ''} data-unit="kr" data-done="rerender"></span>`}</button>`;
        })()}` : ''}
    </div>` : '';
  return `
    ${ghost ? '<div class="card" style="border-color:#34407a;background:#141a33"><b>👻 유령 상태</b><p class="small muted">말하거나 힌트를 주지 마세요. 임무는 계속 진행률에 반영됩니다(시민).</p></div>' : ''}
    ${taskCard(v)}
    <div class="card">
      <div class="row"><h3 style="margin:0">공동 임무 진행률</h3><b style="flex:0">${pr.pct}%</b></div>
      <div class="progress" style="margin-top:8px"><div style="width:${Math.min(100, pr.pct)}%"></div></div>
      <p class="small muted">목표 ${pr.goal}% 달성 시 시민 승리</p>
    </div>
    ${mafiaPanel}
    ${roleBlock(v, true)}
    ${!ghost ? `<div class="card">
      <button class="ghostbtn" data-a="emergency" data-needs-online ${me.emergencyLeft <= 0 || emLeft ? 'data-off="1"' : ''}>
        📢 긴급회의 ${me.emergencyLeft <= 0 ? '(사용 완료)' : emLeft ? `<span data-until="${v.emergencyReadyAt}" data-unit="kr" data-suffix=" 후 가능" data-done="rerender"></span>` : `(남은 ${me.emergencyLeft}회)`}
      </button></div>` : ''}
    <div class="dock"><div class="inner"><button class="primary" data-a="scan" data-needs-online>📷 QR 스캔 / 코드 입력</button></div></div>`;
}

function viewDead() {
  return `<div class="fullscreen deadscreen">
    <div class="emoji">💀</div>
    <div class="big">당신은 쓰러졌습니다</div>
    <div class="card danger" style="text-align:left">
      <p>• <b>지금부터 말하지 마세요.</b></p>
      <p>• 이 자리에서 이름표가 보이게 하고 발견될 때까지 기다리세요.</p>
      <p>• 다른 곳에서 회의가 열리면 집결 장소로 이동하세요.</p>
      <p>• 회의가 끝나면 유령으로 임무를 이어 갑니다.</p>
    </div>
  </div>`;
}

function meetingHead(v) {
  const m = v.meeting || {};
  const why = m.trigger === 'report' ? `🚨 <b>${esc(m.by)}</b> 님이 <b>${esc(m.body)}</b> 님을 발견해 신고했습니다.`
    : m.trigger === 'emergency' ? `📢 <b>${esc(m.by)}</b> 님이 긴급회의를 요청했습니다.`
    : '📢 진행자가 회의를 소집했습니다.';
  return `<p>${why}</p>
    <div class="card danger"><h3>이번 회의에서 확인된 탈락자</h3>
    ${m.revealed && m.revealed.length ? `<p class="big" style="font-size:24px">${m.revealed.map(esc).join(', ')}</p>` : '<p>새로 확인된 사망자가 없습니다.</p>'}</div>`;
}

function rosterCard(v) {
  return `<div class="card"><h3>참가자</h3><ul class="list">${v.roster.map(r => `<li class="${r.pub !== 'in' ? 'out' : ''}"><span class="name">${esc(r.name)}</span>${r.pub === 'dead' ? '<span class="chip dead">사망</span>' : r.pub === 'ejected' ? '<span class="chip dead">추방</span>' : ''}</li>`).join('')}</ul></div>`;
}

function viewMeeting(v) {
  const m = v.meeting || {};
  const ghostNote = v.me.status !== 'alive' ? '<div class="card" style="border-color:#34407a"><b>👻 탈락자는 회의에서 말할 수 없습니다.</b><p class="small muted">조용히 함께 있어 주세요.</p></div>' : '';
  if (v.phase === 'gathering') {
    return `<div class="meetingscreen center">
      <div class="emoji">🔔</div><div class="big">회의 소집!</div>
      <p style="font-size:22px;margin-top:10px">집결 장소: <b style="color:var(--accent)">${esc(m.place)}</b></p>
    </div>
    ${meetingHead(v)}${ghostNote}
    <p class="center muted">모두 모이면 진행자가 토론을 시작합니다.</p>
    ${rosterCard(v)}`;
  }
  return `<div class="phase center">토론</div>
    <div class="timer" data-until="${v.phaseEndsAt}" ${v.paused ? `data-frozen="${v.remainMs}"` : ''}></div>
    ${meetingHead(v)}${ghostNote}${rosterCard(v)}`;
}

function viewVoting(v) {
  const vt = v.vote || {};
  let inner;
  if (!vt.eligible) inner = '<div class="card center"><b>투표권이 없습니다.</b><p class="muted small">결과를 기다리세요.</p></div>';
  else if (vt.cast) inner = `<div class="card good center"><div class="emoji">🗳️</div><h2>투표 완료</h2><p>선택: <b>${esc(vt.cast)}</b></p><p class="muted small">다른 사람의 선택은 마감 후 득표수만 공개됩니다.</p></div>`;
  else inner = `<div class="card"><h3>누구를 추방할까요?</h3>
      ${vt.candidates.map(c => `<button class="choice" data-a="vote" data-id="${esc(c.id)}" data-name="${esc(c.name)}" data-needs-online>${esc(c.name)}${c.id === v.me.id ? ' (나)' : ''}</button>`).join('')}
      <button class="choice" data-a="vote" data-id="skip" data-name="건너뛰기" data-needs-online style="margin-top:16px;border-style:dashed">⏭ 건너뛰기</button></div>`;
  return `<div class="phase center">투표</div>
    <div class="timer" data-until="${v.phaseEndsAt}" ${v.paused ? `data-frozen="${v.remainMs}"` : ''}></div>${inner}`;
}

function viewResult(v) {
  const r = v.lastResult || {};
  return `<div class="meetingscreen center">
      <div class="emoji">${r.ejected ? '🚪' : '🤝'}</div>
      <div class="big">${esc(r.why || '')}</div>
      ${r.ejected && r.ejectedRole ? `<p style="font-size:22px">${esc(r.ejected)} 님은 <b>${ROLE_NAME[r.ejectedRole]}</b>였습니다.</p>` : ''}
    </div>
    <div class="card"><h3>득표 결과</h3><ul class="list">
      ${(r.tally || []).map(t => `<li><span class="name">${esc(t.name)}</span><b>${t.count}표</b></li>`).join('') || '<li><span class="name muted">득표 없음</span></li>'}
      <li><span class="name">⏭ 건너뛰기</span><b>${r.skip || 0}표</b></li>
      <li><span class="name muted">미투표</span><span class="muted">${r.noVote || 0}명</span></li>
    </ul></div>
    <p class="center muted">진행자가 활동을 재개하면 다시 흩어집니다.</p>`;
}

function viewEnded(v) {
  const e = v.end || {};
  const title = e.winner === 'citizen' ? '🎉 시민 승리' : e.winner === 'mafia' ? '🔪 마피아 승리' : '⏹ 진행자 종료';
  const mine = e.winner === v.me.role;
  return `<div class="fullscreen" style="min-height:auto;padding:20px 0">
      <div class="big" style="font-size:40px">${title}</div>
      <p style="font-size:20px">${esc(e.reason)}</p>
      ${e.winner !== 'host' ? `<p class="chip ${mine ? 'alive' : 'dead'}" style="align-self:center;font-size:18px">${mine ? '우리 팀 승리!' : '아쉽게 패배'}</p>` : ''}
    </div>
    <div class="card"><h3>전체 역할 공개</h3><ul class="list">
      ${e.roles.map(r => `<li class="${r.status !== 'alive' ? 'out' : ''}"><span class="name">${esc(r.name)}</span><span class="chip ${r.role}">${ROLE_NAME[r.role] || '-'}</span></li>`).join('')}
    </ul></div>
    <p class="center muted small">진행자가 새 게임을 열면 자동으로 대기 화면으로 바뀝니다.</p>`;
}

// ───────────── 이벤트 ─────────────
app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || b.disabled) return;
  const v = S.view, a = b.dataset.a;
  if (a === 'toggleRole') { S.roleShown = !S.roleShown; return render(); }
  if (a === 'toggleSecret') { S.secretOpen = !S.secretOpen; return render(); }
  if (a === 'ready') return act('ready', { ready: !v.me.ready });
  if (a === 'ack') return act('ack');
  if (a === 'scan') return openScan();
  if (a === 'kill') return openKill();
  if (a === 'emergency') return doEmergency();
  if (a === 'vote') return openVote(b.dataset.id, b.dataset.name);
  if (a === 'answer') return act('answer', { taskId: b.dataset.task, option: b.dataset.opt }).then(r => { if (r && r.message) toast('✅ ' + r.message, 'good', 3000); });
});
window.addEventListener('rerender', () => render());
// 대기시간이 끝나는 순간 버튼을 다시 활성화하기 위해 1초마다 확인
setInterval(() => {
  const v = S.view;
  if (!v || v.phase !== 'active' || document.querySelector('.modal')) return;
  const killBtn = document.querySelector('[data-a="kill"][data-off="1"]');
  if (killBtn && v.mafia && v.mafia.killReadyAt <= serverNow() && !v.paused) render();
}, 1000);

// ───────────── 시작 ─────────────
if (S.code && S.token) connect();
else renderHome();
