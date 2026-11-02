// 설정 백업 · 복원(backup:export · backup:import) — 앱을 띄우지 않고 가짜 electron 으로 main.js 의 핸들러를 부른다.
//
// 보유 수량 · 평단가 · 목표가는 이 PC 의 설정 파일에만 있다. 파일로 내보내고 불러와 PC 를 옮기거나 설정 파일이
// 깨졌을 때 되살린다. 파일 창 · 확인 창은 가짜로 바꾸고, 파일은 임시 폴더에 실제로 쓰고 읽는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMain } from './_main.mjs';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-backup-'));
const docs = path.join(dir, 'docs');
fs.mkdirSync(docs);

// 설정 저장소 흉내 — main.js 는 store.get / store.set 만 쓴다
const data = {
  watchlist: [{ symbol: '005930.KS', name: '삼성전자' }, { symbol: 'AAPL', name: '애플' }],
  selected: '005930.KS', timeframe: '3M', alerts: { enabled: true, targets: { '005930.KS': { up: 250000 } } },
  holdings: { '005930.KS': { qty: 10, avg: 200000 } }, theme: 'dark', opacity: 74, maPeriods: [5, 20, 60], maStyles: {},
  chartMode: 'candle', plainChart: false, infoOpen: true, indicators: { bb: true, sar: false }, extHours: true,
  bounds: { width: 340, height: 520 },
};
// conf 는 set 을 부를 때마다 파일 전체를 읽고 다시 쓴다 — 부른 횟수(writes)가 곧 파일 쓰기 횟수다
const sets = [];
let writes = 0;
class FakeStore {
  get(k) { return JSON.parse(JSON.stringify(data[k] ?? null)); }
  set(k, v) {
    writes++;
    for (const [a, b] of Object.entries(typeof k === 'object' ? k : { [k]: v })) { sets.push(a); data[a] = b; }
  }
}
// 파일 창 · 확인 창 — 다음에 돌려줄 값을 테스트가 정한다
const dialogs = [];
let nextSave = null; let nextOpen = null; let nextAnswer = 0;
const dialog = {
  showSaveDialog: async (...a) => { dialogs.push(['save', a.at(-1)]); return nextSave; },
  showOpenDialog: async (...a) => { dialogs.push(['open', a.at(-1)]); return nextOpen; },
  showMessageBox: async (...a) => { dialogs.push(['box', a.at(-1)]); return { response: nextAnswer }; },
};
const handlers = loadMain({ store: FakeStore, electron: { Menu: {}, dialog,
  app: { getPath: (k) => (k === 'documents' ? docs : dir), whenReady: () => new Promise(() => {}), on() {}, requestSingleInstanceLock: () => true } } });

const p2 = (n) => String(n).padStart(2, '0');
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; })();
const KEYS = ['watchlist', 'selected', 'timeframe', 'alerts', 'holdings', 'theme', 'opacity', 'maPeriods', 'maStyles',
  'chartMode', 'plainChart', 'infoOpen', 'indicators', 'extHours'];

// --- 1. 내보내기 ------------------------------------------------------------------------
{
  const out = path.join(dir, 'mine.json');
  nextSave = { canceled: false, filePath: out };
  const r = await handlers['backup:export']({});
  check('내보내기 성공 — 관심종목 · 보유 수', r.ok && same(r.counts, { watchlist: 2, holdings: 1, targets: 1 }) && r.path === out, JSON.stringify(r));
  check('저장 창의 기본 이름은 문서 폴더의 stock-widget-backup-날짜.json',
    dialogs.at(-1)[1].defaultPath === path.join(docs, `stock-widget-backup-${today}.json`), dialogs.at(-1)[1].defaultPath);
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('파일 머리(app · version · savedAt)', saved.app === 'stock-widget' && saved.version === 1 && !Number.isNaN(Date.parse(saved.savedAt)));
  check('저장되는 설정을 모두 담는다', same(Object.keys(saved.state), KEYS), Object.keys(saved.state).join(' '));
  check('창 위치 같은 것은 담지 않는다', !('bounds' in saved.state));
  check('값 그대로', same(saved.state.holdings, data.holdings) && same(saved.state.watchlist, data.watchlist));
  check('사람이 읽을 수 있게 들여 쓴다', fs.readFileSync(out, 'utf8').includes('\n  "state": {'));
  nextSave = { canceled: true };
  const c = await handlers['backup:export']({});
  check('저장 창을 닫으면 아무것도 하지 않는다', c.ok === false && c.canceled === true);
}

// --- 2. 불러오기 ------------------------------------------------------------------------
const file = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); return f; };
{
  const incoming = { app: 'stock-widget', version: 1, state: {
    watchlist: [{ symbol: '000660.KS', name: 'SK하이닉스' }, { symbol: '../bad', name: 'x' }, { symbol: 'NVDA', name: '엔비디아' },
      { symbol: 'NVDA', name: '두 번' }, { name: '기호 없음' }, { symbol: 'TSLA', name: '테슬라' }],
    holdings: { '000660.KS': { qty: 2, avg: 1600000 }, NVDA: { qty: 0, avg: 100 }, AAPL: { qty: '5', avg: 1 } },
    alerts: { enabled: 'yes', targets: { '000660.KS': { up: 1800000, down: -5 }, BAD$: { up: 1 } } },
    theme: 'purple', opacity: 74, chartMode: 'line', plainChart: true, indicators: { bb: true, vp: 'no' }, extHours: false,
    bounds: { width: 9999 }, __proto__x: 1,
  } };
  nextOpen = { canceled: false, filePaths: [file('in.json', '﻿' + JSON.stringify(incoming))] };
  nextAnswer = 0;
  sets.length = 0;
  writes = 0;
  const before = JSON.parse(JSON.stringify(data));
  const r = await handlers['backup:import']({});
  check('불러온 설정은 파일에 한 번에 쓴다', writes === 1, `${writes}번`);
  check('불러오기 성공 — 불러온 뒤의 수(지금의 2개가 아니라 3개)', r.ok && same(r.counts, { watchlist: 3, holdings: 1, targets: 1 }), JSON.stringify(r));
  const box = dialogs.at(-1);
  check('바꾸기 전에 확인 창 — 무엇이 몇 개인지와 직전 설정을 어디에 두는지', box[0] === 'box' && box[1].buttons[0] === '바꾸기'
    && box[1].cancelId === 1 && /관심종목 3개 · 보유 1개 · 목표가 1개/.test(box[1].detail) && box[1].detail.includes(r.before), box[1].detail);
  check('직전 설정은 같은 폴더에 따로 저장', path.dirname(r.before) === dir && /stock-widget-before-import-\d{4}-\d{2}-\d{2}-\d{6}\.json$/.test(r.before)
    && same(JSON.parse(fs.readFileSync(r.before, 'utf8')).state.holdings, before.holdings), r.before);
  check('모양이 틀린 줄은 버린다(잘못된 기호 · 겹친 기호 · 기호 없음)',
    same(data.watchlist, [{ symbol: '000660.KS', name: 'SK하이닉스' }, { symbol: 'NVDA', name: '엔비디아' }, { symbol: 'TSLA', name: '테슬라' }]),
    JSON.stringify(data.watchlist));
  check('보유 — 수량 · 평단가가 0보다 큰 수만', same(data.holdings, { '000660.KS': { qty: 2, avg: 1600000 } }), JSON.stringify(data.holdings));
  check('목표가 — 0보다 큰 값 · 맞는 기호만, 켬은 true 일 때만', same(data.alerts, { enabled: false, targets: { '000660.KS': { up: 1800000 } } }),
    JSON.stringify(data.alerts));
  check('모르는 값(테마 purple)은 바꾸지 않는다', data.theme === 'dark' && !sets.includes('theme'));
  check('아는 값은 바꾼다', data.chartMode === 'line' && data.plainChart === true && same(data.indicators, { bb: true })
    && data.extHours === false);
  check('모르는 키(창 위치 등)는 쓰지 않는다', !sets.includes('bounds') && !sets.some((k) => !KEYS.includes(k)), sets.join(' '));
  check('파일에 없는 설정은 그대로 둔다', data.timeframe === '3M' && same(data.maPeriods, [5, 20, 60]));
}
{
  // 모양이 틀린 값은 그 설정만 건너뛴다 — 범위 밖 투명도 · 잘못된 기호 · 문자열 아닌 기간 · 참거짓 아닌 켬
  nextOpen = { canceled: false, filePaths: [file('odd.json', { state: { opacity: 5, selected: '../x', timeframe: { a: 1 },
    maPeriods: [5, -1, 2.5, 'x', 1001, 20], infoOpen: 'yes', plainChart: 1, extHours: 'no' } })] };
  nextAnswer = 0;
  sets.length = 0;
  const r = await handlers['backup:import']({});
  check('이동평균 기간은 1~1000 정수만 남긴다', r.ok && same(data.maPeriods, [5, 20]), JSON.stringify(data.maPeriods));
  check('틀린 투명도 · 선택 · 기간 · 켬은 바꾸지 않는다', same(sets, ['maPeriods']) && data.opacity === 74 && data.selected === '005930.KS'
    && data.timeframe === '3M' && data.infoOpen === true && data.plainChart === true && data.extHours === false, sets.join(' '));
}

// --- 2b. 설정 저장(state:set) — 렌더러 save() 는 클릭마다 키 14개를 보낸다 ----------------------------
// 키마다 store.set 을 부르면 파일을 14번 읽고 쓴다(저장 1회 47~71ms, 2026-10-21 측정) — 한 번에 쓴다.
{
  writes = 0;
  sets.length = 0;
  await handlers['state:set']({}, { theme: 'dark', opacity: 80, selected: '005930.KS', timeframe: '1W', bounds: { x: 1 }, nope: 1, plainChart: undefined });
  check('저장은 파일에 한 번 쓴다', writes === 1, `${writes}번`);
  check('아는 키만 · undefined 는 빼고', same(sets, ['theme', 'opacity', 'selected', 'timeframe']) && data.opacity === 80, sets.join(' '));
  writes = 0;
  await handlers['state:set']({}, { nope: 1 });
  await handlers['state:set']({}, null);
  check('쓸 것이 없으면 쓰지 않는다', writes === 0, `${writes}번`);
}

// --- 3. 취소 · 잘못된 파일 ------------------------------------------------------------------
{
  const snapshot = JSON.stringify(data);
  nextOpen = { canceled: false, filePaths: [file('ok.json', { state: { theme: 'light' } })] };
  const files = fs.readdirSync(dir).length;
  nextAnswer = 1;
  let r = await handlers['backup:import']({});
  check('확인 창에서 취소하면 아무것도 바꾸지 않고 직전 설정도 쓰지 않는다', r.ok === false && r.canceled && JSON.stringify(data) === snapshot
    && fs.readdirSync(dir).length === files + 0, JSON.stringify(r));
  nextAnswer = 0;
  nextOpen = { canceled: true, filePaths: [] };
  r = await handlers['backup:import']({});
  check('열기 창을 닫으면 아무것도 하지 않는다', r.ok === false && r.canceled === true);
  for (const [name, body, why] of [['bad.json', '{ 이건 JSON 이 아니다', /JSON/], ['empty.json', { hello: 1 }, /백업 파일이 아닙니다/],
    ['arr.json', '[1,2,3]', /백업 파일이 아닙니다/], ['big.json', JSON.stringify({ state: { theme: 'x'.repeat(1024 * 1024) } }), /1MB/]]) {
    nextOpen = { canceled: false, filePaths: [file(name, body)] };
    r = await handlers['backup:import']({});
    check(`${name} — 불러오지 않고 이유를 말한다`, r.ok === false && why.test(r.error) && JSON.stringify(data) === snapshot, r.error);
  }
  // 설정 파일(config.json)을 그대로 골라도 된다 — 머리 없이 설정이 바로 있는 꼴
  nextOpen = { canceled: false, filePaths: [file('config.json', { theme: 'light', bounds: { x: 1 } })] };
  r = await handlers['backup:import']({});
  check('머리 없는 설정 파일(config.json)도 받는다', r.ok && data.theme === 'light', JSON.stringify(r));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
