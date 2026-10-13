// C. 보유 수량 / 평단가 → 평가손익 검증
// 보유는 상세 화면에서 넣고(＋ 보유 입력 · ✎), 설정에서는 들고 있는 종목만 고치고 지운다.
// 목록 줄에는 "N주 · 손익 %" 가 붙고, 합계 줄은 보유가 둘 이상이면 합계 → 종목마다 넘어간다.
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

// 기본 관심종목: 005930.KS 삼성전자 · 069500.KS KODEX 200 · …
const disk = () => JSON.parse(fs.readFileSync(CFG, 'utf8')).holdings || {};
const hold = () => page.evaluate(() => {
  const el = document.getElementById('hold');
  return {
    hidden: el.hidden,
    text: el.innerText.replace(/\s+/g, ' ').trim(),
    msg: el.querySelector('.hmsg') ? el.querySelector('.hmsg').textContent : '',
    plColor: el.querySelector('.hpl') ? el.querySelector('.hpl').style.color : null,
    name: document.getElementById('dname').textContent,
    price: Number(document.getElementById('dprice').textContent.replace(/[^\d.-]/g, '')),
  };
});
const folioText = () => page.evaluate(() => {
  const el = document.getElementById('folio');
  return el.hidden ? null : el.innerText.replace(/\s+/g, ' ').trim();
});
const openPanel = async () => { await page.click('#bell'); await page.waitForTimeout(500); };
const closePanel = async () => { await page.press('#alertClose', 'Escape'); await page.waitForTimeout(500); };
const selectRow = async (n) => {
  await page.evaluate((i) => document.querySelectorAll('#list .row')[i].click(), n);
  await page.waitForTimeout(2500);
};
// 상세에서: ＋ 보유 입력(또는 ✎) → 칸 둘 → key(Enter 저장 · Escape 취소)
const holdViaDetail = async (qty, avg, key = 'Enter') => {
  await page.click('#hold [data-act="edit"]');
  await page.fill('#hold .hq', String(qty));
  await page.fill('#hold .ha', String(avg));
  await page.press('#hold .ha', key);
  await page.waitForTimeout(500);
};

// --- 기본 상태 ---
let h = await hold();
check('입력 전에는 보유 자리에 "＋ 보유 입력"', !h.hidden && h.text === '＋ 보유 입력', h.text);
await openPanel();
const ui = await page.evaluate(() => ({
  // 섹션 제목만 뽑는다. 안에 설명(.sechint)·토글·세그먼트 버튼이 같이 들어 있어
  // textContent 를 통째로 쓰면 "보유 종목 수량 · 평단가" 처럼 딸려 나온다.
  sections: [...document.querySelectorAll('#alertList .sect')].map((e) => {
    const c = e.cloneNode(true);
    c.querySelectorAll('.sechint, .seg, .toggle').forEach((x) => x.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  }),
  holdRows: document.querySelectorAll('#holdRows .arow').length,
  empty: document.querySelector('#holdRows .empty')?.textContent || '',
}));
console.log('설정 패널:', JSON.stringify(ui));
// 개수를 고정하지 않는다. 테마·이동평균선 섹션이 나중에 붙으면서 2개 기대가
// 깨졌고, 이 스위트가 확인해야 하는 것은 자기가 쓰는 두 섹션의 존재다.
check('설정 패널에 목표가 알림·보유 종목 섹션',
  ui.sections.includes('목표가 알림') && ui.sections.includes('보유 종목'), ui.sections.join(' / '));
check('보유가 없으면 설정에는 줄 대신 넣는 곳 안내', ui.holdRows === 0 && ui.empty.includes('＋ 보유 입력'),
  `${ui.holdRows}행 · ${ui.empty}`);
await closePanel();

// --- 상세에서 입력 → 저장 → 평가손익 ---
await page.click('#hold [data-act="edit"]');
await page.fill('#hold .hq', '10');
await page.press('#hold .hq', 'Enter');
await page.waitForTimeout(300);
h = await hold();
check('평단가가 없으면 저장하지 않고 알린다', !disk()['005930.KS'] && h.msg.includes('수량과 평단가를 모두'), h.msg);
await page.fill('#hold .ha', '200,000');
await page.press('#hold .ha', 'Enter');
await page.waitForTimeout(500);
check('쉼표를 넣어도 디스크에 저장', disk()['005930.KS']?.qty === 10 && disk()['005930.KS']?.avg === 200000,
  JSON.stringify(disk()));

h = await hold();
console.log('보유 줄:', h.text, `(현재가 ${h.price})`);
const expPl = 10 * h.price - 10 * 200000;
const expPct = (expPl / (10 * 200000)) * 100;
// 칸 사이 간격은 flex 로 주고 마크업에는 공백이 없다. innerText 에 공백이
// 없는 것이 정상이므로 구분 공백을 강제하지 않는다.
const parts = h.text.match(/([\d,]+)주\s*평단\s*([\d,]+)\s*평가\s*([\d,]+)\s*([+-][\d,]+)\s*\(([+-][\d.]+)%\)\s*✎/);
check('형식이 "수량 · 평단 · 평가 · 손익(%) · ✎"', !!parts, h.text);
if (parts) {
  check('평가금액 = 수량 x 현재가', num(parts[3]) === 10 * h.price, `${num(parts[3])} vs ${10 * h.price}`);
  check('평가손익 정확', Math.abs(num(parts[4]) - expPl) < 1, `${num(parts[4])} vs ${expPl}`);
  check('수익률 정확', Math.abs(num(parts[5]) - expPct) < 0.02, `${num(parts[5])} vs ${expPct.toFixed(2)}`);
  const wantUp = expPl > 0;
  check(`손익 색상 (${wantUp ? '상승 빨강' : '하락 파랑'})`,
    h.plColor.includes(wantUp ? '226, 75, 74' : '24, 95, 165'), h.plColor);
}
const subs = await page.evaluate(() => [...document.querySelectorAll('#list .row .hsub')].map((e) => e.textContent));
check('목록에서 보유 종목만 "N주 · 손익 %" 가 붙는다', subs.length === 1 && /^10주 · 손익 [+-][\d.]+%$/.test(subs[0]),
  JSON.stringify(subs));
const names = await page.evaluate(() => [...document.querySelectorAll('#list .row .name')].map((e) => e.textContent));
check('종목명 칸에는 이름만 남는다', names[0] === '삼성전자', JSON.stringify(names));
let f = await folioText();
check('보유가 하나면 합계 줄은 그 종목 줄', !!f && f.includes('삼성전자 10주') && f.includes('평가') && f.includes('손익'), f);
await page.screenshot({ path: path.join(SHOTS, 'holdings-detail.png') });

// --- 보유 없는 종목은 "＋ 보유 입력" ---
await selectRow(1);
h = await hold();
check('보유 없는 종목은 "＋ 보유 입력"', !h.hidden && h.text === '＋ 보유 입력', `${h.name}: ${h.text}`);

// --- 둘째 보유 → 합계 줄이 합계부터 종목마다 넘어간다 ---
await holdViaDetail(3, '30000');
check('둘째 종목도 저장', disk()['069500.KS']?.qty === 3 && disk()['069500.KS']?.avg === 30000, JSON.stringify(disk()));
// 어느 줄인지만 본다(평가 앞 글자) — 장중에는 30초 갱신으로 숫자가 바뀐다. 4초마다 넘어가므로
// 한 시점을 찍으면 타이머와 경주한다 — 13초 동안 1초마다 보고 세 줄이 다 나왔는지 센다.
const head = (s) => (s ? s.split('평가')[0].trim() : s);
const seen = new Set();
for (let i = 0; i < 13; i++) { seen.add(head(await folioText())); await page.waitForTimeout(1000); }
check('합계 줄이 합계 → 종목마다 넘어간다', seen.has('보유 2종목') && seen.has('삼성전자 10주') && seen.has('KODEX 200 3주'),
  [...seen].join(' / '));
f = await folioText();
check('합계 줄에 평가 · 손익 이름표', !!f && f.includes('평가') && f.includes('손익'), f);
await page.hover('#folio');
const paused = head(await folioText());
await page.waitForTimeout(4500);
check('마우스를 올리면 멈춘다', head(await folioText()) === paused, `${paused} → ${head(await folioText())}`);
const tip = await page.evaluate(() => document.getElementById('folio').title);
check('툴팁에 합계와 종목별 줄이 다 있다', tip.split('\n')[0].startsWith('보유 2종목 · 평가')
  && tip.includes('삼성전자 10주') && tip.includes('KODEX 200 3주'), tip);
await page.mouse.move(0, 0);

// --- 고치기: Esc 는 그대로 두고, 잘못 넣으면 지우지 않는다 ---
await holdViaDetail(999, '30000', 'Escape');
check('Esc 는 저장하지 않는다', disk()['069500.KS']?.qty === 3, JSON.stringify(disk()));
check('Esc 뒤에는 보유 줄로 돌아온다', /^3주/.test((await hold()).text), (await hold()).text);
await holdViaDetail(0, '30000');
h = await hold();
check('수량 0이면 저장하지 않고 알린다 (예전처럼 지우지도 않는다)',
  disk()['069500.KS']?.qty === 3 && h.msg.includes('수량과 평단가를 모두'), `${JSON.stringify(disk())} ${h.msg}`);
await page.press('#hold .hq', 'Escape');
await page.waitForTimeout(300);

// --- 설정: 들고 있는 종목만, 고치기 · 지우기 ---
await openPanel();
const rows = () => page.evaluate(() => [...document.querySelectorAll('#holdRows .arow')].map((r) => ({
  name: r.querySelector('.aname').textContent, qty: r.querySelector('.qty').value, avg: r.querySelector('.avg').value,
})));
let r = await rows();
check('설정에는 보유 종목만 쉼표와 함께', r.length === 2 && r[0].qty === '10' && r[0].avg === '200,000' && r[1].avg === '30,000',
  JSON.stringify(r));
await page.screenshot({ path: path.join(SHOTS, 'holdings-panel.png') });
await page.fill('#holdRows .arow:nth-child(1) input.avg', '210,000');
await page.evaluate(() => document.querySelector('#holdRows .arow:nth-child(1) input.avg').blur());
await page.waitForTimeout(400);
check('설정에서 평단가 고치기', disk()['005930.KS']?.avg === 210000, JSON.stringify(disk()));
await page.fill('#holdRows .arow:nth-child(1) input.qty', '');
await page.evaluate(() => document.querySelector('#holdRows .arow:nth-child(1) input.qty').blur());
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  qty: document.querySelector('#holdRows .arow:nth-child(1) input.qty').value,
  msg: document.querySelector('#holdRows .ohint')?.textContent || '',
}));
check('설정에서 칸을 비우면 지우지 않고 되돌린 뒤 알린다',
  disk()['005930.KS']?.qty === 10 && after.qty === '10' && after.msg.includes('수량과 평단가를 모두'), JSON.stringify(after));
await page.click('#holdRows .arow:nth-child(2) .hdel');
await page.waitForTimeout(400);
r = await rows();
check('✕ 로 보유 지우기', !disk()['069500.KS'] && r.length === 1, `${JSON.stringify(disk())} ${r.length}행`);
await closePanel();

// --- 종목 삭제 시 보유도 정리 ---
await page.evaluate(() => document.querySelectorAll('#list .row')[0].querySelector('.del').click());
await page.waitForTimeout(2500);
check('종목 삭제 시 보유도 삭제', !disk()['005930.KS'], JSON.stringify(disk()));
check('삭제 후 합계 줄 숨김', (await folioText()) === null);

check('콘솔 에러 없음', errs.length === 0, errs.slice(0, 2).join(' / '));

// --- 재실행 후 유지 ---
await holdViaDetail(3, '90,000');
const saved = JSON.stringify(disk());
await app.close(); await new Promise((r) => setTimeout(r, 1500));
app = await launchApp(); page = await app.firstWindow();
await waitReady(page); await page.waitForTimeout(1000);
check('재실행 후 보유 정보 유지', saved !== '{}' && JSON.stringify(disk()) === saved, `${JSON.stringify(disk())} vs ${saved}`);
await app.close();

fs.writeFileSync(CFG, '{}');
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
