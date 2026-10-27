// 참가자·진행자 화면 공용 도구
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* 무시 */ } },
};

async function postJSON(path, body) {
  let r;
  try {
    r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch (_) {
    return { ok: false, error: '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.', network: true };
  }
  let data = {};
  try { data = await r.json(); } catch (_) { /* 무시 */ }
  if (!r.ok) return { ok: false, error: data.error || '요청이 실패했습니다.', view: data.view };
  return { ok: true, ...data };
}

// 서버 시각 기준 타이머
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;
function syncClock(view) { if (view && view.serverNow) clockOffset = view.serverNow - Date.now(); }
function fmtSec(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}`;
}
// 한국어 단위 표시: 1분 30초, 45초
function fmtKr(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}분${s % 60 ? ' ' + (s % 60) + '초' : ''}` : `${s}초`;
}
// data-until="서버시각ms" 요소를 매 0.25초 갱신. data-frozen="ms"면 고정 표시.
setInterval(() => {
  document.querySelectorAll('[data-until]').forEach(el => {
    const frozen = el.getAttribute('data-frozen');
    const left = frozen !== null && frozen !== '' ? Number(frozen) : Number(el.dataset.until) - serverNow();
    el.textContent = (el.dataset.prefix || '') + (el.dataset.unit === 'kr' ? fmtKr(left) : fmtSec(left)) + (el.dataset.suffix || '');
    if (el.classList.contains('timer')) el.classList.toggle('urgent', left <= 10000);
    const onDone = el.dataset.done;
    if (left <= 0 && onDone && !el.dataset.fired) { el.dataset.fired = '1'; window.dispatchEvent(new Event(onDone)); }
  });
}, 250);

function toast(msg, kind = '', ms = 2600) {
  document.querySelectorAll('.toast').forEach(x => x.remove());
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  document.body.appendChild(t);
  if (navigator.vibrate && kind) { try { navigator.vibrate(kind === 'bad' ? [80, 60, 80] : 60); } catch (_) { /* 무시 */ } }
  setTimeout(() => t.remove(), ms);
}

// 하단 시트 모달. html 안의 [data-act] 버튼에 handlers를 연결합니다.
function openModal(html, handlers = {}, id = 'modal') {
  closeModal(id);
  const m = document.createElement('div');
  m.className = 'modal'; m.id = id;
  m.innerHTML = `<div class="sheet">${html}</div>`;
  m.addEventListener('click', (e) => {
    if (e.target === m) return closeModal(id);
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const fn = handlers[b.dataset.act];
    if (b.dataset.act === 'close') return closeModal(id);
    if (fn) fn(b, m);
  });
  document.body.appendChild(m);
  return m;
}
function closeModal(id = 'modal') { const m = document.getElementById(id); if (m) m.remove(); }
function confirmBox(title, body, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2>${body ? `<p class="muted">${body}</p>` : ''}<div class="btns" style="margin-top:16px">
      <button class="${danger ? 'danger' : 'primary'}" data-act="ok">${esc(okLabel)}</button>
      <button data-act="no">취소</button></div>`, {
      ok: () => { closeModal('confirm'); resolve(true); },
      no: () => { closeModal('confirm'); resolve(false); },
    }, 'confirm');
    const m = document.getElementById('confirm');
    m.addEventListener('click', (e) => { if (e.target === m) resolve(false); });
  });
}

// 실시간 연결 (Server-Sent Events). 끊기면 자동 재접속하고 복귀 시 상태를 다시 받습니다.
function connectStream(code, token, { onState, onDenied, onKicked, onStatus }) {
  let es = null, closed = false, retryTimer = null;
  const open = () => {
    if (closed) return;
    if (es) es.close();
    es = new EventSource(`/api/events?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`);
    es.addEventListener('open', () => onStatus(true));
    es.addEventListener('state', (e) => { onStatus(true); const v = JSON.parse(e.data); syncClock(v); onState(v); });
    es.addEventListener('denied', (e) => { closed = true; es.close(); onDenied(JSON.parse(e.data).error); });
    es.addEventListener('kicked', (e) => { closed = true; es.close(); onKicked(JSON.parse(e.data).reason); });
    es.addEventListener('error', () => {
      onStatus(false);
      if (es.readyState === EventSource.CLOSED && !closed) { clearTimeout(retryTimer); retryTimer = setTimeout(open, 2000); }
    });
  };
  open();
  // 화면 잠금·앱 전환 후 돌아오면 즉시 재연결해 최신 상태를 받습니다.
  const vis = () => { if (document.visibilityState === 'visible' && !closed) open(); };
  document.addEventListener('visibilitychange', vis);
  window.addEventListener('online', vis);
  window.addEventListener('pageshow', (e) => { if (e.persisted) vis(); });
  // 무료 호스팅이 잠들지 않도록 주기적으로 신호를 보냅니다.
  const ping = setInterval(() => { if (document.visibilityState === 'visible') fetch('/api/ping', { cache: 'no-store' }).catch(() => {}); }, 240000);
  return { close() { closed = true; clearInterval(ping); if (es) es.close(); document.removeEventListener('visibilitychange', vis); } };
}

const PHASE_NAME = {
  lobby: '대기', briefing: '역할 확인', active: '활동', gathering: '회의 집결',
  discussion: '토론', voting: '투표', result: '투표 결과', ended: '게임 종료',
};
const ROLE_NAME = { mafia: '마피아', citizen: '시민' };
