// main.js — Electron 메인 프로세스
// 역할: 프레임리스/반투명/항상위 위젯 창 생성, 창 상태 저장·복원,
//       Yahoo Finance chart API 프록시(렌더러는 CORS 때문에 직접 호출 불가).

const { app, BrowserWindow, ipcMain, screen, globalShortcut, Notification, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const { normalizeQuote, confirmedRegularClose, overFromClose,
  dailyRegularClose } = require('./quote-session.cjs');

// Only confirmed same-day regular closes. An after-market startup has none of
// its own, so it asks the daily chart once; retries are spaced by CLOSE_RETRY
// because the close only lands there once the 20-minute delay has passed.
const regularCloseCache = new Map();
const regularCloseTried = new Map();
const CLOSE_RETRY = 300000;

// --- 테스트 훅 (환경변수가 없으면 전부 무동작) ---------------------------------
// 검증 스위트가 상류 실패와 장 상태를 만들어내야 하는데, 예전에는 그걸 하려고
// main.js 를 디스크에서 치환하고 finally 에서 되돌렸다. 프로세스가 중간에 죽으면
// 사용자의 main.js 가 패치된 채로 남는다. 그래서 환경변수로 바꿨다.
// tests/isolation.mjs 가 스위트들이 소스를 다시 건드리지 않는지 검사한다.

// 쉼표로 나열한 조각 중 하나라도 URL 에 들어 있으면 그 요청을 실패시킨다.
const FAIL_URLS = (process.env.KR_STOCK_WIDGET_FAIL_URLS || '').split(',').filter(Boolean);
const rawFetch = FAIL_URLS.length
  ? (url, opt) => (FAIL_URLS.some((s) => String(url).includes(s))
    ? Promise.reject(new Error('테스트에서 차단한 요청'))
    : fetch(url, opt))
  : fetch;

// 모든 요청은 8초 안에 답이 없으면 포기한다. 제한이 없으면 Node 기본값(최대 5분)만큼
// 기다리는데, 그동안 렌더러의 갱신이 끝나지 않아 자동 갱신과 ↻ 가 같이 멈춘다.
// tests/net-timeout.mjs 가 핸들러마다 확인한다.
const FETCH_TIMEOUT = 8000;
// 인터넷이 끊기거나 서버에 닿지 못하면 Node fetch 는 영어 'fetch failed'(TypeError)를 던진다 —
// 화면에 그대로 뜨면("삼성전자 차트: fetch failed") 원인을 알기 어렵다. 원인 코드(cause.code)는
// 상황마다 달라(DNS 실패 ENOTFOUND, 연결 거부는 없음) 한 문구로 묶는다.
const netFetch = (url, opt = {}) => rawFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...opt })
  .catch((e) => {
    if (e?.name === 'TimeoutError') throw new Error('응답 시간 초과');
    if (e instanceof TypeError && e.message === 'fetch failed') throw new Error('네트워크 연결 실패');
    throw e;
  });

// 'regular' | 'pre' | 'after' | 'closed' 로 장 상태를 고정한다.
// 실제 장 시간에 기대면 밤·주말에는 폴링 간격 검증을 돌릴 수 없다.
const FORCE_SESSION = process.env.KR_STOCK_WIDGET_FORCE_SESSION || '';

// 초기 관심종목. 이후에는 store 값이 우선이므로 UI에서 추가/삭제만 붙이면 된다.
const DEFAULT_WATCHLIST = [
  { symbol: '005930.KS', name: '삼성전자' },
  { symbol: '069500.KS', name: 'KODEX 200' },
  { symbol: '122630.KS', name: 'KODEX 레버리지' },
  { symbol: '000660.KS', name: 'SK하이닉스' },
  { symbol: '035420.KS', name: 'NAVER' },
];

const storeOptions = {
  // electron-store 는 기본적으로 app.getName() 기준 폴더에 저장한다.
  // productName 을 붙이면 저장 위치가 바뀌어 기존 설정이 통째로 사라지므로 경로를 고정한다.
  //
  // 환경변수는 테스트만 쓴다. 검증 스위트는 매번 설정을 비우고 관심종목을 넣다
  // 지우는데, 그 대상이 이 경로라 npm test 한 번에 실제 설정이 날아갔다.
  // --user-data-dir 로는 못 막는다 — 그 스위치는 userData 만 바꾸고 여기 쓰는
  // appData 는 그대로다(tests/isolation.mjs 가 이 우회로를 검사한다).
  cwd: process.env.KR_STOCK_WIDGET_CONFIG_DIR
    || path.join(app.getPath('appData'), 'kr-stock-widget'),
  defaults: {
    bounds: { width: 340, height: 520 },
    watchlist: DEFAULT_WATCHLIST,
    selected: '005930.KS',
    timeframe: '1D',
    // 목표가 알림. 기본은 꺼짐 — 사용자가 켜야만 알린다.
    alerts: { enabled: false, targets: {} },
    // 보유 수량/평단가 (계좌 연동 없이 직접 입력)
    holdings: {},
    theme: 'dark', // 'dark' | 'light'
    opacity: 74,   // 평소(마우스가 벗어났을 때) 불투명도 %
    maPeriods: [5, 20, 60], // 표시할 이동평균 기간(일)
    maStyles: {}, // 이동평균선별로 바꾼 색 · 굵기 { [기간]: { color, width } } — 바꾼 것만
    chartMode: 'candle', // 'candle' | 'line'
    infoOpen: true, // 상세의 보유 · 52주 · 추세 점검 세 줄을 펴 둘지
  },
  // 메모장 · PowerShell 이 붙인 UTF-8 BOM 은 떼고 읽는다 — JSON.parse 는 BOM 에서 SyntaxError 를 낸다.
  deserialize: (text) => JSON.parse(text.replace(/^\uFEFF/, '')),
};

// 설정 파일이 깨졌으면(손으로 고치다 남긴 끝 쉼표, PowerShell 5.1 의 '{}' > 가 만든 UTF-16 등)
// Store 를 만드는 순간 SyntaxError 가 나서 창 코드가 하나도 돌지 않았다 — 위젯이 아예 뜨지 않는다.
// 지우지 않고 이름을 바꿔 두고(평단가는 이 파일에만 있다) 기본값으로 시작하고, 창이 뜬 뒤 알린다.
let brokenConfig = null; // 옮겨 둔 깨진 설정 파일 경로
function openStore() {
  try {
    return new Store(storeOptions);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    brokenConfig = path.join(storeOptions.cwd, `config.broken-${Date.now()}.json`);
    fs.renameSync(path.join(storeOptions.cwd, 'config.json'), brokenConfig);
    return new Store(storeOptions);
  }
}
const store = openStore();

let win = null;
let compact = false;      // 우하단 축소 모드 — 이때의 창 크기는 저장하지 않는다
let normalBounds = null;  // 접기 직전의 창 위치/크기 (펼 때 되돌릴 값)

// 펼친 상태의 최소 크기(차트가 보이려면 이 정도는 필요). 접을 때는 일시적으로 낮춘다.
const MIN_W = 280;
const MIN_H = 380;

// 창 위치를 지금 화면에서 잡을 수 있는가 — 위쪽 끌기 막대(높이 약 30px)가 어느 모니터의
// 작업 영역과 가로 40px · 세로 20px 이상 겹치면 된다. 외부 모니터에 둔 채 끄고 그 모니터
// 없이 켜면 저장된 위치는 화면 밖인데, Windows 는 지정한 좌표의 창을 화면 안으로 옮겨 주지
// 않고 작업표시줄 버튼도 없어서(skipTaskbar) 되살릴 길이 마땅치 않다.
const BAR_H = 30;
function reachable(b, displays) {
  return displays.some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + BAR_H, a.y + a.height) - Math.max(b.y, a.y);
    return w >= 40 && h >= 20;
  });
}

function createWindow() {
  const b = store.get('bounds');
  const width = b.width || 340;
  const height = b.height || 520;
  // 저장된 위치가 지금 어느 화면에서도 잡히지 않으면(외부 모니터를 뗀 채 실행) 위치는 버리고
  // 크기만 쓴다 — 첫 실행처럼 OS 가 가운데에 놓는다.
  const placed = Number.isInteger(b.x) && Number.isInteger(b.y)
    && reachable({ x: b.x, y: b.y, width, height }, screen.getAllDisplays());

  win = new BrowserWindow({
    x: placed ? b.x : undefined,
    y: placed ? b.y : undefined,
    width,
    height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Windows 고배율(예: 150%) 환경에서는 생성자의 x/y/height가 어긋나게 적용된다
  // (640,210 요청 → 54,352 배치). setBounds는 정확하므로 저장된 위치를 다시 잡아준다.
  // 최초 실행에는 저장된 좌표가 없으므로 OS가 알아서 중앙 배치한다.
  if (placed) {
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }

  // 전체화면 앱 위에서도 유지되도록 screen-saver 레벨
  win.setAlwaysOnTop(true, 'screen-saver');

  // 이 앱은 로컬 페이지 하나만 띄운다. 어떤 경로로든 외부 페이지로 이동하거나
  // 새 창이 열리는 일이 없도록 막는다.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // 화면(렌더러) 프로세스가 죽으면 창은 남는데 내용이 없고 ✕ 도 안 먹는다 — 테두리 없는 투명
  // 창이고 작업표시줄에도 없어 빠져나오기 어렵다. 다시 띄운다. 다시 뜬 화면은 펼친 상태로
  // 시작하므로 접혀 있었으면 창도 편다(그대로 두면 접힌 크기에 갇히고 위치도 저장되지 않는다).
  // 시작하자마자 또 죽으면 끝없이 다시 띄우게 되니 1분 안의 두 번째부터는 되풀이하지 않는다.
  let reloadedAt = -Infinity;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed() || Date.now() - reloadedAt < 60000) return;
    reloadedAt = Date.now();
    if (compact) unfold();
    win.webContents.reload();
  });

  win.loadFile('index.html');

  // 축소 모드의 임시 크기가 저장되면 재실행 시 접힌 채로 뜨므로, 평소 크기만 저장한다.
  //
  // 기준 크기(normalBounds)는 여기서만 갱신한다. 접을 때마다 getBounds() 로 다시 잡으면,
  // 고배율에서 setBounds → getBounds 왕복이 1px 어긋나는 값이 되먹임돼
  // 접기/펴기를 반복할수록 창이 계속 커진다(5회에 5px).
  const saveBounds = () => {
    if (!win || win.isDestroyed() || compact) return;
    normalBounds = win.getBounds();
    store.set('bounds', normalBounds);
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
  alerts: store.get('alerts'),
  holdings: store.get('holdings'),
  theme: store.get('theme'),
  opacity: store.get('opacity'),
  maPeriods: store.get('maPeriods'),
  maStyles: store.get('maStyles'),
  chartMode: store.get('chartMode'),
  infoOpen: store.get('infoOpen'),
}));

ipcMain.handle('state:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch || {})) {
    // electron-store 는 undefined 를 거부하며 예외를 던진다. 저장할 값이 없으면 그냥 건너뛴다.
    if (v === undefined) continue;
    if (['watchlist', 'selected', 'timeframe', 'alerts', 'holdings', 'theme', 'opacity', 'maPeriods', 'maStyles', 'chartMode', 'infoOpen'].includes(k)) store.set(k, v);
  }
});

// 목표가 도달 알림. 렌더러가 켜져 있을 때만 보낸다(켜고 끄는 판단은 렌더러 쪽).
ipcMain.on('notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  new Notification({ title: String(title || ''), body: String(body || '') }).show();
});

ipcMain.on('win:close', () => win && win.close());

// 우하단 접기/펴기. height는 렌더러가 실제 행 높이를 재서 넘겨준다(배율·폰트 영향 회피).
// 펼 때는 store에 남아있는 평소 크기로 되돌린다.
const DOCK_MARGIN = 12; // 화면 가장자리 여백 — 접을 자리와, 펼 자리를 고칠 때 같이 쓴다

// 접기 전 크기 · 자리로 편다. 접기를 푸는 IPC 와, 화면 프로세스가 죽어 다시 띄울 때 쓴다.
function unfold() {
  compact = false;
  win.setMinimumSize(MIN_W, MIN_H);
  if (!normalBounds) return;
  // 접은 채 외부 모니터를 떼면 펼 자리(normalBounds)가 없는 화면을 가리킨다. 접힌 창은
  // Windows 가 남은 화면으로 옮기지만 펼 자리는 그대로라, 크기만 살려 지금 화면의
  // 오른쪽 아래에 편다.
  if (!reachable(normalBounds, screen.getAllDisplays())) {
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    normalBounds = {
      ...normalBounds,
      x: area.x + area.width - normalBounds.width - DOCK_MARGIN,
      y: area.y + area.height - normalBounds.height - DOCK_MARGIN,
    };
  }
  win.setBounds(normalBounds);
}

ipcMain.on('win:dock', (_e, on, height) => {
  if (!win) return;
  if (!on) { unfold(); return; }
  compact = true;
  // store의 bounds에는 창을 한 번도 옮기지 않았으면 x/y가 없다.
  // 그 값으로 되돌리면 크기만 바뀌고 우하단에 머무르므로 직접 기억해 둔다.
  // 이미 잡아둔 기준이 있으면 다시 읽지 않는다(위 saveBounds 주석 참고).
  const b = win.getBounds();
  if (!normalBounds) normalBounds = b;
  const area = screen.getDisplayMatching(b).workArea; // 작업표시줄을 피한 영역
  const width = normalBounds.width; // 펼친 폭과 어긋나지 않도록 기준값을 쓴다
  // 최소 높이(MIN_H)를 먼저 낮추지 않으면 접힌 높이가 그대로 클램프된다
  win.setMinimumSize(MIN_W, height);
  win.setBounds({
    width,
    height,
    x: area.x + area.width - width - DOCK_MARGIN,
    y: area.y + area.height - height - DOCK_MARGIN,
  });
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
// 세션·가격 선택은 quote-session.cjs 에서 독립적으로 검증한다.
ipcMain.handle('quote:realtime', async (_e, symbols) => {
  // 네이버 실시간은 국내 전용. 해외 종목은 걸러내고 Yahoo 값을 그대로 쓰게 둔다.
  // 종목코드 형태를 확인해 URL 경로에 이상한 값이 끼어들지 않게 한다.
  const valid = (symbols || [])
    .filter((s) => /^[A-Za-z0-9]{1,10}\.(KS|KQ)$/.test(String(s)))
    .map(String);
  const codes = valid.map((s) => s.split('.')[0]);
  const symbolOf = new Map(valid.map((s) => [s.split('.')[0], s]));
  if (!codes.length) return { ok: true, quotes: {} };

  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' };
  const read = async (url) => {
    const res = await netFetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  try {
    // Explicit venue endpoints; the KRX top-level quote now includes afterMarket.
    const results = await Promise.allSettled([
      read(`https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`),
      read(`https://polling.finance.naver.com/api/realtime/domestic/NXT/stock/${codes.join(',')}`),
    ]);
    const rows = results.map((r) => r.status === 'fulfilled' && Array.isArray(r.value?.datas)
      ? r.value.datas : []);
    const baseMap = new Map(rows[0].map((d) => [d.itemCode, d]));
    const nxtMap = new Map(rows[1].map((d) => [d.itemCode, d]));
    const partial = results.some((r) => r.status === 'rejected'
      || !Array.isArray(r.value?.datas));
    const quotes = {};
    const now = Date.now();
    for (const code of new Set(codes)) {
      const d = baseMap.get(code) || { itemCode: code };
      const captured = confirmedRegularClose(d);
      if (captured) regularCloseCache.set(code, captured);
      const quote = normalizeQuote(d, {
        now, nxt: nxtMap.get(code), regularClose: regularCloseCache.get(code),
      });
      if (!quote) continue;

      // No dedicated regular-close field is available after the KRX price starts
      // moving again. Hide fromClose on a cold startup instead of treating a
      // generic 15:30 chart candle as a verified close on special trading days.
      // If one venue failed, do not claim all trading is over based on the other.
      if (partial && quote.isTrading !== true) {
        quote.isTrading = null;
        quote.session = 'unknown';
      }
      // Test-only override. It never fabricates a regular close or price.
      if (['regular', 'pre', 'after', 'closed'].includes(FORCE_SESSION)) {
        quote.session = FORCE_SESSION;
        quote.priceSession = FORCE_SESSION === 'closed' ? quote.priceSession : FORCE_SESSION;
        quote.isTrading = FORCE_SESSION !== 'closed';
        quote.open = FORCE_SESSION === 'regular';
        quote.fromClose = overFromClose(quote.regularClose, quote.price, quote.priceSession);
      }
      quotes[code] = quote;
    }

    // After-market with no close of its own: read it back from the daily chart.
    // One request per symbol per day, not per poll - the value never changes
    // once the session is over, and a failure only hides the difference line.
    const missing = [...new Set(codes)].filter((code) => {
      const q = quotes[code];
      if (!q || q.priceSession !== 'after' || q.regularClose != null) return false;
      const last = regularCloseTried.get(code);
      return last == null || now - last >= CLOSE_RETRY;
    });
    await Promise.all(missing.map(async (code) => {
      regularCloseTried.set(code, now);
      try {
        const res = await netFetch('https://query1.finance.yahoo.com/v8/finance/chart/'
          + `${encodeURIComponent(symbolOf.get(code))}?range=5d&interval=1d`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) return;
        const meta = (await res.json())?.chart?.result?.[0]?.meta;
        const close = dailyRegularClose(
          { price: meta?.regularMarketPrice, timeMs: meta?.regularMarketTime * 1000 },
          baseMap.get(code)?.stockExchangeType?.endTime);
        if (!close) return;
        regularCloseCache.set(code, close);
        // Patch the two fields instead of rebuilding: the session decision and
        // any override above it stay exactly as they were.
        const q = quotes[code];
        q.regularClose = close.price;
        q.fromClose = overFromClose(close.price, q.price, q.priceSession);
      } catch { /* 일봉을 못 받으면 종가 대비 줄만 빠진다 */ }
    }));
    if (!Object.keys(quotes).length) return { ok: false, error: '빈 응답 또는 시세 조회 실패' };
    return { ok: true, quotes };
  } catch (err) {
    return { ok: false, error: err.message || '실시간 조회 실패' };
  }
});

// 코스피/코스닥 지수 (실시간). 다종목 응답에는 *Raw 필드가 빠져 있어 문자열을 직접 파싱한다.
ipcMain.handle('quote:indices', async () => {
  const url = 'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ';
  // 지수 헤더용 값. 빠진 값은 0 이 아니라 null — 0 이면 시가 0 캔들, 전일 대비 0 이 된다.
  const opt = (v) => {
    const s = String(v ?? '').replace(/,/g, '').trim();
    const n = s ? Number(s) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  try {
    const res = await netFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const items = (json.datas || []).map((d) => ({
      code: d.itemCode,
      name: d.stockName,
      value: opt(d.closePriceRaw ?? d.closePrice),
      // 지수도 종목처럼 내리면 음수다(2026-10-02 코스닥 -1.00 실측)
      change: opt(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice),
      pct: opt(d.fluctuationsRatioRaw ?? d.fluctuationsRatio),
      open: opt(d.openPriceRaw ?? d.openPrice),
      high: opt(d.highPriceRaw ?? d.highPrice),
      low: opt(d.lowPriceRaw ?? d.lowPrice),
      isOpen: d.marketStatus === 'OPEN',
      tradedAt: d.localTradedAt || null,
    // 종가 · 등락률이 비면 그 지수는 뺀다 — 0 으로 읽으면 지수 줄에 "코스피 0.00" 이 뜬다.
    })).filter((i) => i.value > 0 && i.pct != null);

    return items.length ? { ok: true, items } : { ok: false, error: '빈 응답' };
  } catch (err) {
    return { ok: false, error: err.message || '지수 조회 실패' };
  }
});

// 원/달러 환율. 포트폴리오 합계에서 달러 종목을 원화로 환산할 때만 쓴다.
// 심볼 'KRW=X' 는 '=' 때문에 yf:chart 의 심볼 허용 패턴에 걸린다.
// 패턴을 넓히는 대신 URL 을 고정한 전용 핸들러를 둔다(렌더러 입력이 아예 없다).
ipcMain.handle('fx:usdkrw', async () => {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?range=1d&interval=1d';
  try {
    const res = await netFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const rate = (await res.json())?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return Number.isFinite(rate) ? { ok: true, rate } : { ok: false, error: '빈 응답' };
  } catch (err) {
    return { ok: false, error: err.message || '환율 조회 실패' };
  }
});

// 업종. Yahoo 의 quoteSummary(assetProfile)는 크럼 토큰을 요구해 막히는데,
// 검색 엔드포인트는 심볼로 조회하면 인증 없이 sector/industry 를 같이 준다.
// 분류는 GICS 기준이라 한국거래소 업종("전기/전자")과 다르고, ETF 는 값이 없다.
ipcMain.handle('yf:sector', async (_e, symbol) => {
  if (!SYMBOL_RE.test(String(symbol ?? ''))) return { ok: false, error: '잘못된 요청' };
  const url = 'https://query1.finance.yahoo.com/v1/finance/search'
    + `?q=${encodeURIComponent(symbol)}&quotesCount=1&newsCount=0`;
  try {
    const res = await netFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const hit = (await res.json())?.quotes?.[0];
    // 심볼이 정확히 맞을 때만 쓴다. 검색이라 엉뚱한 종목이 1등으로 올 수 있다.
    if (!hit || hit.symbol !== symbol) return { ok: true, sector: null, industry: null };
    return { ok: true, sector: hit.sectorDisp || null, industry: hit.industryDisp || null };
  } catch (err) {
    return { ok: false, error: err.message || '업종 조회 실패' };
  }
});

// 종목 검색. Yahoo 검색은 한글 쿼리에 400을 주므로 네이버 자동완성을 쓴다.
// (주식·ETF 모두 한글명으로 잡히고 코스피/코스닥까지 알려준다)
ipcMain.handle('yf:search', async (_e, query) => {
  const q = String(query ?? '').slice(0, 50); // 길이 상한
  if (!q) return { ok: true, items: [] };
  const url = 'https://m.stock.naver.com/front-api/search/autoComplete'
    + `?query=${encodeURIComponent(q)}&target=stock`;
  try {
    const res = await netFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const items = (json.result?.items || [])
      .filter((i) => i.code && (i.nationCode === 'KOR' || i.nationCode === 'USA'))
      .map((i) => ({
        // 국내는 코스닥 .KQ / 코스피 .KS, 미국은 티커 그대로 (Yahoo 심볼 규칙)
        symbol: i.nationCode === 'KOR'
          ? i.code + (i.typeCode === 'KOSDAQ' ? '.KQ' : '.KS')
          : i.code,
        name: i.name,
        market: i.typeName || i.typeCode,
      }));
    return { ok: true, items: items.slice(0, 12) };
  } catch (err) {
    return { ok: false, error: err.message || '검색 실패' };
  }
});

// 성공: { ok:true, symbol, price, closes[], times[], volumes[], highs[], lows[] }
// 실패: { ok:false, error }  (렌더러에서 그대로 표시)
// 렌더러가 넘기는 값은 신뢰하지 않고 허용 목록으로 검사한다.
// (호스트는 고정이지만, 쿼리에 임의 문자열이 그대로 들어가지 않도록)
// max · 1mo 는 전체 탭이다. 야후는 max 면 묻는 봉 크기와 상관없이 기간에 따라 월봉 · 주봉 · 분기봉을
// 준다(2026-10-14 실측). 1d 로 묻지 않아야 아래 일봉용 빈 날 채우기(fillGaps)가 끼지 않는다.
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '1y', '5y', 'max']);
const INTERVALS = new Set(['5m', '30m', '1d', '1mo']);
// 지수는 야후 기호가 ^ 로 시작한다(^KS11 코스피 · ^KQ11 코스닥). 맨 앞 한 번만 받는다.
const SYMBOL_RE = /^\^?[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$/;

// 야후는 국내 종목 일봉을 가끔 하루 통째로 비워 준다(종가 · 거래량 null). 2025-09-19 · 2026-10-12 는
// 모든 국내 종목이 비었고 1년이 지나도 채워지지 않았다(2026-10-13 확인). 비운 채 두면 차트에서 그날이
// 빠지고 이동평균 · RSI · 추세 점검이 그날 없이 계산된다 — 그날만 네이버 일봉으로 채운다.
// 네이버는 증자 · 분할 · 분배금을 지난 가격에 반영하고(수정주가) 야후 close 는 액면분할만 반영한다. 그런 종목은
// 두 값의 기준이 다르다(2026-10-13 실측: 삼성바이오로직스 2025-09-19 야후/네이버 1.053, KODEX 200 1.03~1.10).
// 그대로 넣으면 그날만 움푹 꺼지므로 빈 날 앞뒤로 가까운 날 5일씩의 야후/네이버 종가 비율 중앙값을 곱한다.
// 중앙값이라 빈 날 바로 앞날처럼 야후 값이 어긋난 하루에 끌리지 않는다. 1% 안쪽은 기준 차이가 아니라
// 날마다 한두 틱 다른 잡음이라(같은 날 국내 60종목 0.995~1.008) 거래소 종가인 네이버 값을 그대로 둔다.
// 지난 날은 바뀌지 않으므로 받은 봉(네이버에도 없던 빈 날은 null)을 '코드:YYYYMMDD' 로 기억해 다시 묻지 않는다.
// 오늘 칸은 채우지도 비율에 쓰지도 않는다 — 장중에 움직이고, renderer 가 실시간 값으로 맞춘다(loadQuote).
const naverDays = new Map();
const NAVER_NEAR = 5;            // 비율을 볼 빈 날 앞뒤 날 수
const NAVER_SCALE_MIN = 0.01;    // 이보다 작은 비율 차이는 잡음으로 본다
const kstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');

async function fillGaps(symbol, stamps, q) {
  const m = /^([A-Za-z0-9]{1,10})\.(KS|KQ)$/.exec(symbol);
  if (!m || !Array.isArray(q.close)) return;
  const code = m[1];
  const today = kstDay(Date.now());
  const days = stamps.map((t) => kstDay(t * 1000));
  const gaps = [];
  days.forEach((d, i) => { if (q.close[i] == null && d < today) gaps.push(i); });
  const ask = gaps.filter((i) => !naverDays.has(`${code}:${days[i]}`));
  if (ask.length) {
    // 비율을 볼 앞뒤 날까지 한 번에 받는다
    const from = days[Math.max(0, ask[0] - 2 * NAVER_NEAR)];
    const to = days[Math.min(days.length - 1, ask[ask.length - 1] + 2 * NAVER_NEAR)];
    const url = `https://api.stock.naver.com/chart/domestic/item/${code}/day`
      + `?startDateTime=${from}0000&endDateTime=${to}2359`;
    try {
      const res = await netFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' } });
      if (res.ok) {
        const rows = await res.json();
        for (const x of Array.isArray(rows) ? rows : []) {
          const d = String(x.localDate);
          if (d < today && Number(x.closePrice) > 0) naverDays.set(`${code}:${d}`, {
            close: Number(x.closePrice), open: Number(x.openPrice), high: Number(x.highPrice),
            low: Number(x.lowPrice), volume: Number(x.accumulatedTradingVolume) || 0,
          });
        }
        for (const i of ask) if (!naverDays.has(`${code}:${days[i]}`)) naverDays.set(`${code}:${days[i]}`, null);
      }
    } catch { /* 지금처럼 그날을 뺀다. 기억하지 않으므로 다음 요청에서 다시 묻는다 */ }
  }
  // 비율은 채우기 전에 구한다 — 채운 날이 다른 빈 날의 비율에 섞이지 않게
  const ratio = (j) => {
    const bar = q.close[j] != null && naverDays.get(`${code}:${days[j]}`);
    return bar ? q.close[j] / bar.close : null;
  };
  const scales = gaps.map((i) => {
    const rs = [];
    for (const step of [-1, 1]) {
      for (let j = i + step, k = 0; k < NAVER_NEAR && Math.abs(j - i) <= 2 * NAVER_NEAR; j += step) {
        const r = ratio(j);
        if (r) { rs.push(r); k++; }
      }
    }
    if (!rs.length) return 1;
    rs.sort((a, b) => a - b);
    const h = rs.length >> 1;
    const mid = rs.length % 2 ? rs[h] : (rs[h - 1] + rs[h]) / 2;
    return Math.abs(mid - 1) < NAVER_SCALE_MIN ? 1 : mid;
  });
  gaps.forEach((i, g) => {
    const bar = naverDays.get(`${code}:${days[i]}`);
    if (!bar) return;
    const s = scales[g];
    for (const k of ['open', 'high', 'low', 'volume']) if (!Array.isArray(q[k])) q[k] = [];
    q.close[i] = bar.close * s; q.open[i] = bar.open * s; q.high[i] = bar.high * s; q.low[i] = bar.low * s; q.volume[i] = bar.volume;
  });
}

ipcMain.handle('yf:chart', async (_e, { symbol, range, interval }) => {
  if (!SYMBOL_RE.test(String(symbol ?? '')) || !RANGES.has(range) || !INTERVALS.has(interval)) {
    return { ok: false, error: '잘못된 요청' };
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?range=${range}&interval=${interval}`;
  try {
    const res = await netFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return { ok: false, error: json?.chart?.error?.description || '데이터 없음' };
    if (interval === '1d') await fillGaps(symbol, result.timestamp || [], result.indicators?.quote?.[0] || {});

    // close 배열에는 실제로 null이 섞여 나온다 → timestamp와 짝을 맞춰 제거
    const rawCloses = result.indicators?.quote?.[0]?.close || [];
    // 거래량·시가·고가·저가는 close 와 같은 객체에 이미 들어있다 (추가 요청 없음)
    const q0 = result.indicators?.quote?.[0] || {};
    const rawVolumes = q0.volume || [];
    const rawOpens = q0.open || [];
    const rawHighs = q0.high || [];
    const rawLows = q0.low || [];
    const stamps = result.timestamp || [];
    const closes = [];
    const times = [];
    const volumes = [];
    const opens = [];
    const highs = [];
    const lows = [];
    for (let i = 0; i < rawCloses.length; i++) {
      if (rawCloses[i] == null) continue;
      closes.push(rawCloses[i]);
      times.push(stamps[i] * 1000);
      volumes.push(rawVolumes[i] ?? 0);
      // 시가/고가/저가가 비면 종가로 대체해 밴드 폭이 0 이 되게 한다
      opens.push(rawOpens[i] ?? rawCloses[i]);
      highs.push(rawHighs[i] ?? rawCloses[i]);
      lows.push(rawLows[i] ?? rawCloses[i]);
    }
    if (!closes.length) return { ok: false, error: '빈 데이터' };

    return {
      ok: true,
      symbol,
      price: result.meta?.regularMarketPrice ?? closes[closes.length - 1],
      // 52주 고저는 meta에 이미 들어있어 추가 요청이 필요 없다
      currency: result.meta?.currency ?? 'KRW',
      week52High: result.meta?.fiftyTwoWeekHigh ?? null,
      week52Low: result.meta?.fiftyTwoWeekLow ?? null,
      closes,
      times,
      volumes,
      opens,
      highs,
      lows,
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

// 한 번만 실행한다. 위젯이 둘 뜨면 각자 관심종목 전체를 저장해 서로 덮어쓰고(한쪽에서
// 추가한 종목이 다른 쪽 저장에 사라진다), 네이버 요청도 두 배가 된다. 두 번째 실행은 창을
// 만들지 않고 끝내고, 이미 떠 있는 창을 앞으로 가져온다 — 숨겼거나 최소화해 뒀어도.
// 잠금은 userData 경로마다 걸린다. 테스트는 --user-data-dir 로 따로 잡혀 켜 둔 위젯과 겹치지 않는다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.setAlwaysOnTop(true, 'screen-saver'); // 숨겼다 켜면 최상단 레벨이 풀리는 경우가 있다
  });

  app.whenReady().then(() => {
    // Windows에서 알림이 뜨려면 AppUserModelID가 필요하다
    if (process.platform === 'win32') app.setAppUserModelId('com.wuid0801.kr-stock-widget');
    // 설치본에서는 Electron 기본 메뉴를 없앤다. 테두리 없는 창이라 메뉴줄은 안 보여도 단축키는
    // 살아 있어서 Ctrl+W 는 앱을 끄고(알림도 끊긴다) Ctrl+M 은 작업표시줄 버튼 없는 창을 숨기고
    // Ctrl+R 은 접힌 상태를 어긋나게 한다. 개발 실행은 새로고침 · 개발자 도구를 쓰도록 둔다.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
    registerToggle();
    // 깨진 설정을 옮겨 두고 처음 상태로 떴다 — 목록이 비어 보이는 까닭과 원래 파일 자리를 알린다
    if (brokenConfig && Notification.isSupported()) {
      new Notification({
        title: '설정 파일을 읽지 못했습니다',
        body: `처음 상태로 시작했습니다. 원래 파일은 ${path.basename(brokenConfig)} 로 옮겨 두었습니다.`,
      }).show();
    }
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
