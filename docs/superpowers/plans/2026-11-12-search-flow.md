# Search and Flow Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API 키 없이 인기 검색과 시장·종목 수급 확대 차트를 제공한다.

**Architecture:** 검색은 기존 rankCache와 loadRank를 공유한다. 수급은 별도 renderer/flow.js가 기존 캐시와 조회 함수를 소비하고 Chart.js 모달을 그린다. 기존 가격 차트 상태는 변경하지 않는다.

**Tech Stack:** Electron, JavaScript, Chart.js, Node.js tests.

**Spec:** docs/superpowers/specs/2026-11-12-search-flow-design.md

## Global Constraints

- OI와 API 키 연동은 추후 작업이다.
- 새 의존성과 IPC는 추가하지 않는다.
- 시장 수급은 억 원, 종목 수급은 주(KRX)다.
- 현재 작업 공간에서 수정하고 커밋·브랜치 생성은 하지 않는다.

## Review Focus

- 검색 입력·비우기·닫기 사이 지연 응답이 현재 목록을 덮어쓰지 않는지 확인한다.
- 인기 검색과 순위 패널이 캐시·진행 중 요청을 공유하는지 확인한다.
- 수급의 0과 누락값을 구분하고 날짜를 오름차순으로 표시한다.
- 모달 닫기·보기 전환 중 지연 응답과 차트 인스턴스를 정리한다.
- 조회 실패·빈 데이터·이전 거래일 데이터를 구분하며 기존 화면을 보존한다.

### Task 1: 인기 검색

**Files:** renderer/search.js, renderer/rank.js, renderer/start.js, tests/popular-search.mjs.

**Interfaces:** renderSearchPopular()는 kr|search 캐시를 읽으며 loadRank('kr', 'search') 완료 시 갱신한다.

- [ ] 기존 렌더러를 실행하는 테스트로 인기 목록·캐시·지연 응답 실패를 확인한다.
- [ ] 빈 검색 인기 목록과 입력 시 요청 무효화를 구현한다.
- [ ] 새 테스트와 기존 검색·렌더러 검사를 실행한다.

### Task 2: 수급 확대 차트

**Files:** renderer/flow.js, renderer/rank.js, renderer/metrics.js, renderer/start.js, renderer/actions.js, index.html, tests/flow.mjs.

**Interfaces:** openFlow(view), renderFlow(), closeFlow()와 flowData(view, data). view.kind는 daily/intraday/stock이며 stock은 symbol/name, 시장은 key를 가진다. intraday의 venue는 spot/fut다.

- [ ] 단위·날짜·주체·누락값·보기 전환·오류와 모달 수명 테스트를 먼저 작성하고 실패를 확인한다.
- [ ] 실제 캐시를 소비하는 모달과 진입 버튼·키보드 처리를 구현한다.
- [ ] 관련 데이터 및 렌더러 테스트를 실행하고 사용법을 갱신한다.

### Task 3: 통합 검증

- [ ] 전체 npm test를 실행하고 환경 제약이나 실패를 기록한다.
- [ ] 가능한 경우 실제 Electron 화면에서 인기 검색·시장/종목 차트·Esc 복귀를 확인한다.
- [ ] 최종 diff를 검토하고 결과를 사용자에게 알린다.
