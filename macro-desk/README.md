# Macro Desk

NAS100, XAUUSD, USOIL, EURUSD의 **당일 방향성**을 외부요인 기반으로 계산해
폰에서 확인하는 모바일 우선 대시보드입니다. 기본 모드는 차트 번들 없이 도는 `macro-only`이고,
번들을 붙일 수 있을 때만 `fusion`으로 올립니다.

## 구조

```
매크로 레이어            위치 레이어           이벤트 레이어
 수치→밴드 stance         전일 종가 대비        티어별 블랙아웃
 시간 감쇠·블록 상한       지지/저항 돌파         확신도 상한
        └──────────────────┬──────────────────┘
                           ▼
        방향 · 확신도 · 주도/반대 요인 · 재분석 트리거
                           │
                           ▼
              예측 기록 → 8시간 뒤 채점 → 적중률
```

**방향은 매크로가 정합니다.** 가격과 이벤트는 확신도와 문장만 조정하고 방향을 뒤집지 않습니다.

- 수치형 팩터(금리·DXY·VIX 등)는 실측치를 밴드에 넣어 stance를 파생하므로, 같은 수치는
  언제나 같은 결과를 냅니다. 서수형 팩터는 앵커 문구에 대응시킵니다.
- 같은 사건을 인용한 팩터는 가중치가 감쇠되고, 한 진영이 전체의 60%를 넘으면 상한이 걸립니다.
- 모든 예측은 기록되고 8시간 뒤 실제 방향과 대조됩니다. 확신도 구간별 적중률이
  단조증가하지 않으면 공식이 틀린 것입니다.
- `fusion` 모드(v4 번들 첨부 시)는 차트 레이어를 추가로 계산해 합의 매트릭스로 합칩니다.

- 규칙서: [`docs/fusion-ruleset.md`](docs/fusion-ruleset.md) — 팩터 루브릭·점수식·블록 규칙·검증 루프
- 운영 절차: [`docs/runbook.md`](docs/runbook.md) — 수집 규율·스냅샷·배포
- 주간 보정: [`docs/calibration.md`](docs/calibration.md) — 실측으로 파라미터를 갱신하는 절차

## 파일

- `src/engine/` — 결정적 융합 엔진(매크로·차트·이벤트·융합)
- `src/engine/__tests__/` — 엔진 테스트
- `scripts/build-snapshot.ts` — 세션 입력 → `public/macro.json`
- `scripts/from-bundle.ts` — v4 통합 번들 ZIP → 캔들 입력
- `scripts/calibrate.ts` — 예측 기록 → 성과 평가 + 파라미터 보정 + 주간 리포트
- `src/engine/evaluate.ts` — IC·나이브 벤치마크·정책 시뮬레이션·손익 비대칭
- `src/engine/params.json` — 보정으로 갱신되는 파라미터 (중립밴드)
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
