'use strict';
// 진행자 임무 목록 기능 시험. 실행: node test/missions.test.js
const G = require('../lib/game');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✔', m); } else { failed++; console.log('  ✘', m); } };
const throws = (fn, re, m) => { try { fn(); ok(false, m); } catch (e) { ok(e instanceof G.GameError && re.test(e.message), `${m} — "${e.message}"`); } };

const room = G.createRoom(new Set());
['가', '나', '다', '라', '마', '바'].forEach(n => G.join(room, n));
G.updateSettings(room, { mafiaCount: 1, tasksPerPlayer: 3, startProtect: 0 });
const [L1, L2, L3] = room.locations;

console.log('\n[임무 목록 저장 검사]');
throws(() => G.saveMissions(room, [{ type: 'visit', loc: 'nope' }]), /장소를 고르세요/, '없는 장소 거부');
throws(() => G.saveMissions(room, [{ type: 'carry', loc: L1.id, loc2: L1.id }]), /같습니다/, '출발지=도착지 거부');
throws(() => G.saveMissions(room, [{ type: 'report', loc: L1.id, q: { question: '색은?', options: ['빨강', '파랑'], answer: '초록' } }]), /정답이 선택지에 없습니다/, '정답이 선택지에 없으면 거부');

const list = [
  { type: 'visit', loc: L1.id, title: '소화기 점검', desc: '소화기 옆 QR을 찍으세요' },
  { type: 'report', loc: L2.id, title: '깃발 확인', q: { question: '깃발 색은?', options: ['빨강', '파랑', '노랑'], answer: '노랑' } },
  { type: 'carry', loc: L3.id, loc2: L1.id, title: '공 옮기기' },
  { type: 'visit', loc: L2.id },
];
G.saveMissions(room, list);
ok(room.missions.length === 4 && room.missions.every(m => m.id), '임무 4개 저장, 각각 고유 번호');
const keepId = room.missions[0].id;
G.saveMissions(room, room.missions.map(m => ({ ...m })));
ok(room.missions[0].id === keepId, '다시 저장해도 임무 번호 유지');

console.log('\n[배정]');
G.assignRoles(room);
const ps = G.list(room);
ok(ps.every(p => p.tasks.length === 3), '1인당 3개 배정 (목록 4개 중)');
ok(ps.every(p => new Set(p.tasks.map(t => t.mid)).size === 3), '한 사람에게 같은 임무 중복 없음');
ok(new Set(ps.map(p => p.tasks.map(t => t.mid).join())).size > 1, '사람마다 다른 순서/조합');
ok(ps.every(p => p.tasks.every(t => room.missions.some(m => m.id === t.mid))), '모든 임무가 등록 목록에서 나옴');
throws(() => G.saveMissions(room, []), /게임 시작 전에만/, '대기 단계가 아니면 임무 수정 거부');

console.log('\n[진행]');
G.startGame(room, true);
const p = ps.find(x => x.tasks.some(t => t.type === 'report'));
while (p.tasks[p.taskIdx].type !== 'report') p.taskIdx++; // 보고 임무까지 건너뜀 (시험용)
const t = p.tasks[p.taskIdx];
const v = G.playerView(room, p);
ok(v.me.task.title === '깃발 확인', '참가자 화면에 임무 이름 표시');
const r1 = G.scan(room, p, L2.code);
ok(r1.kind === 'question' && r1.question === '깃발 색은?', '장소 QR 후 등록한 질문 표시');
// 장소 표지를 지워도 진행 중인 임무 질문은 유지
L2.sign = null;
ok(G.playerView(room, p).me.task.question === '깃발 색은?', '장소 정보가 바뀌어도 진행 중 임무의 질문 유지');
throws(() => G.answer(room, p, t.id, '파랑'), /맞지 않습니다/, '오답 거부');
G.scan(room, p, L2.code);
const r2 = G.answer(room, p, t.id, '노랑');
ok(r2.kind === 'done', '정답이면 완료');

console.log('\n[목록 비우면 자동 배정]');
G.newGame(room);
G.saveMissions(room, []);
G.assignRoles(room);
ok(G.list(room).every(x => x.tasks.length === 3 && x.tasks.every(t => !t.mid)), '목록이 비면 장소 정보로 자동 배정');

console.log('\n[삭제된 장소 검사]');
G.newGame(room);
G.saveMissions(room, [{ type: 'visit', loc: L1.id }]);
G.saveLocations(room, room.locations.filter(l => l.id !== L1.id));
throws(() => G.assignRoles(room), /장소가 삭제되었습니다/, '임무의 장소가 지워지면 배정 전에 알림');

console.log(`\n결과: ${passed}개 통과, ${failed}개 실패`);
process.exit(failed ? 1 : 0);
