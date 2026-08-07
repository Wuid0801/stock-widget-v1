import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// ② 목표가 알림 검증 (선택 기능 / 통과 시 1회 / 재무장)
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const RENDERER=path.join(APP,'renderer.js');
const CFG = CFG_PATH;
const SHOTS = SHOTS_DIR;
const launch = launchApp;
const ready = waitReady;
let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };

// 통과 판정을 결정적으로 시험하기 위한 임시 훅 (검증 후 원복)
const orig=fs.readFileSync(RENDERER,'utf8');
const HOOK = `
window.__t = {
  setEnabled: (v) => { state.alerts.enabled = v; },
  setTarget: (s, t) => { state.alerts.targets[s] = t; },
  setMarketOpen: (v) => { marketOpen = v; },
  setQuote: (s, price) => { quotes[s] = { price }; },
  check: (prev) => checkAlerts(prev),
};
`;
fs.writeFileSync(RENDERER, orig + HOOK);

try {
  fs.writeFileSync(CFG,'{}');
  const app=await launch(); const page=await app.firstWindow();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await ready(page); await page.waitForTimeout(1500);

  // 알림 IPC를 메인에서 가로채 실제 전달 여부를 기록
  await app.evaluate(({ipcMain})=>{ global.__notes=[]; ipcMain.removeAllListeners('notify');
    ipcMain.on('notify',(_e,p)=>global.__notes.push(p)); });
  const notes=()=>app.evaluate(()=>global.__notes);
  const clear=()=>app.evaluate(()=>{ global.__notes=[]; });
  const disk=()=>JSON.parse(fs.readFileSync(CFG,'utf8')).alerts;

  // --- UI / 기본값 ---
  console.log('=== 설정 UI ===');
  await page.click('#bell'); await page.waitForTimeout(500);
  const ui0=await page.evaluate(()=>({
    open:!document.getElementById('alerts').hidden,
    checked:document.getElementById('alertOn').checked,
    off:document.getElementById('alerts').classList.contains('off'),
    hint:document.getElementById('alertHint').textContent,
    rows:document.querySelectorAll('#alertRows .arow').length,
    searchClosed:document.getElementById('search').hidden,
  }));
  check('알림 패널 열림', ui0.open);
  check('기본값은 꺼짐 (선택 기능)', ui0.checked===false && ui0.off, `checked=${ui0.checked}`);
  check('꺼짐 안내 문구 표시', ui0.hint.includes('꺼져'), ui0.hint);
  check('관심종목 수만큼 입력행', ui0.rows===5, `${ui0.rows}행`);
  check('검색 패널과 동시에 열리지 않음', ui0.searchClosed);
  await page.screenshot({path:path.join(SHOTS,'90-alerts-off.png')});

  // --- 켜기 + 목표가 입력 → 저장 ---
  await page.click('#alertOn'); await page.waitForTimeout(600);
  check('켜면 disk 에 반영', disk().enabled===true, JSON.stringify(disk()));
  check('켜짐 안내 문구로 변경', (await page.evaluate(()=>document.getElementById('alertHint').textContent)).includes('장중'));

  await page.fill('#alertRows .arow:nth-child(1) input.up','300000');
  await page.evaluate(()=>document.querySelector('#alertRows .arow:nth-child(1) input.up').blur());
  await page.fill('#alertRows .arow:nth-child(1) input.dn','200000');
  await page.evaluate(()=>document.querySelector('#alertRows .arow:nth-child(1) input.dn').blur());
  await page.waitForTimeout(600);
  const d1=disk();
  console.log('  저장된 목표가:', JSON.stringify(d1.targets));
  check('상한/하한 저장', d1.targets['005930.KS']?.up===300000 && d1.targets['005930.KS']?.down===200000, JSON.stringify(d1.targets));
  await page.screenshot({path:path.join(SHOTS,'91-alerts-on.png')});
  await page.press('#alertOn','Escape'); await page.waitForTimeout(400);
  check('Esc 로 닫힘', await page.evaluate(()=>document.getElementById('alerts').hidden));

  // --- 통과 판정 ---
  console.log('\n=== 통과 판정 ===');
  const S='005930.KS';
  const scenario = async (tag, {enabled, open, prev, now, target}, expectCount, expectText) => {
    await clear();
    await page.evaluate(([s,en,op,tg,pr])=>{
      window.__t.setEnabled(en); window.__t.setMarketOpen(op);
      window.__t.setTarget(s,tg); window.__t.setQuote(s,pr);
    },[S,enabled,open,target,now]);
    await page.evaluate(([s,p])=>window.__t.check(p===null?{}:{[s]:p}), [S,prev]);
    await page.waitForTimeout(300);
    const n=await notes();
    const ok = n.length===expectCount && (!expectText || (n[0]&&n[0].title.includes(expectText)));
    if(!ok) fails++;
    console.log(`${ok?'OK  ':'FAIL'} ${tag} → ${n.length}건 ${n.map(x=>x.title+' / '+x.body).join(' | ')}`);
  };

  await scenario('꺼져 있으면 통과해도 안 울림', {enabled:false,open:true,prev:290000,now:310000,target:{up:300000}}, 0);
  await scenario('장 마감이면 안 울림',        {enabled:true,open:false,prev:290000,now:310000,target:{up:300000}}, 0);
  await scenario('첫 갱신(이전 가격 없음)은 안 울림', {enabled:true,open:true,prev:null,now:310000,target:{up:300000}}, 0);
  await scenario('상한 통과 → 1회 알림',       {enabled:true,open:true,prev:290000,now:310000,target:{up:300000}}, 1, '상한 도달');
  await scenario('이미 넘어선 상태 유지 → 안 울림', {enabled:true,open:true,prev:310000,now:320000,target:{up:300000}}, 0);
  await scenario('내려왔다가 재통과 → 다시 알림', {enabled:true,open:true,prev:295000,now:305000,target:{up:300000}}, 1, '상한 도달');
  await scenario('하한 통과 → 알림',           {enabled:true,open:true,prev:210000,now:190000,target:{down:200000}}, 1, '하한 도달');
  await scenario('하한 아래 유지 → 안 울림',    {enabled:true,open:true,prev:190000,now:185000,target:{down:200000}}, 0);
  await scenario('목표가 미설정이면 안 울림',    {enabled:true,open:true,prev:100000,now:400000,target:{}}, 0);

  check('전 구간 콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));

  // --- 종목 삭제 시 목표가도 정리 ---
  await page.evaluate(()=>document.querySelectorAll('#list .row')[0].querySelector('.del').click());
  await page.waitForTimeout(2500);
  check('종목 삭제 시 목표가도 삭제', !disk().targets['005930.KS'], JSON.stringify(disk().targets));

  // --- 재실행 후 설정 유지 ---
  await app.close(); await new Promise(r=>setTimeout(r,1500));
  const app2=await launch(); const page2=await app2.firstWindow();
  await ready(page2); await page2.waitForTimeout(800);
  await page2.click('#bell'); await page2.waitForTimeout(500);
  check('재실행 후 알림 켜짐 유지', await page2.evaluate(()=>document.getElementById('alertOn').checked));
  await app2.close();
} finally {
  fs.writeFileSync(RENDERER, orig);
  console.log('\n  (renderer.js 원복)');
}
check('renderer.js 원복 확인', fs.readFileSync(RENDERER,'utf8')===orig);
fs.writeFileSync(CFG,'{}');
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
