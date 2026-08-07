// build/icon.svg → build/icon.ico (멀티사이즈)
//
// Windows 는 상황마다 다른 크기를 쓴다 — 제목표시줄 16px, 작업표시줄 32px, 탐색기 48px.
// 256px 하나만 넣으면 그때마다 축소돼 뭉개지므로, 벡터 원본을 크기별로 직접 렌더해 담는다.
//
// 이미지 라이브러리 없이 이미 설치된 Electron 으로 렌더하고,
// ICO 컨테이너(헤더 + 디렉터리 + PNG 묶음)는 직접 조립한다.
//
// npm run dist 가 매번 먼저 실행하므로 따로 부를 일은 없다.
// icon.svg 만 고치고 바로 확인하고 싶으면: npx electron build/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const HERE = __dirname;
const TMP = path.join(HERE, '.icon-render.html');
const OUT = path.join(HERE, 'icon.ico');

const svg = fs.readFileSync(path.join(HERE, 'icon.svg'), 'utf8');
// SVG 자체 크기(예: 1024)와 무관하게 창 크기에 맞춰 그리도록 강제한다
fs.writeFileSync(TMP, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;overflow:hidden}
svg{display:block;width:100vw;height:100vh}</style>${svg}`);

app.disableHardwareAcceleration(); // 캡처가 빈 이미지로 나오는 환경 회피

// Vista 이후 ICO 는 각 항목에 PNG 를 그대로 담을 수 있다.
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type: 1 = icon
  header.writeUInt16LE(pngs.length, 4); // 이미지 개수

  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;

  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;     // 256 은 0 으로 표기하는 규약
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0;                      // 팔레트 색 수 (트루컬러면 0)
    dir[o + 3] = 0;                      // reserved
    dir.writeUInt16LE(1, o + 4);         // color planes
    dir.writeUInt16LE(32, o + 6);        // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256, height: 256, show: false,
    transparent: true, frame: false, resizable: true,
    useContentSize: true,
  });
  await win.loadFile(TMP);
  await new Promise((r) => setTimeout(r, 400));

  const pngs = [];
  for (const size of SIZES) {
    win.setContentSize(size, size);
    await new Promise((r) => setTimeout(r, 150)); // 리사이즈 후 재렌더 대기
    // 캡처는 디스플레이 배율을 타므로(150%면 1.5배) 정확한 크기로 맞춘다
    const img = (await win.webContents.capturePage()).resize({ width: size, height: size });
    pngs.push({ size, data: img.toPNG() });
  }

  fs.writeFileSync(OUT, buildIco(pngs));
  fs.unlinkSync(TMP);

  const total = fs.statSync(OUT).size;
  console.log(`생성: ${OUT}`);
  console.log(`  ${SIZES.join(', ')} px  총 ${(total / 1024).toFixed(1)}KB`);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
