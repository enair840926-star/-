# Macro Desk

NAS100, XAUUSD, USOIL, EURUSD의 **당일 방향성**을 외부요인 기반으로 계산해
폰에서 확인하는 모바일 우선 대시보드입니다. 기본 모드는 차트 번들 없이 도는 `macro-only`이고,
번들을 붙일 수 있을 때만 `fusion`으로 올립니다.

## 구조

```
매크로 레이어 (외부요인)            [선택] 차트 레이어 (v4 통합 번들)
  가중 팩터 → 점수·커버리지·분산        D1/H4/H1/M15 → 추세·구조·모멘텀
        └───────────┬────────────────────────┘
               이벤트 레이어 (블랙아웃·확신도 상한)
                    ▼
        방향 · 확신도 · 주도/반대 요인 · 관측 레벨 · 재분석 트리거
```

- `macro-only` (기본): 외부요인 점수와 팩터 분산으로 편향을 내고, 리서치에서 인용한
  지지·저항을 확인 포인트로 붙입니다. 확신도 상한 70.
- `fusion`: 번들 캔들로 차트 레이어를 계산해 합의 매트릭스로 합칩니다. 두 레이어는
  서로를 수정하지 않고(레이어 잠금) 원값이 그대로 보존됩니다.

- 규칙서: [`docs/fusion-ruleset-v1.md`](docs/fusion-ruleset-v1.md) — 가중치·점수식·합의 매트릭스·금지 사항
- 운영 절차: [`docs/runbook.md`](docs/runbook.md) — 수집·번들 연결·스냅샷·배포

## 파일

- `src/engine/` — 결정적 융합 엔진(매크로·차트·이벤트·융합)
- `src/engine/__tests__/` — 엔진 테스트
- `scripts/build-snapshot.ts` — 세션 입력 → `public/macro.json`
- `scripts/from-bundle.ts` — v4 통합 번들 ZIP → 캔들 입력
- `data/session/latest.json` — 최신 세션 입력(감사 추적용으로 함께 커밋)
- `public/macro.json` — 화면이 읽는 단일 데이터 원본
- `src/App.tsx` — 이중 게이지·합의 배지·블랙아웃 카운트다운·수동 오버라이드
- `.github/workflows/macro-desk-pages.yml` — 변경 시 GitHub Pages 재배포

브라우저에서 AI API나 시세 API를 직접 호출하지 않습니다. 예약 작업이 `macro.json`을
갱신하고, 화면은 그 파일만 읽습니다.

## 사용

```bash
npm ci

# 1) data/session/latest.json 의 factors·events 를 채운다 (runbook 참고)
# 2) 차트 붙이기
npm run bundle -- --asset XAUUSD --zip ~/bundles/xauusd.zip
# 3) 스냅샷 생성
npm run snapshot -- --input data/session/latest.json
```

## 검증

```bash
npm run check   # 타입
npm test        # 엔진 테스트
npm run build   # 프로덕션 빌드
```

## 로컬 실행

```bash
npm run dev
```

## GitHub Pages

저장소의 **Settings → Pages → Build and deployment**에서 Source를 **GitHub Actions**로
설정하면 워크플로가 `macro-desk/dist`를 배포합니다.

프로젝트 사이트 기준 경로는 저장소 이름에 맞춰 `/-/`로 설정되어 있습니다.

## 주의

방향과 확신도는 분석 좌표입니다. 체결과 시세 정본은 MT5이며, 이 화면은 주문 실행·포지션
크기·레버리지 결정을 대신하지 않습니다.
