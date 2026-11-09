// 테스트가 의존하는 DOM 계약 가드 — 앱을 띄우지 않고 index.html 만 본다.
//
// #dname 의 textContent 는 "종목명"이어야 한다. 7개 스위트(watchlist · reorder ·
// restore · realtime · holdings · foreign · week52)가 이 값을
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
import { RENDERER_FILES, rendererSource } from './_renderer.mjs';

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
// indicators.js 의 최상위 함수 선언이 전역이 되어야 렌더러(renderer/*.js)가 이름으로 부른다.
// 태그가 빠지거나 순서가 뒤집히면 앱이 뜰 때만 드러나고, 그때는 화면이 통째로
// 죽는다 — 어떤 스위트도 이걸 보지 않아서 여기에 둔다.
const indicatorsTag = html.indexOf('src="./indicators.js"');
const rendererTag = html.indexOf('src="./renderer/'); // 렌더러 첫 파일

check('index.html 이 indicators.js 를 싣는다', indicatorsTag >= 0);
check('index.html 이 렌더러(renderer/)를 싣는다', rendererTag >= 0);
if (indicatorsTag >= 0 && rendererTag >= 0) {
  check('indicators.js 가 렌더러보다 먼저 온다', indicatorsTag < rendererTag,
    `indicators ${indicatorsTag} vs renderer ${rendererTag}`);
}

// backtest.js 는 indicators.js 의 sma 를 전역으로 쓰고, 렌더러가 trendCheck 를 부른다.
const backtestTag = html.indexOf('src="./backtest.js"');
check('index.html 이 backtest.js 를 싣는다', backtestTag >= 0);
if (backtestTag >= 0 && indicatorsTag >= 0 && rendererTag >= 0) {
  check('backtest.js 가 indicators.js 뒤, 렌더러 앞에 온다',
    indicatorsTag < backtestTag && backtestTag < rendererTag);
}

// market-check.js 는 화면과 무관한 판정 함수(전역 marketChecks)이고 렌더러의 시장 지표 화면이 부른다.
const marketCheckTag = html.indexOf('src="./market-check.js"');
check('index.html 이 market-check.js 를 싣는다', marketCheckTag >= 0);
if (marketCheckTag >= 0 && backtestTag >= 0 && rendererTag >= 0) {
  check('market-check.js 가 backtest.js 뒤, 렌더러 앞에 온다', backtestTag < marketCheckTag && marketCheckTag < rendererTag);
}

// 렌더러는 renderer/ 의 파일들이다. 태그마다 파일이 있고, 디렉터리의 파일은 모두 태그가 있어야 한다 — 새 파일을 만들고 태그를
// 빠뜨리면 그 함수들이 없는 채로 뜨고, 지운 파일의 태그가 남으면 그 자리에서 404 다. 첫 파일은 상태 선언(state.js), 마지막은 시작(start.js).
{
  const tags = RENDERER_FILES;
  const files = fs.readdirSync(new URL('../renderer/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `renderer/${f}`);
  check('렌더러 태그마다 파일이 있다', tags.every((t) => files.includes(t)), tags.filter((t) => !files.includes(t)).join(', '));
  check('renderer/ 의 파일은 모두 태그가 있다', files.every((f) => tags.includes(f)), files.filter((f) => !tags.includes(f)).join(', '));
  check('렌더러는 state.js 로 시작해 start.js 로 끝난다', tags[0] === 'renderer/state.js' && tags.at(-1) === 'renderer/start.js', tags.join(' '));
  check('렌더러 태그는 market-check.js 뒤에 이어서 있다', tags.length > 0
    && html.indexOf(`src="./${tags.at(-1)}"`) > marketCheckTag && !/src="\.\/(?!renderer\/)[^"]+"/.test(html.slice(rendererTag)));
  check('예전 renderer.js 를 싣지 않는다', !html.includes('src="./renderer.js"'));
}

// 지표 화면의 누를 수 없는 줄(.mrow.mfix — 선물 · 수급 · HY OAS)도 가로 한 줄이어야 한다. 가로 배치(display: flex)가 누를 수 있는
// 줄의 .hit 에만 있어서 이 줄들은 칸이 세로로 흩어지고 판정 점도 안 보였다(2026-10-27 실화면).
check('지표 화면의 누를 수 없는 줄도 가로 한 줄(display: flex)', /\.mrow\.mfix\s*\{[^}]*display:\s*flex/.test(html));

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
// 스크롤하는 곳은 모두 위젯 스크롤바(5px 얇은 막대, --scroll 색)를 쓴다 — 전역 규칙 하나라 새 스크롤 영역도 따로
// 적지 않는다. 빠지면 운영체제 기본 스크롤바(넓은 회색 막대 · 화살표)가 나와 위젯과 어울리지 않는다 — 지표 보기가
// 처음에 그랬다(그때는 곳마다 적어야 했다, 2026-11-05 전역으로).
check('위젯 스크롤바가 전역 규칙이다', /\s::-webkit-scrollbar\s*\{[^}]*width:\s*5px/.test(html)
  && /\s::-webkit-scrollbar-thumb\s*\{[^}]*var\(--scroll\)/.test(html));

// --- 패널 머리줄 · 지표 화면 단락 ------------------------------------------------------
// 패널 머리줄(.qbar)의 24px 버튼 규칙은 닫기 버튼(직계 자식)에만 건다. 자손 전체에 걸었더니 순위 패널의
// 국내 / 미국 버튼까지 24px 로 눌려 글자가 겹쳤다(2026-10-16).
check('.qbar 의 버튼 규칙은 직계 자식(닫기)에만 건다', /\.qbar\s*>\s*button\s*\{[^}]*width:\s*24px/.test(html)
  && !/\.qbar\s+button\s*[{:,]/.test(html));
// 지표 화면은 단락(오늘 · 기간 수익률 · 매매동향 · 실적 · 가치 지표 …)이 길게 이어져 경계가 보여야 한다
check('지표 화면의 단락 사이에 점선이 있다', /\.metrics section \+ section\s*\{[^}]*border-top:\s*1px dashed/.test(html));

// --- RSI 칸 ------------------------------------------------------------------
// RSI 를 켜 두면 차트 상자(.chartbox.sub)가 RSI 칸(renderer/state.js RSI_PANE)만큼 커져 가격 칸은 그대로다 — 세 값이 어긋나면
// 가격 칸이 줄거나 빈 띠가 남는다. 켜고 끄기는 설정 칩, RSI ↔ 스토캐스틱은 칸 양옆 ‹ ›(#paneNav)다.
{
  const pane = +/const RSI_PANE = (\d+);/.exec(rendererSource())[1];
  const base = /\.chartbox\s*\{\s*height:\s*clamp\((\d+)px,\s*26vh,\s*(\d+)px\)/.exec(html);
  const sub = /\.chartbox\.sub\s*\{\s*height:\s*clamp\((\d+)px,\s*calc\(26vh \+ (\d+)px\),\s*(\d+)px\)/.exec(html);
  check('.chartbox · .chartbox.sub 높이 규칙이 있다', !!base && !!sub);
  check('.chartbox.sub 는 최소 · 보통 · 최대 모두 RSI_PANE 만큼 크다', !!base && !!sub
    && +sub[1] === +base[1] + pane && +sub[2] === pane && +sub[3] === +base[2] + pane, `RSI_PANE ${pane}`);
  // RSI 크게 보기(#rsiTall)를 켜면 RSI 칸이 RSI_TALL 이라 상자(.chartbox.sub.tall)도 그만큼 커진다 — 가격 칸은 그대로
  const tallPane = +/const RSI_TALL = (\d+);/.exec(rendererSource())[1];
  const tall = /\.chartbox\.sub\.tall\s*\{\s*height:\s*clamp\((\d+)px,\s*calc\(26vh \+ (\d+)px\),\s*(\d+)px\)/.exec(html);
  check('.chartbox.sub.tall 은 최소 · 보통 · 최대 모두 RSI_TALL 만큼 크다', !!base && !!tall
    && +tall[1] === +base[1] + tallPane && +tall[2] === tallPane && +tall[3] === +base[2] + tallPane, `RSI_TALL ${tallPane}`);
  const ctl = /<span class="chartctl">([\s\S]*?)<\/span>/.exec(html);
  // 차트 위 RSI · 스토 버튼은 없앴다(사용자 결정, 2026-11-09) — 크게 보기(↕)만 남는다
  check('차트 버튼 묶음에 크게 보기는 있고 RSI · 스토 버튼은 없다',
    !!ctl && /<button id="rsiTall" type="button" hidden>↕<\/button>/.test(ctl[1]) && !/rsiPane|stochPane/.test(html));
  check('#rsiTall 은 정규장/전체 버튼과 같은 모양(켜지면 또렷)', /#candleVenue, #extHours, #rsiTall \{/.test(html)
    && /#extHours\.on, #rsiTall\.on \{/.test(html) && /#extHours\[hidden\], #rsiTall\[hidden\]/.test(html));
  // 아래 칸 양옆 ‹ › — 차트 상자 안 버튼 묶음 뒤. display:flex 라 [hidden] 규칙이 따로 있어야 숨고, 지표 화면이 열리면 숨는다
  check('#paneNav 는 차트 상자 안에 ‹ · › 두 버튼',
    /<\/span><span class="panenav" id="paneNav" hidden><button type="button"[^>]*>‹<\/button><button type="button"[^>]*>›<\/button><\/span><\/div>/.test(html));
  check('#paneNav 는 숨김 · 지표 화면에서 보이지 않는다', /\.panenav\[hidden\], \.metrics:not\(\[hidden\]\) ~ \.panenav \{ display: none; \}/.test(html));
  // 설정의 보조 지표는 상단 지표(가격 차트 위) · 하단 지표(차트 아래 칸)로 나눈다(사용자 결정, 2026-11-09)
  check('설정에 상단 지표 · 하단 지표 칩 자리가 차례로 있다', /상단 지표[\s\S]*?id="indChips"[\s\S]*?하단 지표[\s\S]*?id="paneChips"/.test(html));
  check('스토캐스틱 선 색이 두 테마에 있다', (html.match(/--stoch-line: #[0-9a-f]{6};/g) || []).length === 2);
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
