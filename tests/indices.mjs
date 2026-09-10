import { APP_DIR, CFG_PATH, SHOTS_DIR, FAIL_URLS_ENV, launchApp, waitReady } from './_paths.mjs';
// A. 코스피/코스닥 지수 표시 검증
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const CFG = CFG_PATH;
const SHOTS = SHOTS_DIR;
const H={'User-Agent':'Mozilla/5.0','Referer':'https://m.stock.naver.com/'};
const launch = launchApp;
const ready = waitReady;
let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };
const num=(s)=>Number(String(s).replace(/[^\d.-]/g,''));

fs.writeFileSync(CFG,'{}');
let app=await launch(); let page=await app.firstWindow();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await ready(page); await page.waitForTimeout(1500);

const ix=()=>page.evaluate(()=>{
  const b=document.getElementById('indices');
  return { hidden:b.hidden, h:b.offsetHeight,
    items:[...b.querySelectorAll('.ix')].map(e=>({
      name:e.querySelector('.ixn').textContent,
      value:e.querySelector('.ixv').textContent,
      pct:e.querySelector('.ixp').textContent,
      color:e.querySelector('.ixp').style.color })) };
});

const u=await ix();
console.log('지수 줄:', JSON.stringify(u.items));
check('지수 줄 표시됨', !u.hidden && u.items.length===2, `${u.items.length}개`);
check('코스피/코스닥 이름', u.items[0]?.name==='코스피' && u.items[1]?.name==='코스닥');

// 같은 시각의 네이버 값과 대조
const ref=await fetch('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ',{headers:H}).then(r=>r.json());
const refv=ref.datas.map(d=>Number(String(d.closePriceRaw??d.closePrice).replace(/,/g,'')));
for (let i=0;i<2;i++){
  const shown=num(u.items[i].value);
  console.log(`  ${u.items[i].name}: 화면 ${shown} vs 네이버 ${refv[i]}`);
  check(`${u.items[i].name} 값 일치(±0.3%)`, Math.abs(shown-refv[i])/refv[i]<0.003, `${shown} vs ${refv[i]}`);
}
// 등락 색상
for (const it of u.items){
  const up=it.pct.startsWith('+');
  check(`${it.name} 색상 (${up?'상승 빨강':'하락 파랑'})`, it.color.includes(up?'226, 75, 74':'24, 95, 165'), it.color);
}
await page.screenshot({path:path.join(SHOTS,'60-indices.png')});

// 접어도 지수는 보이고 높이에 반영되는지
await page.click('#dock'); await page.waitForTimeout(1200);
const c=await page.evaluate(()=>{
  const b=document.getElementById('indices'), bar=document.querySelector('.bar'), row=document.querySelector('#list .row');
  return { ixVisible:!b.hidden, ixH:b.offsetHeight, barH:bar.offsetHeight, rowH:row.offsetHeight,
           listH:document.getElementById('list').clientHeight };
});
const b1=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
console.log(`  접힘: 창높이 ${b1.height} = 바 ${c.barH} + 지수 ${c.ixH} + 3행 ${c.rowH*3} + 2`);
check('접어도 지수 줄 유지', c.ixVisible);
check('접힌 높이에 지수 줄 반영', Math.abs(b1.height-(c.barH+c.ixH+c.rowH*3+2))<=2, `${b1.height} vs ${c.barH+c.ixH+c.rowH*3+2}`);
check('접힌 상태에서도 정확히 3행', Math.floor(c.listH/c.rowH)===3, `${c.listH}/${c.rowH}`);
await page.screenshot({path:path.join(SHOTS,'61-indices-docked.png')});
await page.click('#dock'); await page.waitForTimeout(1200);
check('A 콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));
await app.close(); await new Promise(r=>setTimeout(r,1200));

// 지수 조회 실패 시 조용히 숨기고 나머지는 정상 동작해야 함.
// 예전에는 main.js 를 디스크에서 치환해 URL 을 깨뜨렸는데, 프로세스가 중간에
// 죽으면 사용자의 소스가 패치된 채로 남는다. 이제 환경변수로 그 요청만 막는다.
console.log('\n--- 지수 API 실패 강제 ---');
try {
  fs.writeFileSync(CFG,'{}');
  app=await launchApp({ [FAIL_URLS_ENV]: '/api/realtime/domestic/index' });
  page=await app.firstWindow();
  const e2=[]; page.on('pageerror',e=>e2.push(e.message));
  await ready(page); await page.waitForTimeout(1500);
  const u2=await ix();
  check('지수 실패 시 줄 숨김', u2.hidden, `hidden=${u2.hidden}`);
  check('지수 실패해도 종목 시세 정상', await page.evaluate(()=>document.getElementById('dprice').textContent)!=='—');
  check('지수 실패해도 차트 정상', await page.evaluate(()=>{const c=Chart.getChart(document.getElementById('chart'));return c?c.data.datasets[0].data.length:0;})>0);
  check('지수 실패 시 콘솔 에러 없음', e2.length===0, e2.slice(0,2).join(' / '));
  await app.close();
} finally { fs.writeFileSync(CFG,'{}'); }

fs.writeFileSync(CFG,'{}');
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
