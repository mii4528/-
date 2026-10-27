"""휴대폰 기본 카메라로 장소 QR(주소)을 찍어 열었을 때 임무가 처리되는지 확인"""
import sys, json, urllib.request, time
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]
def post(path, body):
    r = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return json.load(e)
room = post('/api/rooms', {}); code, H = room['code'], room['hostToken']
host = lambda a, **k: post('/api/act', {'code': code, 'token': H, 'action': a, **k})
host('settings', settings={'mafiaCount': 1, 'tasksPerPlayer': 3, 'startProtect': 0})
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True)
    pg = ctx.new_page()
    pg.goto(f'{BASE}/?room={code}'); pg.fill('#fName', '테스터'); pg.click('#joinForm button.primary')
    pg.wait_for_selector('text=준비 완료 누르기')
    for n in ['둘', '셋', '넷']: post('/api/join', {'code': code, 'name': n})
    hv = host('assign')['view']; host('start', force=True)
    pg.wait_for_selector('text=공동 임무 진행률')
    v = pg.evaluate('() => S.view'); t = v['me']['task']
    loc = next(l for l in hv['locations'] if l['name'] == t['loc'])
    # 기본 카메라 앱이 여는 주소와 같은 형식
    pg.goto(f"{BASE}/?room={code}&s={loc['qr']}")
    time.sleep(1.2)
    v2 = pg.evaluate('() => S.view')
    moved = v2['me']['tasksDone'] == 1 or (v2['me']['task'] and v2['me']['task']['step'] == 1)
    print('✔' if moved else '✘', f"카메라 앱 QR 주소로 임무 처리 ({t['type']}: step/done 반영)")
    print('✔' if 's=' not in pg.url else '✘', '주소창에서 스캔 값 제거 (새로고침 재실행 방지)')
    pg.reload(); time.sleep(1)
    v3 = pg.evaluate('() => S.view')
    print('✔' if v3['me']['tasksDone'] == v2['me']['tasksDone'] else '✘', '새로고침해도 중복 처리 없음')
    b.close()
