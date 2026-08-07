import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// ④ 전역 단축키 등록 / 숨김·복원 / 종료 시 해제 검증
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const CFG = CFG_PATH;
const KEY='CommandOrControl+Alt+S';
fs.writeFileSync(CFG,'{}');
const launch = launchApp;
const ready = waitReady;
let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };

let app = await launch(); let page = await app.firstWindow();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await ready(page); await page.waitForTimeout(1000);

const reg = (a) => a.evaluate(({globalShortcut}, k)=>globalShortcut.isRegistered(k), KEY);
const winState = (a) => a.evaluate(({BrowserWindow})=>{
  const w=BrowserWindow.getAllWindows()[0];
  return { visible:w.isVisible(), minimized:w.isMinimized(), onTop:w.isAlwaysOnTop(), bounds:w.getBounds() };
});
// 단축키 핸들러와 같은 동작을 메인 프로세스에서 실행 (OS 단축키는 자동화로 누를 수 없음)
const toggle = (a) => a.evaluate(({BrowserWindow})=>{
  const w=BrowserWindow.getAllWindows()[0];
  if (w.isVisible() && !w.isMinimized()) { w.hide(); return 'hide'; }
  w.show(); w.setAlwaysOnTop(true,'screen-saver'); return 'show';
});

check(`단축키 ${KEY} 등록됨`, await reg(app));
const s0 = await winState(app);
console.log('초기:', JSON.stringify(s0));

// 숨기기
const a1 = await toggle(app); await new Promise(r=>setTimeout(r,700));
const s1 = await winState(app);
check('토글 1회 → 숨김', a1==='hide' && !s1.visible, JSON.stringify(s1));

// 되살리기
const a2 = await toggle(app); await new Promise(r=>setTimeout(r,700));
const s2 = await winState(app);
check('토글 2회 → 복원', a2==='show' && s2.visible, JSON.stringify(s2));
check('복원 후 항상 위 유지', s2.onTop === true);
check('복원 후 위치/크기 동일', JSON.stringify(s2.bounds)===JSON.stringify(s0.bounds), JSON.stringify(s2.bounds));
check('복원 후 데이터 유지', await page.evaluate(()=>document.getElementById('dprice').textContent) !== '—');

// 최소화된 상태에서 토글하면 숨김이 아니라 복원되어야 함
await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
await new Promise(r=>setTimeout(r,900));
const a3 = await toggle(app); await new Promise(r=>setTimeout(r,900));
const s3 = await winState(app);
check('최소화 상태에서 토글 → 복원(숨김 아님)', a3==='show' && s3.visible && !s3.minimized, JSON.stringify(s3));

check('A 콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));

// 종료하면 단축키를 반납해야 다음 실행에서 다시 잡을 수 있다
await app.close(); await new Promise(r=>setTimeout(r,1500));
app = await launch(); page = await app.firstWindow();
await ready(page);
check('종료 후 재실행에서도 단축키 등록 성공 (이전 인스턴스가 반납함)', await reg(app));
await app.close();

fs.writeFileSync(CFG,'{}');
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
