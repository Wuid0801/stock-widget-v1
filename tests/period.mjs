import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// ⑤ 타임프레임별 기간 수익률 배지 검증
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const CFG = CFG_PATH;
const SHOTS = SHOTS_DIR;
const TF={'1D':['1d','5m'],'1W':['5d','30m'],'1M':['1mo','1d'],'1Y':['1y','1d']};
fs.writeFileSync(CFG,'{}');
const app = await launchApp();
const page = await app.firstWindow();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.waitForFunction(()=>/\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),{timeout:60000});
await page.waitForTimeout(1200);

let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };

const ui = () => page.evaluate(()=>{
  const p=document.getElementById('period');
  const meta=document.querySelector('.meta');
  return {
    tf:[...document.querySelectorAll('#tf button')].find(b=>b.classList.contains('on')).textContent,
    hidden:p.hidden, text:p.textContent, color:p.style.color,
    price:Number(document.getElementById('dprice').textContent.replace(/[^\d.-]/g,'')),
    // 340px 폭에서 메타 행이 넘치지 않는지
    overflow: meta.scrollWidth > meta.clientWidth + 1,
    metaW: meta.clientWidth, metaScrollW: meta.scrollWidth,
  };
});
const clickTf = (t)=>page.evaluate((x)=>[...document.querySelectorAll('#tf button')].find(b=>b.textContent===x).click(), t);

async function refSeries(sym, tf) {
  const [range,interval]=TF[tf];
  const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}`,{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.json());
  return r.chart.result[0].indicators.quote[0].close.filter(x=>x!=null);
}

// 1D 에서는 숨겨져야 함 (위의 일간 등락과 중복)
const d = await ui();
check('1D 에서는 기간 배지 숨김', d.tf==='1D' && d.hidden, `${d.tf} hidden=${d.hidden}`);

for (const tf of ['1W','1M','1Y']) {
  await clickTf(tf);
  await page.waitForTimeout(3000);
  const u = await ui();
  const ref = await refSeries('005930.KS', tf);
  const expected = ((u.price - ref[0]) / ref[0]) * 100;
  // "1W -3.52%" → 앞의 타임프레임 라벨을 떼고 숫자만
  const shown = Number(u.text.split(/\s+/)[1].replace('%',''));
  console.log(`  ${tf}: "${u.text}"  (첫 종가 ${ref[0]} → 현재 ${u.price} = ${expected.toFixed(2)}%)`);
  check(`${tf} 배지 표시`, !u.hidden && u.text.startsWith(tf), u.text);
  check(`${tf} 수익률 계산 정확`, Math.abs(shown-expected) < 0.15, `표시 ${shown} vs 계산 ${expected.toFixed(2)}`);
  const wantUp = expected > 0;
  check(`${tf} 등락 색상 (${wantUp?'상승 빨강':'하락 파랑'})`,
    u.color.includes(wantUp ? '226, 75, 74' : '24, 95, 165'), u.color);
  check(`${tf} 메타 행 넘침 없음 (340px)`, !u.overflow, `${u.metaScrollW} / ${u.metaW}`);
}
await page.screenshot({ path: path.join(SHOTS,'50-period.png') });

// 다시 1D 로 돌아오면 숨겨져야 함
await clickTf('1D'); await page.waitForTimeout(2500);
check('1D 복귀 시 다시 숨김', (await ui()).hidden);

check('콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
await app.close();
fs.writeFileSync(CFG,'{}');
