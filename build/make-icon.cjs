// build/icon.svg → build/icon.png (512x512, 투명 배경)
//
// 별도 이미지 라이브러리 없이 이미 설치된 Electron 으로 SVG 를 렌더해 캡처한다.
// 아이콘을 바꾸려면 icon.svg 만 고치고 다시 실행:  npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 512;
const HERE = __dirname;
const TMP = path.join(HERE, '.icon-render.html');
const OUT = path.join(HERE, 'icon.png');

const svg = fs.readFileSync(path.join(HERE, 'icon.svg'), 'utf8');
// SVG 자체 크기(예: 1024)와 무관하게 창 크기에 맞춰 그리도록 강제한다
fs.writeFileSync(TMP, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;overflow:hidden}
svg{display:block;width:100vw;height:100vh}</style>${svg}`);

app.disableHardwareAcceleration(); // 캡처가 빈 이미지로 나오는 환경 회피

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false,
    transparent: true, frame: false, resizable: false,
    useContentSize: true,
    webPreferences: { offscreen: false },
  });
  await win.loadFile(TMP);
  await new Promise((r) => setTimeout(r, 600)); // 렌더 완료 대기

  // 캡처는 디스플레이 배율을 타므로(150%면 768px) 항상 SIZE 로 맞춘다
  const img = (await win.webContents.capturePage()).resize({ width: SIZE, height: SIZE });
  const png = img.toPNG();
  fs.writeFileSync(OUT, png);
  fs.unlinkSync(TMP);

  const s = img.getSize();
  console.log(`생성: ${OUT}  ${s.width}x${s.height}, ${(png.length / 1024).toFixed(1)}KB`);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
