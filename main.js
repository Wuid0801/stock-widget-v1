// main.js — Electron 메인 프로세스
// 역할: 프레임리스/반투명/항상위 위젯 창 생성, 창 상태 저장·복원,
//       Yahoo Finance chart API 프록시(렌더러는 CORS 때문에 직접 호출 불가).

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const Store = require('electron-store');

// 초기 관심종목. 이후에는 store 값이 우선이므로 UI에서 추가/삭제만 붙이면 된다.
const DEFAULT_WATCHLIST = [
  { symbol: '005930.KS', name: '삼성전자' },
  { symbol: '069500.KS', name: 'KODEX 200' },
  { symbol: '122630.KS', name: 'KODEX 레버리지' },
  { symbol: '000660.KS', name: 'SK하이닉스' },
  { symbol: '035420.KS', name: 'NAVER' },
];

const store = new Store({
  defaults: {
    bounds: { width: 340, height: 520 },
    watchlist: DEFAULT_WATCHLIST,
    selected: '005930.KS',
    timeframe: '1D',
  },
});

let win = null;
let compact = false;      // 우하단 축소 모드 — 이때의 창 크기는 저장하지 않는다
let normalBounds = null;  // 접기 직전의 창 위치/크기 (펼 때 되돌릴 값)

// 펼친 상태의 최소 크기(차트가 보이려면 이 정도는 필요). 접을 때는 일시적으로 낮춘다.
const MIN_W = 280;
const MIN_H = 380;

function createWindow() {
  const b = store.get('bounds');

  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width || 340,
    height: b.height || 520,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Windows 고배율(예: 150%) 환경에서는 생성자의 x/y/height가 어긋나게 적용된다
  // (640,210 요청 → 54,352 배치). setBounds는 정확하므로 저장된 위치를 다시 잡아준다.
  // 최초 실행에는 저장된 좌표가 없으므로 OS가 알아서 중앙 배치한다.
  if (Number.isInteger(b.x) && Number.isInteger(b.y)) {
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }

  // 전체화면 앱 위에서도 유지되도록 screen-saver 레벨
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('index.html');

  // 축소 모드의 임시 크기가 저장되면 재실행 시 접힌 채로 뜨므로, 평소 크기만 저장한다.
  const saveBounds = () => {
    if (win && !win.isDestroyed() && !compact) store.set('bounds', win.getBounds());
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('close', saveBounds);
  win.on('restore', () => win.setSkipTaskbar(true));
  win.on('closed', () => { win = null; });
}

// ---- IPC: 창/상태 ----------------------------------------------------------

ipcMain.handle('state:get', () => ({
  watchlist: store.get('watchlist'),
  selected: store.get('selected'),
  timeframe: store.get('timeframe'),
}));

ipcMain.handle('state:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch || {})) {
    if (['watchlist', 'selected', 'timeframe'].includes(k)) store.set(k, v);
  }
});

ipcMain.on('win:close', () => win && win.close());

// 우하단 접기/펴기. height는 렌더러가 실제 행 높이를 재서 넘겨준다(배율·폰트 영향 회피).
// 펼 때는 store에 남아있는 평소 크기로 되돌린다.
ipcMain.on('win:dock', (_e, on, height) => {
  if (!win) return;
  compact = on;
  if (on) {
    // store의 bounds에는 창을 한 번도 옮기지 않았으면 x/y가 없다.
    // 그 값으로 되돌리면 크기만 바뀌고 우하단에 머무르므로 직접 기억해 둔다.
    const b = win.getBounds();
    normalBounds = b;
    const area = screen.getDisplayMatching(b).workArea; // 작업표시줄을 피한 영역
    const margin = 12;
    // 최소 높이(MIN_H)를 먼저 낮추지 않으면 접힌 높이가 그대로 클램프된다
    win.setMinimumSize(MIN_W, height);
    win.setBounds({
      width: b.width,
      height,
      x: area.x + area.width - b.width - margin,
      y: area.y + area.height - height - margin,
    });
  } else {
    win.setMinimumSize(MIN_W, MIN_H);
    if (normalBounds) win.setBounds(normalBounds);
  }
});

// skipTaskbar:true 인 채로 최소화하면 작업표시줄에도 없어서 되살릴 수가 없다.
// 최소화하는 동안만 작업표시줄에 노출하고, 복원되면 다시 숨긴다.
ipcMain.on('win:minimize', () => {
  if (!win) return;
  win.setSkipTaskbar(false);
  win.minimize();
});

// ---- IPC: Yahoo Finance ----------------------------------------------------

// 실시간 현재가. Yahoo 한국 시세는 20분 지연이므로 현재가/등락만 이쪽으로 덮어쓴다.
// 여러 종목을 한 번에 조회할 수 있어 요청 1건으로 끝난다.
// 실패하면 { ok:false } 를 주고, 렌더러는 Yahoo 값(지연)을 그대로 쓴다.
ipcMain.handle('quote:realtime', async (_e, symbols) => {
  const codes = (symbols || []).map((s) => String(s).split('.')[0]).filter(Boolean);
  if (!codes.length) return { ok: true, quotes: {} };

  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const quotes = {};
    for (const d of json.datas || []) {
      const price = Number(d.closePriceRaw);
      const change = Number(d.compareToPreviousClosePriceRaw); // 하락이면 이미 음수
      if (!Number.isFinite(price) || !Number.isFinite(change)) continue;
      // 심볼 접미사(.KS/.KQ)가 어긋나도 되도록 종목코드로만 넘긴다
      quotes[d.itemCode] = { price, change, prevClose: price - change, open: d.marketStatus === 'OPEN' };
    }
    if (!Object.keys(quotes).length) return { ok: false, error: '빈 응답' };
    return { ok: true, quotes };
  } catch (err) {
    return { ok: false, error: err.message || '실시간 조회 실패' };
  }
});

// 종목 검색. Yahoo 검색은 한글 쿼리에 400을 주므로 네이버 자동완성을 쓴다.
// (주식·ETF 모두 한글명으로 잡히고 코스피/코스닥까지 알려준다)
ipcMain.handle('yf:search', async (_e, query) => {
  const url = 'https://m.stock.naver.com/front-api/search/autoComplete'
    + `?query=${encodeURIComponent(query)}&target=stock`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const items = (json.result?.items || [])
      .filter((i) => i.nationCode === 'KOR' && i.code)
      .map((i) => ({
        // 코스닥이면 .KQ, 그 외(코스피)는 .KS — Yahoo 심볼 규칙
        symbol: i.code + (i.typeCode === 'KOSDAQ' ? '.KQ' : '.KS'),
        name: i.name,
        market: i.typeName || i.typeCode,
      }));
    return { ok: true, items: items.slice(0, 12) };
  } catch (err) {
    return { ok: false, error: err.message || '검색 실패' };
  }
});

// 성공: { ok:true, symbol, price, closes[], times[] }
// 실패: { ok:false, error }  (렌더러에서 그대로 표시)
ipcMain.handle('yf:chart', async (_e, { symbol, range, interval }) => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?range=${range}&interval=${interval}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return { ok: false, error: json?.chart?.error?.description || '데이터 없음' };

    // close 배열에는 실제로 null이 섞여 나온다 → timestamp와 짝을 맞춰 제거
    const rawCloses = result.indicators?.quote?.[0]?.close || [];
    const stamps = result.timestamp || [];
    const closes = [];
    const times = [];
    for (let i = 0; i < rawCloses.length; i++) {
      if (rawCloses[i] == null) continue;
      closes.push(rawCloses[i]);
      times.push(stamps[i] * 1000);
    }
    if (!closes.length) return { ok: false, error: '빈 데이터' };

    return {
      ok: true,
      symbol,
      price: result.meta?.regularMarketPrice ?? closes[closes.length - 1],
      closes,
      times,
    };
  } catch (err) {
    return { ok: false, error: err.message || '요청 실패' };
  }
});

// 작업표시줄에 아이콘이 없어서 창을 한 번 놓치면 되살리기 번거롭다.
// 전역 단축키로 표시/숨김을 토글한다.
const TOGGLE_KEY = 'CommandOrControl+Alt+S';

function registerToggle() {
  const ok = globalShortcut.register(TOGGLE_KEY, () => {
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) {
      win.hide();
    } else {
      win.show();
      win.setAlwaysOnTop(true, 'screen-saver'); // 숨겼다 켜면 최상단 레벨이 풀리는 경우가 있다
    }
  });
  // 다른 프로그램이 이미 쓰는 조합이면 등록에 실패한다. 그때는 위젯이 숨겨질 일도 없으니 그대로 둔다.
  if (!ok) console.warn(`전역 단축키 ${TOGGLE_KEY} 등록 실패 (다른 프로그램이 사용 중일 수 있음)`);
}

app.whenReady().then(() => {
  createWindow();
  registerToggle();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
