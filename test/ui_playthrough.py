"""헤드리스 브라우저로 진행자 1명 + 휴대폰 5대를 띄워 화면을 직접 눌러 한 판을 진행합니다.
실행: python3 test/ui_playthrough.py <서버주소> <스크린샷폴더>
"""
import sys, os, time, json, re
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3000'
OUT = sys.argv[2] if len(sys.argv) > 2 else './shots'
os.makedirs(OUT, exist_ok=True)
errors = []
results = []

def check(cond, msg):
    results.append((bool(cond), msg))
    print(('  ✔ ' if cond else '  ✘ ') + msg)

def shot(page, name):
    page.screenshot(path=os.path.join(OUT, name + '.png'), full_page=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    phone = dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale='ko-KR')

    def new_page(**kw):
        ctx = browser.new_context(**{**phone, **kw})
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        return pg

    host = new_page()
    host.goto(BASE + '/host')
    host.click('#create')
    host.wait_for_selector('text=입장 받는 중')
    code = host.locator('.big').first.inner_text().strip()
    check(re.fullmatch(r'[A-Z0-9]{4}', code), f'진행자가 방 생성 (코드 {code})')
    # 설정: 마피아 1명, 보호시간 0, 임무 2개
    host.click('[data-tab="settings"]')
    host.fill('input[name="mafiaCount"]', '1')
    host.fill('input[name="startProtect"]', '0')
    host.fill('input[name="emergencyCooldown"]', '0')
    host.fill('input[name="tasksPerPlayer"]', '2')
    host.click('#setForm button.primary')
    host.wait_for_selector('text=설정을 저장했습니다')
    host.click('[data-tab="run"]')
    shot(host, '01_host_lobby')

    names = ['김지민', '이서연', '박도윤', '최하은', '정우진']
    phones = {}
    for i, n in enumerate(names):
        pg = new_page()
        pg.goto(f'{BASE}/?room={code}')
        pg.fill('#fName', n)
        pg.click('#joinForm button.primary')
        pg.wait_for_selector('text=준비 완료 누르기')
        phones[n] = pg
    shot(phones[names[0]], '02_player_lobby')
    phones[names[0]].click('[data-a="ready"]')
    phones[names[0]].wait_for_selector('text=준비 완료 (누르면 취소)')

    host.wait_for_selector('text=5</b>입장', timeout=5000) if False else time.sleep(0.5)
    host.click('[data-run="assign"]')
    host.wait_for_selector('text=역할 확인 중')
    for n, pg in phones.items():
        pg.wait_for_selector('text=역할 확인')
    pg0 = phones[names[0]]
    check(pg0.locator('text=눌러서 역할 보기').count() == 1, '역할은 기본적으로 가려져 있음')
    roles = {}
    for n, pg in phones.items():
        pg.click('.rolecard')
        roles[n] = 'mafia' if pg.locator('.rolecard.mafia').count() else 'citizen'
    mafia = [n for n in names if roles[n] == 'mafia'][0]
    cits = [n for n in names if roles[n] == 'citizen']
    check(len(cits) == 4, f'역할 배정 확인 (마피아: {mafia})')
    shot(phones[mafia], '03_mafia_role')
    shot(phones[cits[0]], '04_citizen_role')
    for pg in phones.values():
        pg.click('[data-a="ack"]')
    time.sleep(0.4)
    host.click('[data-run="start"]')
    for pg in phones.values():
        pg.wait_for_selector('text=공동 임무 진행률')
    check(True, '모든 휴대폰이 활동 화면으로 전환')
    shot(phones[cits[0]], '05_citizen_active')

    # 장소 코드 얻기 (진행자 화면 API)
    hv = host.evaluate("() => H.view")
    loc_by_name = {l['name']: l for l in hv['locations']}

    def scan(pg, value):
        pg.click('[data-a="scan"]')
        pg.wait_for_selector('#codeInput')
        pg.fill('#codeInput', value)
        pg.click('#codeForm button')
        time.sleep(0.4)

    def do_task(n):
        pg = phones[n]
        v = pg.evaluate("() => S.view")
        t = v['me']['task']
        if not t: return
        if t['type'] == 'visit':
            scan(pg, loc_by_name[t['loc']]['code'])
        elif t['type'] == 'carry':
            scan(pg, loc_by_name[t['loc']]['code'])
            if n == cits[0]: shot(pg, '06_carry_step')
            scan(pg, loc_by_name[t['loc2']]['code'])
        else:
            scan(pg, loc_by_name[t['loc']]['code'])
            pg.wait_for_selector('[data-a="answer"]')
            if n == cits[0]: shot(pg, '07_report_question')
            ans = loc_by_name[t['loc']]['sign']['answer']
            pg.click(f'[data-a="answer"][data-opt="{ans}"]')
            time.sleep(0.4)

    do_task(cits[0])
    v = phones[cits[0]].evaluate("() => S.view")
    check(v['me']['tasksDone'] == 1, '시민이 QR 코드 입력으로 임무 1개 완료')
    check(phones[cits[1]].evaluate("() => S.view.progress.done") == 1, '다른 휴대폰의 공동 진행률도 실시간 갱신')

    # 마피아 암살
    mp = phones[mafia]
    mp.click('[data-a="toggleSecret"]')
    shot(mp, '08_mafia_secret')
    victim = cits[1]
    mp.click('[data-a="kill"]')
    mp.wait_for_selector('text=대상 선택')
    shot(mp, '09_kill_targets')
    mp.click(f'[data-act="pick"][data-name="{victim}"]')
    mp.click('#confirm [data-act="ok"]')
    phones[victim].wait_for_selector('text=당신은 쓰러졌습니다', timeout=4000)
    check(True, '피해자 화면이 즉시 사망 화면으로 전환')
    shot(phones[victim], '10_dead')
    check(phones[cits[2]].locator('text=당신은 쓰러졌습니다').count() == 0 and phones[cits[2]].evaluate("() => S.view.me.status") == 'alive', '다른 시민 화면은 변화 없음')
    check(mp.locator('text=암살 대기').count() == 1, '마피아 대기시간 표시')

    # 신고
    victim_code = next(pl['code'] for pl in host.evaluate("() => H.view.players") if pl['name'] == victim)
    scan(phones[cits[2]], victim_code)
    phones[cits[2]].wait_for_selector('text=시체 신고 → 회의 소집')
    shot(phones[cits[2]], '11_body_found')
    phones[cits[2]].click('[data-act="report"]')
    for n, pg in phones.items():
        pg.wait_for_selector('text=회의 소집!' if n != victim else 'text=회의 소집!', timeout=4000)
    check(True, '신고 후 모든 휴대폰이 회의 집결 화면으로 전환')
    shot(phones[cits[0]], '12_gathering')
    shot(host, '13_host_gathering')

    host.click('[data-run="discussion"]')
    phones[cits[0]].wait_for_selector('.timer')
    shot(phones[cits[0]], '14_discussion')
    host.click('[data-run="vote"]')
    for n in names:
        if n != victim:
            phones[n].wait_for_selector('text=누구를 추방할까요?')
    check(phones[victim].locator('text=투표권이 없습니다').count() == 1, '사망자는 투표권 없음 화면')
    shot(phones[cits[0]], '15_vote')
    # 모두 마피아에게 투표 (마피아는 건너뛰기)
    for n in names:
        if n == victim: continue
        pg = phones[n]
        target = 'skip' if n == mafia else None
        if target:
            pg.click('[data-a="vote"][data-id="skip"]')
        else:
            pg.click(f'[data-a="vote"][data-name="{mafia}"]')
        pg.click('#confirm [data-act="ok"]')
        time.sleep(0.25)
    phones[cits[0]].wait_for_selector('text=게임 종료' if False else '.big', timeout=4000)
    time.sleep(0.6)
    ended = phones[cits[0]].evaluate("() => S.view.phase")
    check(ended == 'ended', '마피아 추방 → 즉시 시민 승리로 종료')
    shot(phones[cits[0]], '16_ended')
    shot(host, '17_host_ended')

    # 재접속 시험: 새로고침 후 같은 참가자
    pg = phones[cits[3]]
    pg.reload()
    pg.wait_for_selector('text=전체 역할 공개')
    check(pg.evaluate("() => S.view.me.name") == cits[3], '새로고침 후 같은 참가자로 자동 복구')

    # 진행자 새 게임 → 참가자 대기 화면
    host.click('[data-run="newGame"]')
    phones[cits[0]].wait_for_selector('text=준비 완료 누르기')
    check(True, '진행자 새 게임 → 참가자 대기 화면으로 자동 전환')

    # 진행자 화면 탭들
    host.click('[data-tab="players"]'); shot(host, '18_host_players')
    host.click('[data-tab="places"]'); shot(host, '19_host_places')
    host.click('[data-tab="log"]'); shot(host, '20_host_log')

    # 인쇄 페이지
    href = host.locator('a.btn.primary').first.get_attribute('href') if host.locator('a.btn.primary').count() else None
    host.click('[data-tab="places"]')
    href = host.locator('a.btn.primary').first.get_attribute('href')
    pr = browser.new_page(viewport={'width': 900, 'height': 1200})
    pr.goto(BASE + href)
    check(pr.locator('svg').count() >= 7, '인쇄 페이지에 입장·장소·이름표 QR 생성')
    pr.screenshot(path=os.path.join(OUT, '21_print.png'), full_page=False)

    # 연결 끊김 표시
    off = phones[cits[0]]
    off.context.set_offline(True)
    off.evaluate("() => { S.stream && S.stream.close(); S.online = false; renderBars(); }")
    off.wait_for_selector('text=연결 끊김', timeout=3000)
    check(off.locator('[data-a="ready"]').is_disabled(), '연결이 끊기면 행동 버튼 비활성화')
    shot(off, '22_offline')

    browser.close()

bad = [r for r in results if not r[0]]
real_errors = [e for e in errors if 'Failed to load resource' not in e and 'ERR_INTERNET_DISCONNECTED' not in e]
print(f'\n결과: {len(results) - len(bad)}개 통과, {len(bad)}개 실패')
print('브라우저 오류:', real_errors[:10] if real_errors else '없음')
sys.exit(1 if bad or real_errors else 0)
