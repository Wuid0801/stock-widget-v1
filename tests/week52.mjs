import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// D. 52주 최저~최고 위치 표시 검증
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
const num=(s)=>Number(String(s).replace(/[^\d.-]/g,''));

const w52=()=>page.evaluate(()=>{
  const b=document.getElementById('w52');
  return { hidden:b.hidden, lo:document.getElementById('w52lo').textContent,
    hi:document.getElementById('w52hi').textContent,
    left:document.getElementById('w52mark').style.left, title:b.title,
    price:document.getElementById('dprice').textContent,
    name:document.getElementById('dname').textContent };
});

const SYMS={'삼성전자':'005930.KS','KODEX 200':'069500.KS','SK하이닉스':'000660.KS','NAVER':'035420.KS','KODEX 레버리지':'122630.KS'};
async function meta(sym){
  const j=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1y&interval=1d`,{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.json());
  return j.chart.result[0].meta;
}

for (const idx of [0,3,4]) {
  await page.evaluate((i)=>document.querySelectorAll('#list .row')[i].click(), idx);
  await page.waitForTimeout(3000);
  const u=await w52();
  const m=await meta(SYMS[u.name]);
  const lo=num(u.lo), hi=num(u.hi), price=num(u.price), pos=parseFloat(u.left);
  const expectPos=((price-m.fiftyTwoWeekLow)/(m.fiftyTwoWeekHigh-m.fiftyTwoWeekLow))*100;
  console.log(`  ${u.name}: ${u.lo} ~ ${u.hi}, 현재 ${u.price} → ${u.left}`);
  check(`${u.name} 막대 표시`, !u.hidden);
  check(`${u.name} 최저값 일치`, Math.abs(lo-m.fiftyTwoWeekLow)/m.fiftyTwoWeekLow<0.002, `${lo} vs ${m.fiftyTwoWeekLow}`);
  check(`${u.name} 최고값 일치`, Math.abs(hi-m.fiftyTwoWeekHigh)/m.fiftyTwoWeekHigh<0.002, `${hi} vs ${m.fiftyTwoWeekHigh}`);
  check(`${u.name} 마커 위치 정확`, Math.abs(pos-expectPos)<1.5, `${pos.toFixed(1)}% vs ${expectPos.toFixed(1)}%`);
  check(`${u.name} 마커가 0~100% 안에`, pos>=0 && pos<=100, `${pos}`);
  check(`${u.name} 툴팁에 저점/고점 대비`, u.title.includes('저점 대비') && u.title.includes('고점 대비'), u.title.split('\n')[1]?.slice(0,60));
}
await page.screenshot({path:path.join(SHOTS,'80-w52.png')});

// 관심종목을 모두 지우면 막대도 숨겨져야 함
for (let i=await page.evaluate(()=>document.querySelectorAll('#list .row').length); i>0; i--) {
  await page.evaluate(()=>document.querySelectorAll('#list .row')[0].querySelector('.del').click());
  await page.waitForTimeout(800);
}
check('종목 없으면 막대 숨김', (await w52()).hidden);
check('콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
await app.close();
fs.writeFileSync(CFG,'{}');
