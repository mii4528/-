// QR 스캐너. 지원 브라우저는 내장 BarcodeDetector, 그 외에는 jsQR(CDN)을 사용합니다.
// 카메라를 쓸 수 없으면 짧은 코드 입력만 보여 줍니다.
'use strict';

const Scanner = (() => {
  let stream = null, running = false, onResult = null, detector = null, jsqrLoading = null;

  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    if (jsqrLoading) return jsqrLoading;
    const srcs = ['https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js', 'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js'];
    jsqrLoading = srcs.reduce((p, src) => p.catch(() => new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = () => (window.jsQR ? res() : rej()); s.onerror = rej;
      document.head.appendChild(s);
    })), Promise.reject());
    jsqrLoading.catch(() => { jsqrLoading = null; });
    return jsqrLoading;
  }

  function close() {
    running = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    const el = document.getElementById('scanner');
    if (el) el.remove();
  }

  async function open(title, cb) {
    close();
    onResult = cb;
    const el = document.createElement('div');
    el.className = 'scanner'; el.id = 'scanner';
    el.innerHTML = `
      <div style="position:relative;flex:1;display:flex;min-height:0">
        <video playsinline muted autoplay></video>
        <div class="frame"></div>
        <div id="scanMsg" style="position:absolute;top:12px;left:12px;right:12px;text-align:center;font-weight:800;text-shadow:0 2px 6px #000">${esc(title)}<br><span class="small">QR을 네모 안에 맞추세요</span></div>
      </div>
      <div class="bottom">
        <form id="codeForm" class="row" autocomplete="off">
          <input id="codeInput" class="code" maxlength="12" placeholder="코드 입력" inputmode="text" autocapitalize="characters" style="flex:2">
          <button class="primary" style="flex:1">확인</button>
        </form>
        <button id="scanClose" style="margin-top:10px">닫기</button>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#scanClose').onclick = close;
    el.querySelector('#codeForm').onsubmit = (e) => {
      e.preventDefault();
      const v = el.querySelector('#codeInput').value.trim();
      if (v) { close(); onResult(v); }
    };
    const video = el.querySelector('video');
    const msg = el.querySelector('#scanMsg');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      msg.innerHTML = '이 환경에서는 카메라를 쓸 수 없습니다.<br>QR 옆의 코드를 입력하세요.';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (_) {
      msg.innerHTML = '카메라 권한이 없습니다.<br>QR 옆의 코드를 입력하거나, 휴대폰 카메라 앱으로 QR을 찍으세요.';
      return;
    }
    if (!document.getElementById('scanner')) { close(); return; }
    video.srcObject = stream;
    try { await video.play(); } catch (_) { /* 자동 재생 제한 */ }
    running = true;

    if ('BarcodeDetector' in window) {
      try {
        const fmts = await window.BarcodeDetector.getSupportedFormats();
        if (fmts.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (_) { detector = null; }
    }
    if (!detector) {
      try { await loadJsQR(); } catch (_) {
        msg.innerHTML = 'QR 인식 기능을 불러오지 못했습니다.<br>코드를 입력하거나 휴대폰 카메라 앱으로 QR을 찍으세요.';
        return;
      }
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const loop = async () => {
      if (!running) return;
      if (video.readyState >= 2 && video.videoWidth) {
        let text = null;
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (codes.length) text = codes[0].rawValue;
          } else {
            const w = 480, h = Math.round(video.videoHeight * (480 / video.videoWidth));
            canvas.width = w; canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const r = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
            if (r) text = r.data;
          }
        } catch (_) { /* 다음 프레임 */ }
        if (text && running) { close(); onResult(text); return; }
      }
      setTimeout(loop, 180);
    };
    loop();
  }

  return { open, close };
})();
