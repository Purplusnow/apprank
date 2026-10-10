# apprank

최종 업데이트: 2026-10-10

구글플레이 · 앱스토어 차트 순위를 국가별로 한 번에 보여주는 정적 사이트.
서버 없이 **GitHub Actions가 수집기, GitHub Pages가 CDN** 역할을 한다.

- 배포: https://apprank.koreanblog.xyz
- 벤치마크: `rank.rootgames.kr` (두 스토어, 실시간, 히스토리 없음)
- 경쟁: `appranks.app` (애플 전용, 40+개국, 4시간 갱신)
- **빈칸 = 두 스토어 동시 + 순위 히스토리** ← 우리 포지션

## 왜 정적으로 되는가

"앱 X가 N개국에서 몇 위냐"의 **답 전체 공간 = 모든 차트의 합집합**이다.
차트를 미리 다 떠두면 가능한 모든 답이 이미 손에 있다. 어떤 차트에도 없는 앱은
`—`이고, 그건 실시간 도구가 주는 답과 같다. 차이는 신선도뿐이다.

빌드 때 **역색인**으로 전치한다:

```
appId → { chartType: { country: { category: rank } } }
```

appId 해시로 버킷 1,024개로 쪼개면 조회 시 **파일 1개(~8KB)**만 받는다.
정적 사이트가 쿼리 API처럼 동작한다. 앱 제목·아이콘·개발사도 같은 버킷에 넣어
추가 요청 0, 아이콘은 Google/Apple CDN 핫링크라 저장 용량 0.

## 데이터 출처 (2026-10-10 실측)

| 출처 | 인증 | 차트 | 깊이 | CORS |
|---|---|---|---|---|
| Google Play (`google-play-scraper`) | 없음 (공식 API 부재) | free/paid/grossing | 200 | ❌ |
| Apple 레거시 RSS `itunes.apple.com/{cc}/rss/...` | 없음 | free/paid/**grossing** | 100 | ✅ `*` |
| Apple 신규 RSS `rss.marketingtools.apple.com` | 없음 | free/paid만 (grossing 404) | 100 | ❌ Origin 붙으면 403 |
| Play Developer / App Store Connect API | 계정+키 | **내 앱만** | — | — |

- 애플 레거시 RSS가 신규보다 우월하다: grossing 지원 + genre 필터 + **CORS 열림**.
  비공식·미문서라 언제든 끊길 수 있으므로, 스냅샷을 쌓아 과거를 보존한다.
- 애플 `genre` 파라미터는 **실제로 필터링한다** (교육/생산성/전략 차트가 명확히 다름 — 검증함).

## 측정값 (2026-10-10, KR 가정용 IP, 동시 8)

- 처리량 **20.5 req/s**, 차단 신호 **0건**, 재시도율 **0%**, p95 598ms
- 전체 매트릭스(49국 × 54카테 × 3차트 = 7,938) 수집 **약 6분**
- 권장 범위(49국 × 20스코프 × 3차트 = 2,940) 수집 **약 2.4분**
- 1차트 용량: Play `id+title` gzip **5.9KB** / `id`만 **2.2KB**, Apple gzip **2.4KB**
- 권장 범위 기준 데이터 총 **40~50MB**, 파일 **1~3천 개**

## 알아야 할 함정

1. **빈 차트에 라이브러리가 에러를 던진다.** 차단이 아니다. 수집기는 `[]`로 처리해야 한다.
   - 러시아는 유료/매출 차트가 **아예 없다** (2022년 유료 판매 중단 — Play 사이트에서 확인:
     `gl=ru` 카테고리 페이지에 `topselling_free`만 존재)
   - 유료 차트는 원래 얇다: `us/GAME_SPORTS/TOP_PAID` = **6건**, `kr/GAME/TOP_PAID` = 67건
   - 실측된 빈 차트 31건이 **전부 TOP_PAID 또는 ru/GROSSING**이었다
   → 유료 차트는 카테고리 단위에서 정보량이 거의 없다. 스코프 결정 시 고려.
2. **Pages 배포 10분 타임아웃.** 파일을 10만 개로 쪼개면 걸린다 → 버킷 1,024개로 묶는 이유.
3. **빌드 10회/시 소프트 리밋은 커스텀 Actions 워크플로엔 미적용.** branch 배포 대신 workflow 배포.
4. **공개 repo는 60일 무활동 시 스케줄이 자동 비활성.** 히스토리 커밋이 keepalive를 겸한다.
5. **cron 정확도 보장 없음.** 사이트에 "최종 갱신" 시각을 반드시 표기한다.
6. **서브패스 함정.** 커스텀 도메인이 빠지면 `/apprank/` 아래로 간다.
   데이터 fetch는 절대경로 금지, 상대경로 또는 `BASE_URL`로.
7. **Play 깊이 200은 robots 금지 경로를 탄다.** `/_/PlayStoreUi/data/batchexecute`가
   `Disallow: /_`에 걸린다. robots 허용 경로(`/store/apps/category/...`)로는 클러스터가
   섞인 89개만 나와 차트별 200위가 안 나온다. 의식적 선택이 필요한 지점.

## 법적 포지션

- 공식 API가 없어 받을 "권한"도 없다. 공개 피드 + 크롤링이 유일한 경로다.
- 구글 ToS는 robots 등 machine-readable instruction을 위반하는 자동 접근을 금지한다.
- 한국: 부정경쟁방지법상 성과물 무단사용·데이터 부정사용. 다만 야놀자/잡코리아 판례는
  "경쟁사 DB를 베껴 같은 시장에서 경쟁"하는 구도이고, 구글·애플은 차트를 스스로
  공개 배포하는 쪽이라 결이 다르다. 실무 리스크는 소송보다 **IP 차단·피드 폐쇄**다.
- 제품명·도메인에 `appstore`/`playstore`/`googleplay` 등 상표를 넣지 않는다.
- **"Google, Apple과 무관한 독립 도구"를 사이트에 명시한다** (필수 방어선).

## 단계

- [x] **Phase 0** — Actions IP 스파이크 (`tools/spike.mjs`, workflow_dispatch)
- [ ] **Phase 1** — 최소 범위 294차트 + 역색인 버킷 + Pages 배포
- [ ] **Phase 2** — 게임 18카테고리 확장
- [ ] **Phase 3** — 순위 히스토리 (전체차트 top50 × 국가 × 차트종류 일 1스냅샷 ≈ gzip 60KB/일)
- [ ] **Phase 4** — 원스토어

## 실행

```bash
npm install
npm run spike      # Phase 0 검증 (로컬 기준선)
```

Actions에서는 **Actions → Phase 0 — IP spike check → Run workflow**.
