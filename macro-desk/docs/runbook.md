# 운영 절차 (Runbook)

하루 3회(08:00 · 16:00 · 22:00 KST) 스냅샷을 만드는 절차다.
매크로는 웹 리서치로, 차트는 v4 통합 번들로 채운 뒤 엔진이 둘을 융합한다.

```
[웹 리서치] ──► data/session/latest.json (factors, events)
                          │
[v4 번들 ZIP] ─► npm run bundle ──► 같은 파일의 candles 블록
                          │
                          ▼
                 npm run snapshot ──► public/macro.json ──► GitHub Pages
```

---

## 1. 매크로 레이어 수집

`data/session/latest.json`의 `assets.<자산>.factors`를 채운다.
키 목록과 부호 규칙은 `docs/fusion-ruleset-v1.md` §1.2, 원본은 `src/engine/weights.ts`.

수집 원칙:

- **stance 부호는 자산 가격 기준으로 맞춰서 넣는다.** 지표 자체의 방향이 아니다.
  (달러 강세는 XAUUSD `dollar`에서 음수, EURUSD `rateDiff`에서 미국 우위면 음수)
- `note`에는 반드시 **숫자**를 넣는다. "금리 상승" ✗ / "10Y 4.745%(+7.5bp)" ○
- 확인이 안 된 팩터는 **넣지 말거나 `confidence`를 낮춘다.** 지어내면 커버리지 경고가 무력해진다.
- 이번 세션에 새 정보가 없는 팩터는 직전 값을 유지하되 `confidence`를 0.1~0.2 낮춘다.

`events`에는 앞으로 48시간 내 지표만 넣는다. 티어 기준은 ruleset §3.
시각은 ISO8601로 쓰고 오프셋을 반드시 붙인다(`2026-08-07T12:30:00Z`).

> 이 저장소 환경에서는 FMP MCP의 chart/quote/economics 엔드포인트가 현재 플랜에서 막혀 있고,
> 외부 시세 API(Yahoo·stooq)도 네트워크 정책상 직접 호출되지 않는다.
> 그래서 매크로 레이어는 **웹 검색 결과**를 근거로 채운다. 시세 정본은 항상 MT5다.

## 2. 차트 레이어 붙이기

MT5에서 뽑은 v4 통합 번들을 그대로 쓴다.

```bash
npm run bundle -- --asset XAUUSD --zip ~/bundles/xauusd-2026-08-03.zip
npm run bundle -- --asset NAS100 --raw /tmp/extract/rawbundle.json
```

- ZIP 안의 `rawbundle.json`만 읽는다. `hud_lite`/`by_tf`/`derived`는 읽지 않는다.
- `is_complete=false` 봉은 자동으로 빠진다.
- TF당 기본 180봉까지 가져온다(`--max-bars`로 조정).
- 번들을 아직 못 붙이는 세션이면 해당 자산에 `"technicalPending": true`를 두고 넘어간다.
  방향은 중립으로 잠기고 플레이북이 "차트 레이어 대기"로 표시된다.

## 3. 스냅샷 생성

```bash
npm run snapshot -- --input data/session/latest.json     # public/macro.json 갱신
npm run snapshot -- --input data/session/latest.json --print   # 파일 안 쓰고 확인만
```

입력 검증에 걸리면 그대로 멈춘다(알 수 없는 팩터 키, 파싱 안 되는 이벤트 시각, 빈 캔들 등).
출력 요약에서 확인할 것:

- **레짐**: CONFLICT면 그 자산은 그날 관망 후보다.
- **플래그**: `MACRO_COVERAGE_LOW`가 뜨면 팩터를 더 채운다. `TF_*_WARMUP`이면 번들 기간을 늘린다.
- **확신도**: 35 미만이면 방향이 중립으로 강등된 상태다.

## 4. 커밋과 배포

```bash
git add macro-desk/public/macro.json macro-desk/data/session/latest.json
git commit -m "chore: refresh macro desk <시간대> snapshot"
git push -u origin <branch>
```

`main`에 들어가면 `.github/workflows/macro-desk-pages.yml`이 Pages를 재배포한다.

## 5. 검증

```bash
npm run check   # 타입
npm test        # 엔진 74개 테스트
npm run build   # 프로덕션 번들
```

---

## 부록. 예약 작업 프롬프트 템플릿

세션마다 아래 지시를 그대로 쓰면 된다.

```
macro-desk 스냅샷을 갱신해줘.

1. NAS100·XAUUSD·USOIL·EURUSD의 당일 매크로/외부 요인을 조사한다.
   - docs/fusion-ruleset-v1.md §1.2의 팩터 키만 사용한다.
   - stance는 해당 자산 가격에 대한 압력 기준으로 -2~+2, note에는 숫자를 넣는다.
   - 확인 못 한 팩터는 넣지 말고, 오래된 값은 confidence를 낮춘다.
2. 앞으로 48시간 내 지표를 events에 넣는다(티어는 ruleset §3).
3. data/session/latest.json을 갱신한다. 번들이 없는 자산은 technicalPending: true를 유지한다.
4. npm run snapshot 을 돌리고 요약과 플래그를 확인한다.
5. macro.json과 latest.json을 커밋·푸시한다.

레이어 잠금 규칙을 지킨다: 매크로 결론으로 차트 점수를 고쳐 쓰지 않는다.
```
