// 시간외(장후) 정규장 종가 대비 변동폭 검증.
//
// 네이버가 주는 시간외 등락(compareToPreviousClosePrice)은 '전일 종가' 기준이라
// 시간외에서 실제로 얼마나 움직였는지는 알 수 없다. 2026-09-10 17:31 실측:
//
//   SK하이닉스  정규장 종가 1,853,000  시간외 1,849,000
//               네이버 등락 -7,000(전일 대비)   실제 시간외 이동 -4,000
//
// 앞부분은 앱을 띄우지 않고 main.js 의 계산만 떼어내 본다(rsi.mjs 와 같은 방식).
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, CFG_PATH, SESSION_ENV, launchApp, waitReady } from './_paths.mjs';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// --- 1. 계산 규칙 ---------------------------------------------------------------
const src = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
const start = src.indexOf('function overFromClose');
const fn = start < 0 ? null
  : new Function(`${src.slice(start, src.indexOf('\n}', start) + 2)}; return overFromClose;`)();

check('main.js 에 overFromClose 가 있다', typeof fn === 'function', typeof fn);

if (typeof fn === 'function') {
  // 실측 두 건
  check('SK하이닉스 장후: 1,849,000 - 1,853,000 = -4,000', fn(1853000, 1849000, 'after') === -4000,
    String(fn(1853000, 1849000, 'after')));
  check('삼성전자 장후: 267,000 - 269,000 = -2,000', fn(269000, 267000, 'after') === -2000,
    String(fn(269000, 267000, 'after')));
  check('오르면 양수', fn(269000, 271500, 'after') === 2500, String(fn(269000, 271500, 'after')));
  check('안 움직였으면 0', fn(269000, 269000, 'after') === 0, String(fn(269000, 269000, 'after')));

  // 장전 시간외의 '종가'는 전일 종가라, 바로 위에 있는 전일 대비와 같은 숫자가 된다.
  // 줄만 늘어나므로 내지 않는다.
  check('장전 시간외(pre)에는 내지 않는다', fn(269000, 267000, 'pre') === null, String(fn(269000, 267000, 'pre')));
  check('정규장에는 내지 않는다', fn(269000, 267000, 'regular') === null, String(fn(269000, 267000, 'regular')));
  check('장 종료에는 내지 않는다', fn(269000, 267000, 'closed') === null, String(fn(269000, 267000, 'closed')));

  // 값이 비면 계산하지 않는다 (Yahoo 폴백·해외 종목은 시간외 정보가 없다)
  check('종가가 없으면 null', fn(undefined, 267000, 'after') === null, String(fn(undefined, 267000, 'after')));
  check('현재가가 없으면 null', fn(269000, null, 'after') === null, String(fn(269000, null, 'after')));
}

// --- 2. 화면에 실제로 뜨는가 -----------------------------------------------------
// 세션을 강제한다. 실제 시간외 체결가는 없으므로 값은 0 이 되고, 여기서 보는 것은
// "장후에는 줄이 있고 그 외에는 없다" 라는 표시 규칙이다.
const shown = async (session) => {
  fs.writeFileSync(CFG_PATH, '{}');
  const app = await launchApp({ [SESSION_ENV]: session });
  const page = await app.firstWindow();
  try {
    await waitReady(page);
    await page.waitForTimeout(1500);
    return await page.evaluate(() => {
      const el = document.getElementById('dclose');
      return { exists: !!el, hidden: el ? el.hidden : null, text: el ? el.textContent.trim() : null };
    });
  } finally {
    await app.close();
    await new Promise((r) => setTimeout(r, 1200));
  }
};

const after = await shown('after');
console.log('장후 강제:', JSON.stringify(after));
check('장후에는 종가 대비 줄이 뜬다', after.exists && !after.hidden, JSON.stringify(after));
check('문구가 "종가" 로 시작한다', !!after.text && after.text.startsWith('종가'), after.text);

const closed = await shown('closed');
console.log('장마감 강제:', JSON.stringify(closed));
check('장 종료에는 줄이 숨는다', closed.exists && closed.hidden, JSON.stringify(closed));

fs.writeFileSync(CFG_PATH, '{}');
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
