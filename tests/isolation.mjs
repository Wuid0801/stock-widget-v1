// 테스트가 실제 앱 설정을 건드리지 않는지 확인한다. 앱을 띄우지 않는다.
//
// run.mjs 는 매 스위트 전에 resetConfig() 로 설정을 '{}' 로 밀고, 스위트들은
// 앱을 띄워 관심종목을 넣고 지운다. 그 대상이 실제 사용자 설정이면 npm test
// 한 번에 관심종목·보유·알림이 날아간다. 실제로 그렇게 비어 있었다.
//
// 건드릴 수 있는 프로필이 둘이다:
//   %APPDATA%/kr-stock-widget   개발 실행 (package.json 의 name)
//   %APPDATA%/관심종목 위젯      설치본 (productName) — packaged.mjs 가 띄운다
// 둘 다 --user-data-dir 로 임시 경로를 물려 격리해야 한다.
import fs from 'node:fs';
import path from 'node:path';
// 네임스페이스로 받는다. 이름 하나가 없으면 ESM 이 SyntaxError 로 죽어버려
// 어느 검사가 깨졌는지 보이지 않는다.
import * as P from './_paths.mjs';

const { APP_DIR, CFG_PATH, USER_DATA_DIR, LAUNCH_ARGS, LAUNCH_ENV, CFG_ENV } = P;

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
const REAL = ['kr-stock-widget', '관심종목 위젯'].map((n) => path.join(APPDATA, n));

check('USER_DATA_DIR 가 정의돼 있다', typeof USER_DATA_DIR === 'string' && USER_DATA_DIR.length > 0,
  String(USER_DATA_DIR));

if (typeof USER_DATA_DIR === 'string') {
  for (const real of REAL) {
    check(`임시 프로필이 실제 프로필과 다르다 (${path.basename(real)})`,
      path.resolve(USER_DATA_DIR) !== path.resolve(real)
      && !path.resolve(USER_DATA_DIR).startsWith(path.resolve(real) + path.sep),
      USER_DATA_DIR);
  }
  check('설정 파일이 임시 프로필 안에 있다',
    path.resolve(CFG_PATH).startsWith(path.resolve(USER_DATA_DIR) + path.sep), CFG_PATH);
  check('임시 프로필 디렉터리가 만들어져 있다', fs.existsSync(USER_DATA_DIR));
}

for (const real of REAL) {
  check(`설정 파일이 실제 프로필을 가리키지 않는다 (${path.basename(real)})`,
    !path.resolve(CFG_PATH).startsWith(path.resolve(real) + path.sep), CFG_PATH);
}

check('launchApp 이 --user-data-dir 를 넘긴다',
  Array.isArray(LAUNCH_ARGS) && LAUNCH_ARGS.some((a) => a === `--user-data-dir=${USER_DATA_DIR}`),
  JSON.stringify(LAUNCH_ARGS));

// 순서가 중요하다. `electron <앱경로> --user-data-dir=X` 는 스위치가 앱에 넘어가는
// 인자로 취급되어 Electron 이 무시한다. 실제로 그렇게 두었다가 앱이 실제 프로필에
// 585바이트를 쓰는 것을 확인했다. Chromium 스위치는 앱 경로보다 앞에 와야 한다.
if (Array.isArray(LAUNCH_ARGS)) {
  const sw = LAUNCH_ARGS.findIndex((a) => String(a).startsWith('--user-data-dir='));
  const app = LAUNCH_ARGS.findIndex((a) => a === APP_DIR);
  check('--user-data-dir 가 앱 경로보다 앞에 있다', sw >= 0 && app >= 0 && sw < app,
    `스위치 ${sw}번, 앱 경로 ${app}번`);
}

// --user-data-dir 만으로는 부족하다. main.js 가 electron-store 의 cwd 를
// app.getPath('appData') 기준으로 고정해 두었고(설치본이 기존 설정을 잃지 않도록
// 일부러 그렇게 둔 것이다) appData 는 --user-data-dir 로 바뀌지 않는다. 그래서
// 스위치가 먹어도 설정만은 실제 프로필에 쓰였다 — 583바이트를 실측했다.
// 설정 경로는 환경변수로 따로 돌린다.
check('launchApp 이 설정 경로 환경변수를 넘긴다',
  !!LAUNCH_ENV && LAUNCH_ENV[CFG_ENV] === USER_DATA_DIR,
  `${CFG_ENV}=${LAUNCH_ENV && LAUNCH_ENV[CFG_ENV]}`);

const mainSrc = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
check('main.js 가 그 환경변수를 읽는다', mainSrc.includes(`process.env.${CFG_ENV}`),
  /cwd:.*$/m.exec(mainSrc)?.[0] || '(cwd 를 찾지 못함)');

// packaged.mjs 는 설치본을 자기 손으로 띄우므로 _paths 의 launchApp 을 타지 않는다.
const pkg = fs.readFileSync(path.join(APP_DIR, 'tests', 'packaged.mjs'), 'utf8');
check('packaged.mjs 도 --user-data-dir 를 넘긴다', pkg.includes('--user-data-dir'),
  /args:\s*\[[^\]]*\]/.exec(pkg)?.[0] || '(args 를 찾지 못함)');
check('packaged.mjs 도 설정 경로 환경변수를 넘긴다', pkg.includes('LAUNCH_ENV'),
  pkg.includes('LAUNCH_ENV') ? '' : (pkg.includes('env:') ? 'env 는 있으나 LAUNCH_ENV 가 아님' : '(env 없음)'));

// 환경변수를 넘겨도 dist/ 빌드가 그것을 모르면 소용이 없다. 실제로 2026-08-07 자
// 빌드를 띄웠더니 실제 프로필에 513바이트가 써졌다. 빌드가 낡았으면 띄우지 않고
// 건너뛰어야 한다 — dist/ 가 없을 때 이미 그렇게 하고 있다.
check('packaged.mjs 가 낡은 빌드를 걸러낸다', pkg.includes(CFG_ENV),
  pkg.includes(CFG_ENV) ? '' : `${CFG_ENV} 를 asar 에서 확인하는 코드가 없음`);

// 어떤 스위트도 앱 소스를 고쳐 쓰면 안 된다. polling.mjs 가 장 상태를 강제하려고
// main.js 를 디스크에서 치환하고 finally 에서 되돌렸는데, 프로세스가 중간에 죽으면
// 사용자의 main.js 가 패치된 채로 남는다. 세션 강제는 환경변수로 한다.
for (const f of fs.readdirSync(path.join(APP_DIR, 'tests')).filter((n) => n.endsWith('.mjs'))) {
  const src = fs.readFileSync(path.join(APP_DIR, 'tests', f), 'utf8');
  // 파일 이름을 변수로 넘겨도 잡는다 — alerts.mjs 가 renderer.js 경로를 RENDERER 변수로 넘겨 빠져나갔다(2026-10-21)
  const writesSource = /writeFileSync\(\s*(MAIN|RENDERER|PRELOAD|INDEX(_HTML)?|INDICATORS|BACKTEST|MARKET_CHECK)\b/.test(src)
    || /writeFileSync\([^)]*\b(main|renderer|index|preload|indicators|backtest|market-check)\.(js|html)/.test(src);
  check(`${f} 가 앱 소스를 고쳐 쓰지 않는다`, !writesSource,
    writesSource ? /writeFileSync\([^)]*\)/.exec(src)?.[0] : '');
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
