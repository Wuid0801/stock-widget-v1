// 테스트가 의존하는 DOM 계약 가드 — 앱을 띄우지 않고 index.html 만 본다.
//
// #dname 의 textContent 는 "종목명"이어야 한다. 8개 스위트(watchlist · reorder ·
// restore · realtime · holdings · foreign · week52 · chart-integrity)가 이 값을
// 종목명과 직접 비교한다.
//
// 한 번 깨진 적이 있다. 업종을 붙이면서 #dname 을 래퍼로 만들고 이름을
// #dnameText 로 옮겼는데, 그러자 textContent 가 "삼성전자Consumer Electronics"
// 가 됐다(가운뎃점은 CSS ::before 라 textContent 에 없다). 업종은 네트워크를
// 타므로 도착 시점에 따라 값이 달라져 그 8개가 flaky 하게 깨진다.
// _paths.mjs 를 쓰지 않는다. 그 파일은 playwright-core 를 끌어오는데, 이 스위트는
// index.html 을 읽기만 하므로 의존성이 필요 없다. 덕분에 CI 가 node_modules 없이
// 이 스위트를 돌린다(.github/workflows/test.yml).
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

const nameTag = /<(\w+)[^>]*\bid="dname"/.exec(html);
const sectorTag = /<(\w+)[^>]*\bid="dsector"/.exec(html);

check('#dname 이 있다', !!nameTag);
check('#dsector 가 있다', !!sectorTag);

if (nameTag && sectorTag) {
  // 래퍼가 아니라 이름만 담는 잎 노드여야 한다
  check('#dname 은 span 이다 (래퍼 div 가 아니다)', nameTag[1] === 'span', `<${nameTag[1]}>`);

  // #dsector 가 #dname 안에 들어가 있으면 textContent 에 업종이 섞인다
  const between = html.slice(nameTag.index, sectorTag.index);
  check('#dname 이 #dsector 보다 먼저 나온다', sectorTag.index > nameTag.index);
  check('#dname 이 #dsector 를 감싸지 않는다 (사이에 닫는 태그가 있다)',
    between.includes('</span>'), between.replace(/\s+/g, ' ').slice(0, 80));

  // 지표 보기 버튼은 업종 오른쪽, 이름 줄(#dnameRow) 밖에 둔다. 안에 넣으면 긴 업종을 말줄임할 때
  // 버튼까지 잘리고, #dname 안이면 textContent 에 '지표' 가 섞인다.
  const btnTag = /<(\w+)[^>]*\bid="metricsBtn"/.exec(html);
  check('#metricsBtn 이 업종 뒤에 있다', !!btnTag && btnTag.index > sectorTag.index);
  if (btnTag) {
    const afterSector = html.slice(sectorTag.index, btnTag.index);
    check('#metricsBtn 은 이름 줄(#dnameRow) 밖에 있다 (사이에 줄을 닫는 태그가 있다)',
      afterSector.includes('</div>'), afterSector.replace(/\s+/g, ' ').slice(0, 80));
    check('#metricsBtn 은 차트 상자 앞(제목줄)에 있다', btnTag.index < html.indexOf('class="chartbox"'));
  }
  // 이름이 짧으면 버튼이 바로 아래 오늘 캔들 위에 온다 — 캔들 꼬리가 줄 맨 위까지 뻗으면 버튼 테두리에
  // 맞닿았다(셀트리온 · 제약, 2026-10-16). 이름 줄 아래를 조금 띄운다.
  const bar = /\.dnamebar\s*\{([^}]*)\}/.exec(html);
  const gap = bar && /margin-bottom:\s*(\d+)px/.exec(bar[1]);
  check('이름 줄(.dnamebar) 아래에 2px 이상 여백이 있다 (오늘 캔들이 버튼에 붙지 않게)', !!gap && Number(gap[1]) >= 2,
    bar ? bar[1].trim() : '규칙 없음');
}

// --- 스크립트 로드 순서 --------------------------------------------------------
// indicators.js 의 최상위 함수 선언이 전역이 되어야 renderer.js 가 이름으로 부른다.
// 태그가 빠지거나 순서가 뒤집히면 앱이 뜰 때만 드러나고, 그때는 화면이 통째로
// 죽는다 — 어떤 스위트도 이걸 보지 않아서 여기에 둔다.
const indicatorsTag = html.indexOf('src="./indicators.js"');
const rendererTag = html.indexOf('src="./renderer.js"');

check('index.html 이 indicators.js 를 싣는다', indicatorsTag >= 0);
check('index.html 이 renderer.js 를 싣는다', rendererTag >= 0);
if (indicatorsTag >= 0 && rendererTag >= 0) {
  check('indicators.js 가 renderer.js 보다 먼저 온다', indicatorsTag < rendererTag,
    `indicators ${indicatorsTag} vs renderer ${rendererTag}`);
}

// backtest.js 는 indicators.js 의 sma 를 전역으로 쓰고, renderer.js 가 trendCheck 를 부른다.
const backtestTag = html.indexOf('src="./backtest.js"');
check('index.html 이 backtest.js 를 싣는다', backtestTag >= 0);
if (backtestTag >= 0 && indicatorsTag >= 0 && rendererTag >= 0) {
  check('backtest.js 가 indicators.js 뒤, renderer.js 앞에 온다',
    indicatorsTag < backtestTag && backtestTag < rendererTag);
}

// --- 추세 점검 줄 ----------------------------------------------------------------
// 52주 줄과 차트 사이. 차트 아래로 가면 관심종목 목록과 붙어 종목 정보로 읽히지 않는다.
const w52Tag = html.indexOf('id="w52"');
const trendTag = html.indexOf('id="trendCheck"');
const chartTag = html.indexOf('class="chartbox"');
check('#trendCheck 가 있다', trendTag >= 0);
check('#trendCheck 는 52주 줄과 차트 사이에 있다', w52Tag >= 0 && w52Tag < trendTag && trendTag < chartTag);
const trendCss = /\.trendchk\s*\{([^}]*)\}/.exec(html);
check('.trendchk 는 한 줄로 자르고 말줄임한다 (줄이 늘면 차트가 밀린다)',
  !!trendCss && /white-space:\s*nowrap/.test(trendCss[1]) && /text-overflow:\s*ellipsis/.test(trendCss[1]));

// --- 보유 · 52주 · 추세 점검 접기 ---------------------------------------------------
// 세 줄은 저마다 hidden 으로 보일지 정한다. 접기는 그 값을 건드리지 않고 앞의 손잡이(#infoToggle)의
// .off 와 형제 선택자로만 숨긴다 — 그래서 손잡이가 세 줄보다 앞에, 같은 부모 안에 있어야 한다.
const toggleTag = html.indexOf('id="infoToggle"');
const holdTag = html.indexOf('id="hold"');
check('#infoToggle 이 보유 줄 바로 위에 있다', toggleTag >= 0 && toggleTag < holdTag
  && !/<\/div>/.test(html.slice(toggleTag, holdTag)), '사이에 닫는 태그가 있으면 형제가 아니다');
for (const id of ['hold', 'w52', 'trendCheck']) {
  check(`접으면 #${id} 가 숨는다`, new RegExp(`\\.infotoggle\\.off\\s*~\\s*#${id}\\b[^{]*\\{[^}]*display:\\s*none`).test(html)
    || new RegExp(`\\.infotoggle\\.off\\s*~\\s*#${id}\\s*,`).test(html));
}

// --- 스크롤바 ------------------------------------------------------------------
// 스크롤하는 곳은 모두 위젯 스크롤바(5px 얇은 막대, --scroll 색)를 쓴다. 규칙이 빠지면 운영체제 기본
// 스크롤바(넓은 회색 막대 · 화살표)가 나와 위젯과 어울리지 않는다 — 지표 보기가 처음에 그랬다.
const scrollers = [...html.matchAll(/([#.][\w-]+)\s*\{[^}]*overflow-y:\s*(?:auto|scroll)/g)].map((m) => m[1]);
check('스크롤하는 곳이 있다', scrollers.length > 0, scrollers.join(' '));
for (const sel of scrollers) {
  const esc = sel.replace('.', '\\.');
  check(`${sel} 는 위젯 스크롤바를 쓴다`,
    new RegExp(`${esc}::-webkit-scrollbar\\s*\\{[^}]*width:\\s*5px`).test(html)
      && new RegExp(`${esc}::-webkit-scrollbar-thumb\\s*\\{[^}]*var\\(--scroll\\)`).test(html));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
