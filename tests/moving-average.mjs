import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// B. 이동평균선(5/20일) 검증
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const CFG = CFG_PATH;
const SHOTS = SHOTS_DIR;
fs.writeFileSync(CFG,'{}');
const app=await launchApp();
const page=await app.firstWindow();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.waitForFunction(()=>/\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),{timeout:60000});
await page.waitForTimeout(1500);

let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };
const clickTf=(t)=>page.evaluate((x)=>[...document.querySelectorAll('#tf button')].find(b=>b.textContent===x).click(),t);

const ds=()=>page.evaluate(()=>{
  const c=Chart.getChart(document.getElementById('chart'));
  return { sets:c.data.datasets.map(d=>({label:d.label, n:d.data.length, nonNull:d.data.filter(v=>v!=null).length,
             color:d.borderColor, last:d.data.at(-1)})),
           legend:c.options.plugins.legend.display };
});

// 독립 계산용 일봉
const daily = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/005930.KS?range=1y&interval=1d',{headers:{'User-Agent':'Mozilla/5.0'}})
  .then(r=>r.json()).then(j=>j.chart.result[0].indicators.quote[0].close.filter(x=>x!=null));
const smaRef=(a,p)=>{ const o=[]; for(let i=p-1;i<a.length;i++) o.push(a.slice(i-p+1,i+1).reduce((s,v)=>s+v,0)/p); return o; };

// 1D / 1W 에는 없어야 함
for (const tf of ['1D','1W']) {
  await clickTf(tf); await page.waitForTimeout(3000);
  const d=await ds();
  check(`${tf} 에는 이동평균선 없음`, d.sets.length===1 && !d.legend, `${d.sets.length}개 데이터셋`);
}

// 1M / 1Y 에는 5일선·20일선이 있어야 함
for (const tf of ['1M','1Y']) {
  await clickTf(tf); await page.waitForTimeout(3200);
  const d=await ds();
  console.log(`  ${tf}:`, JSON.stringify(d.sets.map(s=>({l:s.label,n:s.n,nn:s.nonNull}))));
  check(`${tf} 5일선·20일선 존재`, d.sets.length===3 && d.sets[1].label==='5일' && d.sets[2].label==='20일',
    d.sets.map(s=>s.label).join(','));
  check(`${tf} 범례 표시`, d.legend);
  // 20일선이 차트 전 구간에 채워져야 한다 (1M 은 23봉뿐이라 자체계산이면 4개만 나옴)
  const cover = d.sets[2].nonNull / d.sets[2].n;
  check(`${tf} 20일선이 구간 전체를 덮음`, cover > 0.9, `${d.sets[2].nonNull}/${d.sets[2].n} (${(cover*100).toFixed(0)}%)`);
  // 마지막 값이 독립 계산과 일치
  const ref5=smaRef(daily,5).at(-1), ref20=smaRef(daily,20).at(-1);
  check(`${tf} 5일선 값 정확`, Math.abs(d.sets[1].last-ref5)/ref5 < 0.005, `${Math.round(d.sets[1].last)} vs ${Math.round(ref5)}`);
  check(`${tf} 20일선 값 정확`, Math.abs(d.sets[2].last-ref20)/ref20 < 0.005, `${Math.round(d.sets[2].last)} vs ${Math.round(ref20)}`);
}
await page.screenshot({path:path.join(SHOTS,'70-ma.png')});

// 종목 바꿔도 유지
await page.evaluate(()=>document.querySelectorAll('#list .row')[3].click());
await page.waitForTimeout(3200);
const d2=await ds();
check('종목 변경 후에도 이동평균선 유지', d2.sets.length===3, `${d2.sets.length}개`);

check('콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
await app.close();
fs.writeFileSync(CFG,'{}');
