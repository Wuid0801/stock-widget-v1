import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// B. 이동평균선(5/20일) 검증
//
// 데이터셋의 위치·개수로 찾지 않는다. 예전에는 sets.length 가 1(1D) / 3(1M·1Y)
// 이고 sets[1].label === '5일' 이라고 기대했는데, 그 뒤에 고저 밴드·거래량·
// 추세선이 붙어 개수가 4 / 6~8 로 늘고 label 도 아예 없어졌다(Chart.js 내장
// 범례를 끄고 #maLegend 를 직접 그리는 방식으로 바뀜). 그래서 이 스위트는
// 오랫동안 실패 상태였다.
//
// 이제 앱의 모델(lastChart.mas)로 이동평균을 식별하고, 그 배열이 차트에 실제로
// 들어갔는지는 같은 참조를 찾아 확인한다. 데이터셋이 더 붙어도 깨지지 않는다.
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const CFG = CFG_PATH;
const SHOTS = SHOTS_DIR;
fs.writeFileSync(CFG,'{}');
const app=await launchApp();
const page=await app.firstWindow();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await waitReady(page);
await page.waitForTimeout(1500);

let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };
const clickTf=(t)=>page.evaluate((x)=>[...document.querySelectorAll('#tf button')].find(b=>b.textContent===x).click(),t);

const snap=()=>page.evaluate(()=>{
  const c=Chart.getChart(document.getElementById('chart'));
  const mas=(typeof lastChart!=='undefined' && lastChart && lastChart.mas) || [];
  return {
    total:c.data.datasets.length,
    mas:mas.map(m=>({ p:m.p, n:m.data.length, nonNull:m.data.filter(v=>v!=null).length, last:m.data.at(-1) })),
    // 모델의 배열이 차트 데이터셋에 그대로 들어갔는지 (참조 비교라 위치와 무관)
    drawn:mas.every(m=>c.data.datasets.some(d=>d.data===m.data)),
    // 화면 범례. 각 span 의 title 이 "N일 이동평균" 이다
    legend:[...document.querySelectorAll('#maLegend span')].map(s=>s.title),
    legendHidden:document.getElementById('maLegend').hidden,
  };
});
const ma=(s,p)=>s.mas.find(m=>m.p===p);

// 독립 계산용 일봉
const daily = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/005930.KS?range=1y&interval=1d',{headers:{'User-Agent':'Mozilla/5.0'}})
  .then(r=>r.json()).then(j=>j.chart.result[0].indicators.quote[0].close.filter(x=>x!=null));
const smaRef=(a,p)=>{ const o=[]; for(let i=p-1;i<a.length;i++) o.push(a.slice(i-p+1,i+1).reduce((s,v)=>s+v,0)/p); return o; };

// 1D / 1W 는 분봉이라 "5일선" 이 이름과 안 맞으므로 그리지 않는다
for (const tf of ['1D','1W']) {
  await clickTf(tf); await page.waitForTimeout(3000);
  const s=await snap();
  console.log(`  ${tf}: 데이터셋 ${s.total}개, 이동평균 ${s.mas.length}개`);
  check(`${tf} 에는 이동평균선 없음`, s.mas.length===0, `${s.mas.length}개`);
  check(`${tf} 범례 숨김`, s.legendHidden, `범례 ${JSON.stringify(s.legend)}`);
}

// 1M / 1Y 에는 5일선·20일선이 있어야 함
for (const tf of ['1M','1Y']) {
  await clickTf(tf); await page.waitForTimeout(3200);
  const s=await snap();
  console.log(`  ${tf}: 데이터셋 ${s.total}개, 이동평균 ${JSON.stringify(s.mas.map(m=>({p:m.p,n:m.n,nn:m.nonNull})))}`);
  const m5=ma(s,5), m20=ma(s,20);
  check(`${tf} 5일선·20일선 존재`, !!m5 && !!m20, s.mas.map(m=>m.p).join(','));
  check(`${tf} 두 선이 차트에 실제로 들어감`, s.drawn);
  check(`${tf} 범례에 두 기간이 뜸`,
    s.legend.includes('5일 이동평균') && s.legend.includes('20일 이동평균'), JSON.stringify(s.legend));
  if (!m5 || !m20) continue;
  // 20일선이 차트 전 구간에 채워져야 한다 (1M 은 23봉뿐이라 자체계산이면 4개만 나옴)
  const cover = m20.nonNull / m20.n;
  check(`${tf} 20일선이 구간 전체를 덮음`, cover > 0.9, `${m20.nonNull}/${m20.n} (${(cover*100).toFixed(0)}%)`);
  // 마지막 값이 독립 계산과 일치
  const ref5=smaRef(daily,5).at(-1), ref20=smaRef(daily,20).at(-1);
  check(`${tf} 5일선 값 정확`, Math.abs(m5.last-ref5)/ref5 < 0.005, `${Math.round(m5.last)} vs ${Math.round(ref5)}`);
  check(`${tf} 20일선 값 정확`, Math.abs(m20.last-ref20)/ref20 < 0.005, `${Math.round(m20.last)} vs ${Math.round(ref20)}`);
}
await page.screenshot({path:path.join(SHOTS,'70-ma.png')});

// 종목 바꿔도 유지
await page.evaluate(()=>document.querySelectorAll('#list .row')[3].click());
await page.waitForTimeout(3200);
const s2=await snap();
check('종목 변경 후에도 이동평균선 유지', !!ma(s2,5) && !!ma(s2,20), s2.mas.map(m=>m.p).join(','));

check('콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
await app.close();
fs.writeFileSync(CFG,'{}');
