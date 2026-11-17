// 요청 시간 제한 — 앱을 띄우지 않고 main.js 의 요청 핸들러를 직접 부른다.
//
// 답을 주지 않는 서버에 요청 하나가 걸리면 렌더러의 갱신이 끝나지 않는다(busy).
// 그동안 자동 갱신도 ↻ 도 돌지 않는다. 시간 제한이 없으면 Node 기본값으로 최대 5분이다.
// 여기서는 fetch 를 "영원히 답하지 않는 서버"로 바꿔 끼우고, 모든 핸들러가 제한 시간에
// 포기하고 { ok:false } 로 끝나는지 본다. 제한 시간은 8초 대신 10ms 로 줄여 돌린다.
import { loadMain } from './_main.mjs';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// 연결은 되지만 답이 오지 않는 서버. 신호가 끊겨야만 실패로 끝난다.
const hang = (_url, opt = {}) => new Promise((_, reject) => {
  opt.signal?.addEventListener('abort', () => reject(opt.signal.reason));
});
const limits = [];
const FastAbortSignal = { timeout: (ms) => { limits.push(ms); return AbortSignal.timeout(10); } };

// main.js 를 불러 처리기를 꺼낸다 — Electron net.fetch(FRED)도 끼운 fetch 를 따른다(loadMain)
let handlers = loadMain({ globals: { fetch: hang, AbortSignal: FastAbortSignal } });

// 네트워크를 쓰는 핸들러 전부. 새로 추가하면 여기에도 넣어야 아래 검사가 통과한다.
const CALLS = {
  'quote:realtime': [['005930.KS']],
  'quote:indices': [],
  'naver:venueDays': ['005930.KS', '20260101'],
  'yf:sector': ['005930.KS'],
  'naver:detail': ['005930.KS'],
  'naver:rank': [{ market: 'kr', kind: 'up' }],
  'market:extras': [],
  'market:flowHistory': [],
  'naver:events': ['005930.KS'],
  'yf:search': ['삼성'],
  'yf:chart': [{ symbol: '005930.KS', range: '1d', interval: '5m' }],
};
// 설정(state:) · 백업(backup:, 파일 창 · 로컬 파일)은 네트워크를 쓰지 않는다
const network = Object.keys(handlers).filter((k) => !k.startsWith('state:') && !k.startsWith('backup:'));
const unlisted = network.filter((k) => !(k in CALLS));
check('네트워크 핸들러가 전부 이 스위트에 있다', unlisted.length === 0,
  unlisted.length ? `목록에 없음: ${unlisted.join(' ')}` : `${network.length}개`);

const GUARD = 1000; // 이 안에 안 끝나면 "멈춤"으로 본다
const results = await Promise.all(Object.entries(CALLS).map(async ([name, args]) => {
  if (!handlers[name]) return [name, 'missing'];
  let timer;
  const guard = new Promise((r) => { timer = setTimeout(() => r('hang'), GUARD); });
  const out = await Promise.race([handlers[name]({}, ...args), guard]);
  clearTimeout(timer);
  return [name, out];
}));

for (const [name, out] of results) {
  check(`${name} 가 답 없는 서버에 멈추지 않고 실패로 끝난다`, out && out.ok === false,
    out === 'hang' ? `${GUARD}ms 안에 안 끝남` : out === 'missing' ? '핸들러 없음' : JSON.stringify(out));
}

const chart = results.find(([n]) => n === 'yf:chart')[1];
check('시간 초과는 한글로 알린다', chart && chart.error === '응답 시간 초과', JSON.stringify(chart));
check('제한 시간은 8초다', limits.length > 0 && limits.every((ms) => ms === 8000), limits.join(','));

// 인터넷이 끊기면 Node fetch 는 영어 'fetch failed'(TypeError)를 던진다. 화면에 그대로 뜨면
// ("삼성전자 차트: fetch failed") 나머지가 다 한글인 곳에서 원인을 알기 어렵다.
// 원인 코드(cause.code)는 상황마다 달라(DNS 실패 ENOTFOUND, 연결 거부는 없음) 한 문구로 묶는다.
for (const cause of [{ code: 'ENOTFOUND' }, undefined]) {
  const offline = async () => { throw new TypeError('fetch failed', cause ? { cause } : undefined); };
  handlers = loadMain({ globals: { fetch: offline, AbortSignal } });
  const off = await Promise.all(Object.entries(CALLS).map(async ([name, args]) => [name, await handlers[name]({}, ...args)]));
  const english = off.filter(([, o]) => JSON.stringify(o).includes('fetch failed'));
  const tag = cause ? cause.code : '원인 코드 없음';
  check(`인터넷이 끊겨도(${tag}) 영어 "fetch failed" 를 내보내지 않는다`, english.length === 0,
    english.map(([n, o]) => `${n} ${JSON.stringify(o)}`).join(' / '));
  const offChart = off.find(([n]) => n === 'yf:chart')[1];
  check(`네트워크 실패(${tag})는 한글로 알린다`, offChart.error === '네트워크 연결 실패', JSON.stringify(offChart));
}

// 머리(상태 줄)는 오는데 본문이 끊긴 서버 — 시간 제한 신호는 본문을 읽는 동안에도 살아 있어 res.json() 이 영어
// TimeoutError("The operation was aborted due to timeout")로 끝났다(느린 회선에서 야후 5년 일봉을 받을 때).
{
  const slowBody = async (_url, opt = {}) => ({
    ok: true, status: 200,
    // 진짜 fetch 처럼 이미 끊긴 신호면 바로 실패한다
    json: () => new Promise((_, reject) => (opt.signal?.aborted ? reject(opt.signal.reason)
      : opt.signal?.addEventListener('abort', () => reject(opt.signal.reason)))),
  });
  handlers = loadMain({ globals: { fetch: slowBody, AbortSignal: FastAbortSignal } });
  const keepAlive = setTimeout(() => {}, GUARD); // AbortSignal.timeout 의 타이머는 프로세스를 붙잡지 않는다
  const out = await Promise.all(Object.entries(CALLS).map(async ([name, args]) => [name, await handlers[name]({}, ...args)]));
  clearTimeout(keepAlive);
  const english = out.filter(([, o]) => /aborted|TimeoutError/.test(JSON.stringify(o)));
  check('본문을 받다 시간이 다 돼도 영어 문구를 내보내지 않는다', english.length === 0,
    english.map(([n, o]) => `${n} ${JSON.stringify(o)}`).join(' / '));
  const slowChart = out.find(([n]) => n === 'yf:chart')[1];
  check('본문 시간 초과도 "응답 시간 초과"', slowChart.error === '응답 시간 초과', JSON.stringify(slowChart));
}

// 렌더러가 보내는 값의 모양을 믿지 않는다 — 구조 분해 · 배열 메서드가 예외로 끝나지 않고 { ok:false } 로 답한다
{
  const chartNull = await handlers['yf:chart']({}, null);
  check('차트 요청 값이 없으면 잘못된 요청', chartNull.ok === false && chartNull.error === '잘못된 요청', JSON.stringify(chartNull));
  const rtBad = await handlers['quote:realtime']({}, '005930.KS');
  check('실시간 시세 요청이 배열이 아니면 잘못된 요청', rtBad.ok === false && rtBad.error === '잘못된 요청', JSON.stringify(rtBad));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
