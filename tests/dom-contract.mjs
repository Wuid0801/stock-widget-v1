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

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
