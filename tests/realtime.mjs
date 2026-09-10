import { APP_DIR, CFG_PATH, SHOTS_DIR, FAIL_URLS_ENV, launchApp, waitReady } from './_paths.mjs';
// 실시간 시세 적용 + Naver 실패 시 Yahoo 폴백 검증
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';

const APP = APP_DIR;
const CFG = CFG_PATH;
const H={'User-Agent':'Mozilla/5.0','Referer':'https://m.stock.naver.com/'};
const launch = launchApp;
const ready = waitReady;
let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };
const num = (s) => Number(String(s).replace(/[^\d.-]/g,''));

const ui = (page) => page.evaluate(() => {
  const c = Chart.getChart(document.getElementById('chart'));
  return {
    // 실시간 / 시간외 / 장마감은 모두 네이버 실시간 소스를 쓰고 있다는 뜻이고,
    // 20분지연만 Yahoo 폴백이다. ('시간외'는 eb8bbfd 에서 추가됐다)
    badge: document.querySelector('#updated .live') ? '실시간'
         : document.querySelector('#updated .over') ? '시간외'
         : document.querySelector('#updated .closed') ? '장마감'
         : document.querySelector('#updated .delay') ? '20분지연' : '(없음)',
    updated: document.getElementById('updated').textContent,
    name: document.getElementById('dname').textContent,
    price: document.getElementById('dprice').textContent,
    tf: [...document.querySelectorAll('#tf button')].find(b=>b.classList.contains('on')).textContent,
    chartLast: c ? c.data.datasets[0].data.at(-1) : null,
    chartN: c ? c.data.datasets[0].data.length : 0,
    rows: [...document.querySelectorAll('#list .row')].map(r=>({
      name:r.querySelector('.name').textContent, px:r.querySelector('.px').textContent })),
  };
});

fs.writeFileSync(CFG,'{}');

// ============ A. 정상: 실시간 적용 ============
console.log('=== A. 실시간 정상 동작 ===');
let app = await launch(); let page = await app.firstWindow();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await ready(page); await page.waitForTimeout(1200);
const a = await ui(page);
console.log('헤더:', a.updated, '| 상세:', a.name, a.price);

// 장중이면 '실시간', 장 마감이면 '장마감'. 어느 쪽이든 Yahoo 폴백이 아니어야 한다.
check('네이버 실시간 소스 사용 중 (지연 아님)', ['실시간','시간외','장마감'].includes(a.badge), a.badge);

// 같은 시각의 Naver/Yahoo 값을 직접 받아 대조
const nv = await fetch('https://polling.finance.naver.com/api/realtime/domestic/stock/005930',{headers:H}).then(r=>r.json());
const naverPx = Number(nv.datas[0].closePriceRaw);
const yh = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/005930.KS?range=1d&interval=5m',{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.json());
const yahooPx = yh.chart.result[0].meta.regularMarketPrice;
const shown = num(a.price);
console.log(`  화면=${shown}  Naver실시간=${naverPx}  Yahoo지연=${yahooPx}`);
check('화면 가격이 Naver 실시간과 일치(±0.5%)', Math.abs(shown-naverPx)/naverPx < 0.005, `차이 ${(Math.abs(shown-naverPx)/naverPx*100).toFixed(2)}%`);
check('Yahoo 지연값보다 Naver에 가까움', Math.abs(shown-naverPx) <= Math.abs(shown-yahooPx),
  `|화면-Naver|=${Math.abs(shown-naverPx)} vs |화면-Yahoo|=${Math.abs(shown-yahooPx)}`);

// 1D 차트 끝점이 현재가와 이어지는지
check('1D 차트 끝점 = 현재가', a.tf==='1D' && Math.abs(a.chartLast-shown)/shown < 0.005,
  `차트끝=${a.chartLast} 현재가=${shown}`);

// 리스트 전 종목도 실시간인지
const nv5 = await fetch('https://polling.finance.naver.com/api/realtime/domestic/stock/005930,069500,122630,000660,035420',{headers:H}).then(r=>r.json());
const byName = Object.fromEntries(nv5.datas.map(d=>[d.stockName, Number(d.closePriceRaw)]));
let listOk = 0;
for (const r of a.rows) {
  const ref = byName[r.name]; if (!ref) continue;
  if (Math.abs(num(r.px)-ref)/ref < 0.005) listOk++;
}
check('리스트 전 종목 실시간 반영', listOk === a.rows.length, `${listOk}/${a.rows.length}`);
check('A 구간 콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));
await app.close(); await new Promise(r=>setTimeout(r,1200));

// ============ B. 폴백: Naver 차단 시 Yahoo ============
console.log('\n=== B. Naver 실패 시 Yahoo 폴백 ===');
// 예전에는 main.js 를 디스크에서 치환해 호스트를 깨뜨렸는데, 프로세스가 중간에
// 죽으면 사용자의 소스가 패치된 채로 남는다. 이제 환경변수로 그 요청만 막는다.
// 지수 조회(/index/...)는 살려둬야 하므로 종목 시세 경로만 지정한다.
console.log('  (실시간 시세 요청만 차단 — 지수 조회는 그대로 둔다)');
try {
  fs.writeFileSync(CFG,'{}');
  app = await launchApp({ [FAIL_URLS_ENV]: '/api/realtime/domestic/stock' });
  page = await app.firstWindow();
  const errs2=[]; page.on('pageerror',e=>errs2.push(e.message));
  await ready(page); await page.waitForTimeout(1500);
  const b = await ui(page);
  console.log('헤더:', b.updated, '| 상세:', b.name, b.price);

  check('지연 배지로 전환', b.badge === '20분지연', b.badge);
  const shown2 = num(b.price);
  const yh2 = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/005930.KS?range=1y&interval=1d',{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.json());
  const yahooPx2 = yh2.chart.result[0].meta.regularMarketPrice;
  console.log(`  화면=${shown2}  Yahoo=${yahooPx2}`);
  check('Yahoo 값으로 정상 표시', Math.abs(shown2-yahooPx2)/yahooPx2 < 0.005, `차이 ${(Math.abs(shown2-yahooPx2)/yahooPx2*100).toFixed(2)}%`);
  check('폴백에서도 가격이 비어있지 않음', b.price !== '—' && shown2 > 0);
  check('폴백에서도 차트 정상', b.chartN > 0, `${b.chartN}포인트`);
  check('폴백에서 리스트 전 종목 표시', b.rows.every(r=>r.px !== '—' && r.px !== ''), b.rows.map(r=>r.px).join(','));
  check('B 구간 콘솔 에러 없음', errs2.length===0, errs2.slice(0,2).join(' / '));
  await app.close();
} finally {
  fs.writeFileSync(CFG,'{}');
}

console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
