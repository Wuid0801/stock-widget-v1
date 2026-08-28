// main.js — Electron 메인 프로세스
// 역할: 프레임리스/반투명/항상위 위젯 창 생성, 창 상태 저장·복원,
//       Yahoo Finance chart API 프록시(렌더러는 CORS 때문에 직접 호출 불가).

const { app, BrowserWindow, ipcMain, screen, globalShortcut, Notification } = require('electron');
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
  // electron-store 는 기본적으로 app.getName() 기준 폴더에 저장한다.
  // productName 을 붙이면 저장 위치가 바뀌어 기존 설정이 통째로 사라지므로 경로를 고정한다.
  cwd: path.join(app.getPath('appData'), 'kr-stock-widget'),
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
  if (Number.isInteger(b.x) && Number.isInteger(b.y)) {
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }

  // 전체화면 앱 위에서도 유지되도록 screen-saver 레벨
  win.setAlwaysOnTop(true, 'screen-saver');

  // 이 앱은 로컬 페이지 하나만 띄운다. 어떤 경로로든 외부 페이지로 이동하거나
  // 새 창이 열리는 일이 없도록 막는다.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

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
}));

ipcMain.handle('state:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch || {})) {
    // electron-store 는 undefined 를 거부하며 예외를 던진다. 저장할 값이 없으면 그냥 건너뛴다.
    if (v === undefined) continue;
    if (['watchlist', 'selected', 'timeframe', 'alerts', 'holdings', 'theme', 'opacity', 'maPeriods'].includes(k)) store.set(k, v);
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
ipcMain.on('win:dock', (_e, on, height) => {
  if (!win) return;
  compact = on;
  if (on) {
    // store의 bounds에는 창을 한 번도 옮기지 않았으면 x/y가 없다.
    // 그 값으로 되돌리면 크기만 바뀌고 우하단에 머무르므로 직접 기억해 둔다.
    // 이미 잡아둔 기준이 있으면 다시 읽지 않는다(위 saveBounds 주석 참고).
    const b = win.getBounds();
    if (!normalBounds) normalBounds = b;
    const area = screen.getDisplayMatching(b).workArea; // 작업표시줄을 피한 영역
    const margin = 12;
    const width = normalBounds.width; // 펼친 폭과 어긋나지 않도록 기준값을 쓴다
    // 최소 높이(MIN_H)를 먼저 낮추지 않으면 접힌 높이가 그대로 클램프된다
    win.setMinimumSize(MIN_W, height);
    win.setBounds({
      width,
      height,
      x: area.x + area.width - width - margin,
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
  // 네이버 실시간은 국내 전용. 해외 종목은 걸러내고 Yahoo 값을 그대로 쓰게 둔다.
  // 종목코드 형태를 확인해 URL 경로에 이상한 값이 끼어들지 않게 한다.
  const codes = (symbols || [])
    .filter((s) => /^[A-Za-z0-9]{1,10}\.(KS|KQ)$/.test(String(s)))
    .map((s) => String(s).split('.')[0]);
  if (!codes.length) return { ok: true, quotes: {} };

  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const num = (v) => Number(String(v ?? '').replace(/,/g, ''));
    const quotes = {};
    for (const d of json.datas || []) {
      let price = Number(d.closePriceRaw);
      let change = Number(d.compareToPreviousClosePriceRaw); // 하락이면 이미 음수
      if (!Number.isFinite(price) || !Number.isFinite(change)) continue;

      // 'regular' 정규장 · 'pre' 장전 시간외 · 'after' 장후·시간외 단일가 · 'closed' 전부 종료.
      let session = d.marketStatus === 'OPEN' ? 'regular' : 'closed';

      // 정규장이 끝나도 시간외가 열려 있으면 그쪽이 지금 가격이다.
      // 응답에 이미 들어있어 추가 요청은 없다. overPrice 계열은 Raw 필드가 없어 콤마를 걷어낸다.
      const over = d.overMarketPriceInfo;
      if (session !== 'regular' && over && over.overMarketStatus === 'OPEN') {
        const p = num(over.overPrice);
        const c = num(over.compareToPreviousClosePrice);
        if (Number.isFinite(p) && p > 0 && Number.isFinite(c)) {
          price = p;
          change = c; // 전일 종가 대비 (네이버가 주는 기준 그대로)
          session = over.tradingSessionType === 'BEFORE_MARKET' ? 'pre' : 'after';
        }
      }

      // 심볼 접미사(.KS/.KQ)가 어긋나도 되도록 종목코드로만 넘긴다
      quotes[d.itemCode] = {
        price, change, prevClose: price - change,
        open: session === 'regular',
        session,
      };
    }
    if (!Object.keys(quotes).length) return { ok: false, error: '빈 응답' };
    return { ok: true, quotes };
  } catch (err) {
    return { ok: false, error: err.message || '실시간 조회 실패' };
  }
});

// 코스피/코스닥 지수 (실시간). 다종목 응답에는 *Raw 필드가 빠져 있어 문자열을 직접 파싱한다.
ipcMain.handle('quote:indices', async () => {
  const url = 'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ';
  const num = (v) => Number(String(v ?? '').replace(/,/g, ''));
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const items = (json.datas || []).map((d) => ({
      name: d.stockName,
      value: num(d.closePriceRaw ?? d.closePrice),
      pct: num(d.fluctuationsRatioRaw ?? d.fluctuationsRatio),
    })).filter((i) => Number.isFinite(i.value) && Number.isFinite(i.pct));

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
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
    const res = await fetch(url, {
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
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '1y', '5y']);
const INTERVALS = new Set(['5m', '30m', '1d']);
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$/;

ipcMain.handle('yf:chart', async (_e, { symbol, range, interval }) => {
  if (!SYMBOL_RE.test(String(symbol ?? '')) || !RANGES.has(range) || !INTERVALS.has(interval)) {
    return { ok: false, error: '잘못된 요청' };
  }
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
    // 거래량·고가·저가는 close 와 같은 객체에 이미 들어있다 (추가 요청 없음)
    const q0 = result.indicators?.quote?.[0] || {};
    const rawVolumes = q0.volume || [];
    const rawHighs = q0.high || [];
    const rawLows = q0.low || [];
    const stamps = result.timestamp || [];
    const closes = [];
    const times = [];
    const volumes = [];
    const highs = [];
    const lows = [];
    for (let i = 0; i < rawCloses.length; i++) {
      if (rawCloses[i] == null) continue;
      closes.push(rawCloses[i]);
      times.push(stamps[i] * 1000);
      volumes.push(rawVolumes[i] ?? 0);
      // 고가/저가가 비면 종가로 대체해 밴드 폭이 0 이 되게 한다
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

app.whenReady().then(() => {
  // Windows에서 알림이 뜨려면 AppUserModelID가 필요하다
  if (process.platform === 'win32') app.setAppUserModelId('com.wuid0801.kr-stock-widget');
  createWindow();
  registerToggle();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
