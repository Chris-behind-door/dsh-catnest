#!/usr/bin/env python3
"""猫窝前端沙盒：用真浏览器量真页面，改完自己验（不用麻烦主人截图）。

为什么需要它：前端这类「哪个 CSS 属性没生效 / 哪个 ref 是 null / 哪个比例算错」的问题，
靠肉眼看截图判断不了方向（2026-09-20 一天里连续修错好几轮就是这么来的）。这里量的是
数值：图纸与热区的实际像素位置、每个节点的偏差、字体倍率、viewBox 等。

用法（在 dsh web 运行中时）：
    # 1) 取当前 token（每次重启 dsh web 会变，必须重新取）
    grep -o 'token=[A-Za-z0-9_-]*' ~/.dsh/logs/dsh-web.log | tail -1 | cut -d= -f2 > /tmp/tok.txt
    # 2) 量 + 截图
    python3 tools/sandbox.py 1600,900 /tmp/shot.png
    输出里的 align 是「每个热区 vs SVG 里同名房间」的偏差（%），理想是 0.00。
    fitsCard=True 表示图纸完整落在弹窗卡片内。

它做的事：headless chromium（playwright 自带那份）→ CDP（Runtime.evaluate）→
打开真猫窝 → 点开小地图进放大态 → 量尺寸 → 截图。
需要 chromium 在 ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome。
"""
#!/usr/bin/env python3
"""猫窝前端沙盒：CDP 驱动真浏览器 → 打开真猫窝 → 点开放大版 → 量尺寸/截图/看 CSS 是否新版。"""
import json, subprocess, time, urllib.request, os, sys, base64, socket, struct
from urllib.parse import urlparse

CHROME = os.path.expanduser('~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
PORT = 9334

class WS:
    def __init__(self, u):
        pr = urlparse(u); self.s = socket.create_connection((pr.hostname, pr.port))
        k = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {pr.path} HTTP/1.1\r\nHost: {pr.hostname}:{pr.port}\r\nUpgrade: websocket\r\n"
                        f"Connection: Upgrade\r\nSec-WebSocket-Key: {k}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b''
        while b'\r\n\r\n' not in buf: buf += self.s.recv(4096)
    def send(self, obj):
        data = json.dumps(obj).encode(); hdr = b'\x81'; n = len(data)
        if n < 126: hdr += bytes([n | 0x80])
        elif n < 65536: hdr += bytes([126 | 0x80]) + struct.pack('>H', n)
        else: hdr += bytes([127 | 0x80]) + struct.pack('>Q', n)
        mask = os.urandom(4)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
    def recv(self):
        h = self.s.recv(2)
        if len(h) < 2: return None
        n = h[1] & 0x7f
        if n == 126: n = struct.unpack('>H', self.s.recv(2))[0]
        elif n == 127: n = struct.unpack('>Q', self.s.recv(8))[0]
        d = b''
        while len(d) < n: d += self.s.recv(n - len(d))
        return json.loads(d)

class Browser:
    def __init__(self, size='1600,900'):
        self.p = subprocess.Popen([CHROME, '--headless=new', '--no-sandbox', '--disable-gpu',
                                   f'--remote-debugging-port={PORT}', f'--window-size={size}', 'about:blank'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                tabs = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list').read()); break
            except Exception: time.sleep(0.3)
        tab = [t for t in tabs if t['type'] == 'page'][0]
        self.ws = WS(tab['webSocketDebuggerUrl']); self.n = 0
    def cmd(self, method, params=None):
        self.n += 1
        self.ws.send({'id': self.n, 'method': method, **({'params': params} if params else {})})
        while True:
            r = self.ws.recv()
            if r and r.get('id') == self.n: return r
    def ev(self, expr, awaitp=False):
        r = self.cmd('Runtime.evaluate', {'expression': expr, 'awaitPromise': awaitp, 'returnByValue': True})
        res = r.get('result', {})
        if 'exceptionDetails' in res: return 'ERR: ' + json.dumps(res['exceptionDetails'])[:300]
        return res.get('result', {}).get('value')
    def goto(self, url, wait=6):
        self.cmd('Page.enable')
        self.cmd('Network.enable')
        self.cmd('Network.setCacheDisabled', {'cacheDisabled': True})
        self.cmd('Page.navigate', {'url': url}); time.sleep(wait)
    def shot(self, path):
        r = self.cmd('Page.captureScreenshot', {'format': 'png'})
        open(path, 'wb').write(base64.b64decode(r['result']['data']))
        return path
    def kill(self): self.p.kill()

TOKEN = open('/tmp/tok.txt').read().strip()
OPEN_PANEL = """(async () => {
  const s = ms => new Promise(r => setTimeout(r, ms));
  if (!document.querySelector('.cnx-minimap')) {
    const e = document.querySelector('.cnx-entry-icon'); if (e) { e.click(); await s(1000); }
  }
  return !!document.querySelector('.cnx-minimap');
})()"""
OPEN_ZOOM = """(async () => {
  const s = ms => new Promise(r => setTimeout(r, ms));
  const m = document.querySelector('.cnx-minimap'); if (!m) return 'no-minimap';
  m.click(); await s(1200);
  return !!document.querySelector('.cnx-lightbox-card');
})()"""
# (mapping now inlined) _unused = {"entry":"玄关","living":"客厅","kitchen":"厨房","balcony":"阳台","study":"书房","bedroom":"卧室","bath":"浴室","unit_door":"单元门口","path":"步道","garden":"小花园","bench":"长椅","store":"便利店","gate":"小区大门"};
MEASURE = """(() => {
  const rr = el => { const b = el.getBoundingClientRect(); return [+b.width.toFixed(1), +b.height.toFixed(1)]; };
  const card = document.querySelector('.cnx-lightbox-card');
  if (!card) return 'no-card';
  const zb = card.querySelector('.cnx-zoombox'), fit = card.querySelector('.cnx-zoomfit');
  const wrap = card.querySelector('.cnx-mapwrap'), svg = wrap && wrap.querySelector('svg');
  const cs = (el, p) => el ? getComputedStyle(el).getPropertyValue(p) : null;
  let scale = null, bbox = null;
  try { scale = svg.getScreenCTM().a.toFixed(3); } catch (e) {}
  try { const b = svg.getBBox(); bbox = [Math.round(b.width), Math.round(b.height)]; } catch (e) {}
  // 按 title 里的地名，把每个热区与 SVG 里同名房间对齐比较（别按顺序取，会错位）
  const NAME2ID = {"玄关":"entry","客厅":"living","厨房":"kitchen","阳台":"balcony","书房":"study","卧室":"bedroom","浴室":"bath","单元门口":"unit_door","步道":"path","小花园":"garden","长椅":"bench","便利店":"store","小区大门":"gate"};
  const titleToId = NAME2ID;
  const devs = [];
  card.querySelectorAll('.cnx-zoomfit .cnx-ui .cnx-zone').forEach(z => {
    const name = (z.title || '').replace('把主人移到', '');
    const id = titleToId[name];
    const room = id && wrap.querySelector('#room-' + id + ' rect');
    if (!room) return;
    const a = room.getBoundingClientRect(), b = z.getBoundingClientRect();
    devs.push(name + ':' + ((b.left - a.left) / 950 * 100).toFixed(2) + '/' + ((b.top - a.top) / 600 * 100).toFixed(2));
  });
  const align = devs.length ? devs.join(' ') : null;
  return JSON.stringify({
    vp: innerWidth + 'x' + innerHeight,
    cssVersion: cs(card, 'max-width') !== 'none' ? 'new' : 'old',
    cardMaxW: cs(card, 'max-width'), card: rr(card),
    zoombox: rr(zb), zoomboxH: cs(zb, 'height'),
    fit: fit ? rr(fit) : null, fitW: fit ? cs(fit, 'width') : null, fitMaxW: fit ? cs(fit, 'max-width') : null,
    wrap: rr(wrap), svg: rr(svg), svgW: cs(svg, 'width'), svgH: cs(svg, 'height'),
    scale, bbox,
    fitsCard: wrap && (wrap.getBoundingClientRect().right <= card.getBoundingClientRect().right + 1 &&
                       wrap.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom + 1),
    align,
  });
})()"""

def run(size='1600,900', shot=None, keep=False):
    b = Browser(size)
    try:
        b.goto(f'http://127.0.0.1:3080/?token={TOKEN}', wait=7)
        print('打开面板:', b.ev(OPEN_PANEL, True))
        print('打开放大:', b.ev(OPEN_ZOOM, True))
        print('尺寸:', b.ev(MEASURE))
        if shot: print('截图:', b.shot(shot))
    finally:
        if not keep: b.kill()

if __name__ == '__main__':
    size = sys.argv[1] if len(sys.argv) > 1 else '1600,900'
    shot = sys.argv[2] if len(sys.argv) > 2 else '/tmp/sandbox_shot.png'
    run(size, shot)
