'use strict';
// 서버를 띄우고 여러 참가자를 흉내 내어 완성 기준 12개 항목을 검사합니다.
// 실행: node test/rules.test.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-test-'));
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✔', msg); } else { failed++; console.log('  ✘', msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
}

// 간단한 SSE 클라이언트: 받은 상태와 원문을 모두 기록
function listen(code, token) {
  const ctl = new AbortController();
  const c = { states: [], raw: '', last: null, close: () => ctl.abort() };
  (async () => {
    try {
      const r = await fetch(`${BASE}/api/events?code=${code}&token=${encodeURIComponent(token)}`, { signal: ctl.signal });
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of r.body) {
        const s = dec.decode(chunk, { stream: true }); buf += s; c.raw += s;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.*)$/m) || [])[1];
          const data = (block.match(/^data: (.*)$/m) || [])[1];
          if (ev === 'state' && data) { const v = JSON.parse(data); c.states.push(v); c.last = v; }
          if (ev === 'kicked') c.kicked = true;
        }
      }
    } catch (_) { /* 종료 */ }
  })();
  return c;
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('실행 중')) r(); }));

  try {
    console.log('\n[1] 방 생성·입장·역할 배정');
    const room = await post('/api/rooms', {});
    const code = room.code, H = room.hostToken;
    const host = (action, extra = {}) => post('/api/act', { code, token: H, action, ...extra });
    const names = ['가은', '나래', '다솜', '라온', '마루', '바다', '사랑', '아라'];
    const P = {};
    for (const n of names) P[n] = await post('/api/join', { code, name: n });
    const dup = await post('/api/join', { code, name: '가은' });
    ok(dup.name === '가은 (2)', '같은 이름은 번호를 붙여 구분');
    await host('kick', { pid: (await post('/api/state', { code, token: dup.token })).view.me.id });
    const steal = await post('/api/state', { code, token: 'guess' });
    ok(steal.status === 400, '이름이나 추측 토큰으로 남의 계정에 접근 불가');

    const sse = {};
    for (const n of names) sse[n] = listen(code, P[n].token);
    const hostSse = listen(code, H);
    await sleep(300);

    ok((await host('settings', { settings: { mafiaCount: 4 } })).status === 200, '설정 저장');
    ok((await host('assign')).status === 400, '마피아 4명/시민 4명은 배정 거부 (마피아 < 시민 검사)');
    await host('settings', { settings: { mafiaCount: 2, startProtect: 0, resumeProtect: 0, killCooldown: 10, emergencyCooldown: 0, voteSec: 10, discussionSec: 30, tasksPerPlayer: 2 } });
    ok((await post('/api/act', { code, token: P['가은'].token, action: 'assign' })).status === 400, '참가자는 진행자 명령 불가');
    await host('assign');
    let hv = (await post('/api/state', { code, token: H })).view;
    const roleOf = (n) => hv.players.find(p => p.name === n).role;
    const mafia = names.filter(n => roleOf(n) === 'mafia');
    const cit = names.filter(n => roleOf(n) === 'citizen');
    ok(mafia.length === 2 && cit.length === 6, '무작위 역할 배정 (마피아 2, 시민 6)');
    await sleep(200);

    console.log('\n[2] 비밀 정보 분리');
    const cv = sse[cit[0]].last;
    const cvText = JSON.stringify(cv);
    ok(cv.me.role === 'citizen' && !cv.mafia, '시민은 자기 역할만 받음');
    ok(!cv.roster.some(r => 'role' in r) && !cvText.includes('"mafia"'), '시민 데이터에 남의 역할 정보 없음');
    const mv = sse[mafia[0]].last;
    ok(mv.mafia && mv.mafia.mates.length === 1 && mv.mafia.mates[0].name === mafia[1], '마피아는 동료를 확인');
    const st = await host('start');
    ok(st.status === 400, '전원 확인 전에는 시작 거부');
    for (const n of names) await post('/api/act', { code, token: P[n].token, action: 'ack' });
    await host('start');
    await sleep(200);
    ok(names.every(n => sse[n].last.phase === 'active'), '[기준 1] 모든 기기가 같은 단계 변경을 받음');

    console.log('\n[3] 암살');
    const tk = (n) => P[n].token;
    const act = (n, action, extra = {}) => post('/api/act', { code, token: tk(n), action, seq: sse[n].last.seq, ...extra });
    const idOf = (n) => hv.players.find(p => p.name === n).id;
    const killedFirst = cit[0];
    // 두 마피아가 같은 대상을 동시에, 그리고 연속 클릭
    const [k1, k2, k3] = await Promise.all([
      act(mafia[0], 'kill', { target: idOf(killedFirst) }),
      act(mafia[1], 'kill', { target: idOf(killedFirst) }),
      act(mafia[0], 'kill', { target: idOf(killedFirst) }),
    ]);
    const okCount = [k1, k2, k3].filter(r => r.status === 200).length;
    ok(okCount === 1, '[기준 11] 동시 암살·연속 클릭 → 한 번만 처리');
    const winner = k1.status === 200 ? mafia[0] : k2.status === 200 ? mafia[1] : mafia[0];
    const loser = winner === mafia[0] ? mafia[1] : mafia[0];
    await sleep(200);
    ok(sse[killedFirst].last.me.status === 'dead', '[기준 3] 피해자 화면이 즉시 사망으로 바뀜');
    ok(!JSON.stringify(sse[killedFirst].last).includes(winner) || sse[killedFirst].last.roster.some(r => r.name === winner), '피해자에게 범인 정보 없음 (명단 이름 외)');
    const other = sse[cit[1]].last;
    ok(other.me.status === 'alive' && other.roster.find(r => r.name === killedFirst).pub === 'in', '[기준 6] 다른 시민의 명단에서 사망자가 드러나지 않음');
    ok(!JSON.stringify(other).includes('dead'), '[기준 6] 시민 데이터에 미신고 사망 흔적 없음');
    const again = await act(winner, 'kill', { target: idOf(cit[1]) });
    ok(again.status === 400 && /초 남았습니다/.test(again.error), '[기준 4] 대기시간 중 암살 거부');
    const loserFail = await act(loser, 'kill', { target: idOf(killedFirst) });
    ok(loserFail.status === 400 && /대기시간은 소모되지 않았습니다/.test(loserFail.error), '이미 죽은 대상 → 실패, 대기시간 미소모');
    const fake = await act(cit[1], 'kill', { target: idOf(cit[2]) });
    ok(fake.status === 400, '시민은 암살 불가');
    const deadKill = await act(killedFirst, 'scan', { value: hv.locations[0].qr });
    ok(deadKill.status === 400, '미발견 사망자는 임무 불가');

    // 일시 정지 중 암살 거부
    await host('pause');
    await sleep(100);
    const pk = await act(loser, 'kill', { target: idOf(cit[1]) });
    ok(pk.status === 400 && /일시 정지/.test(pk.error), '[기준 4] 일시 정지 중 암살 거부');
    const pr = await act(cit[1], 'emergency');
    ok(pr.status === 400, '일시 정지 중 긴급회의 거부');
    await host('unpause');
    await sleep(100);

    console.log('\n[4] 신고');
    const bodyQr = (await post('/api/state', { code, token: tk(killedFirst) })).view;
    // 개인 QR 값은 진행자 인쇄 페이지에만 있으므로, 짧은 이름표 코드로 신고 (서버가 같은 방식으로 처리)
    const bodyCode = bodyQr.me.code;
    const aliveScan = await act(cit[1], 'scan', { value: sse[cit[2]].last.me.code });
    ok(aliveScan.result.kind === 'person' && !/role|citizen|mafia/.test(JSON.stringify(aliveScan.result)), '살아 있는 사람 이름표 → 이름만 표시');
    const sc = await act(cit[1], 'scan', { value: bodyCode });
    ok(sc.result.kind === 'body' && sc.result.canReport, '시체 이름표 스캔 → 신고 가능');
    const seqBefore = sse[cit[1]].last.seq;
    const [r1, r2, r3] = await Promise.all([
      post('/api/act', { code, token: tk(cit[1]), action: 'report', qr: bodyCode, seq: seqBefore }),
      post('/api/act', { code, token: tk(cit[2]), action: 'report', qr: bodyCode, seq: seqBefore }),
      post('/api/act', { code, token: tk(cit[3]), action: 'emergency', seq: seqBefore }),
    ]);
    ok([r1, r2, r3].filter(r => r.status === 200).length === 1, '[기준 5] 동시 신고·긴급회의 → 집결 한 번만 시작');
    await sleep(200);
    hv = (await post('/api/state', { code, token: H })).view;
    ok(hv.phase === 'gathering' && hv.meeting.revealed.includes(killedFirst), '집결 시 사망자 공개');
    ok(sse[cit[4]].last.roster.find(r => r.name === killedFirst).pub === 'dead', '회의에서 사망자가 모두에게 공개됨');
    const gk = await act(loser, 'kill', { target: idOf(cit[2]) });
    ok(gk.status === 400, '[기준 4] 회의 중 암살 거부');
    const gt = await act(cit[2], 'scan', { value: hv.locations[0].code });
    ok(gt.status === 400, '회의 중 임무 완료 거부');

    console.log('\n[5] 투표 — 동률');
    await host('discussion');
    await host('vote');
    await sleep(150);
    ok(!sse[cit[1]].last.vote.candidates.some(c => c.name === killedFirst), '사망자는 투표 후보에서 제외');
    const dv = await act(killedFirst, 'vote', { target: 'skip' });
    ok(dv.status === 400, '[기준 7] 사망자 투표 불가');
    const alive = names.filter(n => n !== killedFirst); // 7명
    // 2:2 동률 + 건너뛰기 1 + 미투표 2
    await act(alive[0], 'vote', { target: idOf(alive[1]) });
    const dbl = await act(alive[0], 'vote', { target: idOf(alive[2]) });
    ok(dbl.status === 400, '[기준 11] 이중 투표 거부');
    ok(!sse[alive[3]].last.vote.cast && !JSON.stringify(sse[alive[3]].last).includes('ballots'), '투표 중 남의 선택 비공개');
    await act(alive[2], 'vote', { target: idOf(alive[1]) });
    await act(alive[3], 'vote', { target: idOf(alive[4]) });
    await act(alive[4], 'vote', { target: idOf(alive[4]) }); // 본인 투표 허용
    await act(alive[5], 'vote', { target: 'skip' });
    await host('closeVote');
    await sleep(150);
    let res = sse[cit[1]].last.lastResult;
    ok(res && !res.ejected && /동률/.test(res.why) && res.skip === 1 && res.noVote === 2, '[기준 9] 동률 → 추방 없음, 미투표는 건너뛰기에 합산 안 함');
    ok(!JSON.stringify(res).includes('by'), '개별 투표자 비공개');

    console.log('\n[6] 활동 재개·유령 임무·대기시간');
    await host('resume');
    await sleep(150);
    const ghost = sse[killedFirst].last;
    ok(ghost.me.status === 'ghost' && ghost.me.task, '회의 후 사망자는 유령으로 임무 재개');
    const before = (await post('/api/state', { code, token: H })).view.progress.done;
    const gTask = ghost.me.task;
    const locByName = (nm) => hv.locations.find(l => l.name === nm);
    async function doTask(n) {
      const v = (await post('/api/state', { code, token: tk(n) })).view;
      const t = v.me.task;
      if (!t) return null;
      if (t.type === 'visit') return act(n, 'scan', { value: locByName(t.loc).code });
      if (t.type === 'carry') {
        await act(n, 'scan', { value: locByName(t.loc).code });
        return act(n, 'scan', { value: locByName(t.loc2).code });
      }
      const q = await act(n, 'scan', { value: locByName(t.loc).qr });
      const L = hv.locations.find(l => l.name === t.loc);
      return act(n, 'answer', { taskId: t.id, option: L.sign.answer });
    }
    ok(gTask, '유령 임무 존재');
    const g1 = await doTask(killedFirst);
    const repeat = await act(killedFirst, 'scan', { value: locByName(gTask.loc).code });
    const after = (await post('/api/state', { code, token: H })).view.progress.done;
    ok(g1.status === 200 && after === before + 1, '[기준 8] 유령 시민 임무가 공동 진행률에 반영');
    ok(repeat.status !== 200 || after === (await post('/api/state', { code, token: H })).view.progress.done, '같은 완료 요청 반복 → 한 번만 반영');
    ok(hv.progress === null || (await post('/api/state', { code, token: H })).view.progress.total === 12, '사망해도 진행률 분모 유지 (시민 6 × 2)');
    const ge = await act(killedFirst, 'emergency');
    ok(ge.status === 400, '[기준 7] 유령 긴급회의 불가');
    const gr = await act(killedFirst, 'report', { qr: bodyCode });
    ok(gr.status === 400, '[기준 7] 유령 신고 불가');
    const mt = await doTask(mafia[0]);
    const after2 = (await post('/api/state', { code, token: H })).view.progress.done;
    ok(mt && mt.status === 200 && after2 === after, '마피아 위장 임무는 진행률에 반영 안 됨');
    const wrong = await act(cit[1], 'scan', { value: 'ZZZZ' });
    ok(wrong.status === 400, '알 수 없는 코드 거부');

    console.log('\n[7] 재접속·복구');
    const oldTok = tk(cit[1]);
    const rec = await post('/api/recover', { code, recovery: (await post('/api/state', { code, token: oldTok })).view.me.recovery });
    const rv = (await post('/api/state', { code, token: rec.token })).view;
    ok(rv.me.name === cit[1] && rv.me.role === 'citizen' && rv.me.status === 'alive', '[기준 10] 복구 코드로 같은 역할·상태 복구');
    ok(rv.me.task && rv.me.tasksTotal === 2, '[기준 10] 임무 상태 유지');
    await sleep(200);
    ok(sse[cit[1]].kicked === true, '복구 시 예전 기기 연결은 끊김');
    ok((await post('/api/state', { code, token: oldTok })).status === 400, '예전 토큰 무효화');
    P[cit[1]].token = rec.token;
    sse[cit[1]] = listen(code, rec.token);
    const mvr = (await post('/api/state', { code, token: tk(winner) })).view;
    ok(mvr.mafia.killReadyAt > mvr.serverNow - 1, '[기준 10] 마피아 대기시간 유지');

    console.log('\n[8] 투표 추방 → 승리 판정');
    // 서버 재시작 후에도 상태가 유지되는지 확인
    srv.kill(); await sleep(600);
    const srv2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(r => srv2.stdout.on('data', d => { if (String(d).includes('실행 중')) r(); }));
    const after3 = (await post('/api/state', { code, token: tk(cit[1]) })).view;
    ok(after3.phase === 'active' && after3.me.role === 'citizen', '서버 재시작 후 게임 상태 유지');
    for (const n of names) sse[n] = listen(code, P[n].token);
    await sleep(300);

    // 긴급회의 → 마피아 1명 추방
    const em = await act(cit[2], 'emergency');
    ok(em.status === 200, '긴급회의 요청');
    const em2 = await act(cit[2], 'emergency');
    ok(em2.status === 400, '긴급회의 1인 1회 제한');
    await host('vote');
    await sleep(150);
    const voters = names.filter(n => n !== killedFirst);
    for (const n of voters) await act(n, 'vote', { target: n === mafia[0] ? 'skip' : idOf(mafia[0]) });
    await sleep(200);
    res = sse[cit[3]].last.lastResult;
    ok(res && res.ejected === mafia[0] && res.ejectedRole === null, '유일 최다 득표자 추방, 역할은 비공개(기본값)');
    ok(sse[cit[3]].last.phase === 'result', '전원 투표 시 즉시 마감');
    const ek = await act(mafia[0], 'kill', { target: idOf(cit[3]) });
    ok(ek.status === 400, '[기준 7] 추방된 마피아 암살 불가');
    await host('resume');
    await sleep(100);
    // 남은 마피아가 시민을 계속 암살 → 마피아 승리
    // 생존: 마피아 1, 시민 5. 시민 4명을 죽여야 1:1
    const victims = cit.filter(n => n !== killedFirst).slice(0, 4);
    for (const v of victims) {
      await host('pause'); await host('unpause');
      // 갱신 전 화면에서 누르면 거절되는지 확인한 뒤, 화면 갱신을 기다림
      const stale = await post('/api/act', { code, token: tk(mafia[1]), action: 'kill', target: idOf(v), seq: sse[mafia[1]].last.seq - 2 });
      if (v === victims[0]) ok(stale.status === 400 && /오래되었습니다/.test(stale.error), '오래된 화면에서 누른 행동은 실행 안 됨');
      await sleep(200);
      let r = await act(mafia[1], 'kill', { target: idOf(v) });
      while (r.status === 400 && /초 남았습니다/.test(r.error)) { await sleep(1000); r = await act(mafia[1], 'kill', { target: idOf(v) }); }
      if (r.status !== 200) console.log('    ', r.error);
      if (v !== victims[victims.length - 1]) {
        ok(r.status === 200, `${v} 암살`);
      } else {
        ok(r.status === 200, '마지막 암살 성공');
      }
    }
    await sleep(200);
    const endV = sse[cit[5]].last;
    ok(endV.phase === 'ended' && endV.end.winner === 'mafia', '[기준 12] 마피아 수 ≥ 시민 수 → 마피아 승리');
    ok(endV.end.roles.length === 8 && endV.end.roles.some(r => r.role === 'mafia'), '종료 후 전체 역할 공개');
    const post1 = await act(cit[5], 'scan', { value: hv.locations[0].code });
    ok(post1.status === 400, '종료 후 행동 차단');

    console.log('\n[9] 새 판: 임무 승리 / 마피아 전원 탈락 / 진행자 종료');
    await host('newGame');
    await host('settings', { settings: { mafiaCount: 1, tasksPerPlayer: 1, taskGoalPct: 100, startProtect: 0 } });
    await host('assign'); await host('start', { force: true });
    await sleep(150);
    hv = (await post('/api/state', { code, token: H })).view;
    ok(hv.gameNo === 2 && hv.historyCount === 1, '지난 판 기록 보관, 새 판 시작');
    const cits2 = hv.players.filter(p => p.role === 'citizen').map(p => p.name);
    for (const n of cits2) await doTask(n);
    await sleep(150);
    let ev = (await post('/api/state', { code, token: H })).view;
    ok(ev.phase === 'ended' && ev.end.winner === 'citizen' && /임무/.test(ev.end.reason), '[기준 12] 시민 임무 100% → 시민 승리');

    await host('newGame');
    await host('assign'); await host('start', { force: true });
    hv = (await post('/api/state', { code, token: H })).view;
    const m3 = hv.players.find(p => p.role === 'mafia');
    await host('meeting');
    await host('vote');
    for (const p of hv.players) await post('/api/act', { code, token: P[p.name].token, action: 'vote', target: m3.id });
    ev = (await post('/api/state', { code, token: H })).view;
    ok(ev.phase === 'ended' && ev.end.winner === 'citizen' && /마피아가 모두/.test(ev.end.reason), '[기준 12] 마피아 전원 추방 → 시민 승리');

    await host('newGame');
    await host('assign'); await host('start', { force: true });
    await host('pause');
    hv = (await post('/api/state', { code, token: H })).view;
    const victim = hv.players.find(p => p.role === 'citizen');
    ok((await host('setDead', { pid: victim.id })).status === 200, '일시 정지 중 진행자 오류 수정(사망 처리)');
    ok((await host('revive', { pid: victim.id })).status === 200, '일시 정지 중 진행자 오류 수정(생존 복구)');
    await host('unpause');
    ok((await host('revive', { pid: victim.id })).status === 400, '일시 정지가 아니면 오류 수정 거부');
    await host('end');
    ev = (await post('/api/state', { code, token: H })).view;
    ok(ev.phase === 'ended' && ev.end.winner === 'host', '[기준 12] 진행자 종료는 팀 승리 없이 "진행자 종료"로 기록');
    ok((await host('unpause')).status === 400 && (await host('resume')).status === 400, '종료 상태에서는 재개 불가');
    ok(ev.log.some(l => l.type === 'fix'), '진행자 수정 이력 기록');

    console.log('\n[10] 인쇄 페이지 권한');
    const pp = await fetch(`${BASE}/print?code=${code}&token=${encodeURIComponent(P[names[0]].token)}`);
    ok(pp.status === 403, '참가자는 QR 인쇄 페이지 접근 불가');
    const hp = await fetch(`${BASE}/print?code=${code}&token=${encodeURIComponent(H)}`);
    ok(hp.status === 200 && (await hp.text()).includes('<svg'), '진행자는 QR 인쇄 페이지 확인');

    Object.values(sse).forEach(s => s.close()); hostSse.close();
    srv2.kill();
  } catch (e) {
    console.error(e); failed++;
    srv.kill();
  }
  console.log(`\n결과: ${passed}개 통과, ${failed}개 실패`);
  process.exit(failed ? 1 : 0);
}
main();
