// C. 보유 수량 / 평단가 → 평가손익 검증
import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
import path from 'node:path'; import fs from 'node:fs';

const CFG = CFG_PATH;
const SHOTS = SHOTS_DIR;
fs.writeFileSync(CFG, '{}');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));

let app = await launchApp(); let page = await app.firstWindow();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await waitReady(page); await page.waitForTimeout(1500);

const disk = () => JSON.parse(fs.readFileSync(CFG, 'utf8')).holdings;
const hold = () => page.evaluate(() => {
  const el = document.getElementById('hold');
  return {
    hidden: el.hidden,
    text: el.innerText.replace(/\s+/g, ' ').trim(),
    plColor: el.querySelector('.hpl') ? el.querySelector('.hpl').style.color : null,
    name: document.getElementById('dname').textContent,
    price: Number(document.getElementById('dprice').textContent.replace(/[^\d.-]/g, '')),
  };
});
const openPanel = async () => { await page.click('#bell'); await page.waitForTimeout(500); };
const setHold = async (n, qty, avg) => {
  await page.fill(`#holdRows .arow:nth-child(${n}) input.qty`, String(qty));
  await page.evaluate((i) => document.querySelector(`#holdRows .arow:nth-child(${i}) input.qty`).blur(), n);
  await page.fill(`#holdRows .arow:nth-child(${n}) input.avg`, String(avg));
  await page.evaluate((i) => document.querySelector(`#holdRows .arow:nth-child(${i}) input.avg`).blur(), n);
  await page.waitForTimeout(500);
};

// --- 기본 상태 ---
check('입력 전에는 보유 줄 숨김', (await hold()).hidden);
await openPanel();
const ui = await page.evaluate(() => ({
  sections: [...document.querySelectorAll('#alertList .sect')].map((e) => e.textContent.trim().split(' ')[0]),
  alertRows: document.querySelectorAll('#alertRows .arow').length,
  holdRows: document.querySelectorAll('#holdRows .arow').length,
  ph: [...document.querySelectorAll('#holdRows .arow:nth-child(1) input')].map((e) => e.placeholder),
}));
console.log('설정 패널:', JSON.stringify(ui));
check('설정 패널에 두 섹션', ui.sections.length === 2, ui.sections.join(','));
check('보유 입력행이 관심종목 수만큼', ui.holdRows === 5, `${ui.holdRows}행`);
check('수량/평단가 입력칸', ui.ph.join(',') === '수량,평단가', ui.ph.join(','));
await page.screenshot({ path: path.join(SHOTS, 'holdings-panel.png') });

// --- 입력 → 저장 → 평가손익 ---
await setHold(1, 10, 200000);
check('디스크에 저장', disk()['005930.KS']?.qty === 10 && disk()['005930.KS']?.avg === 200000, JSON.stringify(disk()));
await page.press('#alertClose', 'Escape'); await page.waitForTimeout(500);

const h = await hold();
console.log('보유 줄:', h.text, `(현재가 ${h.price})`);
check('보유 줄 표시', !h.hidden);
const expPl = 10 * h.price - 10 * 200000;
const expPct = (expPl / (10 * 200000)) * 100;
const parts = h.text.match(/([\d,]+)주 평단 ([\d,]+) 평가 ([\d,]+) ([+-][\d,]+) \(([+-][\d.]+)%\)/);
check('형식이 "수량 · 평단 · 평가 · 손익(%)"', !!parts, h.text);
if (parts) {
  check('평가금액 = 수량 x 현재가', num(parts[3]) === 10 * h.price, `${num(parts[3])} vs ${10 * h.price}`);
  check('평가손익 정확', Math.abs(num(parts[4]) - expPl) < 1, `${num(parts[4])} vs ${expPl}`);
  check('수익률 정확', Math.abs(num(parts[5]) - expPct) < 0.02, `${num(parts[5])} vs ${expPct.toFixed(2)}`);
  const wantUp = expPl > 0;
  check(`손익 색상 (${wantUp ? '상승 빨강' : '하락 파랑'})`,
    h.plColor.includes(wantUp ? '226, 75, 74' : '24, 95, 165'), h.plColor);
}
await page.screenshot({ path: path.join(SHOTS, 'holdings-detail.png') });

// --- 보유 없는 종목으로 바꾸면 숨김 ---
await page.evaluate(() => document.querySelectorAll('#list .row')[1].click());
await page.waitForTimeout(2500);
check('보유 없는 종목은 숨김', (await hold()).hidden, (await hold()).name);
await page.evaluate(() => document.querySelectorAll('#list .row')[0].click());
await page.waitForTimeout(2500);
check('보유 종목으로 돌아오면 다시 표시', !(await hold()).hidden);

// --- 수량만 있고 평단가가 없으면 저장하지 않음 ---
await openPanel();
await setHold(2, 5, '');
check('평단가 없으면 저장 안 함', !disk()['069500.KS'], JSON.stringify(disk()));
await setHold(2, 0, 100);
check('수량 0이면 저장 안 함', !disk()['069500.KS'], JSON.stringify(disk()));
await page.press('#alertClose', 'Escape'); await page.waitForTimeout(400);

// --- 종목 삭제 시 보유도 정리 ---
await page.evaluate(() => document.querySelectorAll('#list .row')[0].querySelector('.del').click());
await page.waitForTimeout(2500);
check('종목 삭제 시 보유도 삭제', !disk()['005930.KS'], JSON.stringify(disk()));
check('삭제 후 보유 줄 숨김', (await hold()).hidden);

check('콘솔 에러 없음', errs.length === 0, errs.slice(0, 2).join(' / '));

// --- 재실행 후 유지 ---
await openPanel();
await setHold(1, 3, 90000);
const saved = JSON.stringify(disk());
await app.close(); await new Promise((r) => setTimeout(r, 1500));
app = await launchApp(); page = await app.firstWindow();
await waitReady(page); await page.waitForTimeout(1000);
check('재실행 후 보유 정보 유지', JSON.stringify(disk()) === saved, `${JSON.stringify(disk())} vs ${saved}`);
await app.close();

fs.writeFileSync(CFG, '{}');
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
