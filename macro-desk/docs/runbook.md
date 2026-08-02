# 운영 절차 (Runbook)

하루 3회(08:00 · 16:00 · 22:00 KST) 방향성 스냅샷을 만드는 절차다.
**기본은 번들 없이 도는 `macro-only` 모드**이며 웹 리서치만으로 완결된다.

```
[웹 리서치] ──► data/session/latest.json (factors · levels · events)
                          │
                          ▼
                 npm run snapshot ──► public/macro.json ──► GitHub Pages
                          │              └► data/history/predictions.jsonl (기록·채점)
                          ▲
[v4 번들 ZIP] ─► npm run bundle ──┘   (선택 · fusion 모드일 때만)
```

규칙·밴드표는 [`fusion-ruleset.md`](fusion-ruleset.md), 원본은 `src/engine/weights.ts`.

---

## 1. 매크로 팩터 수집

### 반드시 지킬 것

- **stance는 변화·서프라이즈다.** 수준(level)이 아니다.
  "DXY 99.91, 5주 고점권" ✗ → "DXY 99.91, 일간 −0.05%" ○
- **수치형 팩터는 `value`만 넣는다.** stance를 직접 넣지 않는다 — 엔진이 밴드에서 파생한다.
  stance를 넣으면 `STANCE_UNVERIFIED`가 붙고 신뢰도가 0.5로 잘린다.
- **서수형 팩터는 앵커 문구에 대응시킨다.** 애매하면 한 단계 약하게 잡는다.
- **확인 못 한 팩터는 넣지 않는다.** 커버리지가 떨어지는 게 정상이고, 지어내면 경고가 무력해진다.
- **같은 사건에서 나온 팩터는 같은 `fact`를 쓴다.** (호르무즈 → supplyRisk·geopolitics 모두 `"hormuz"`)
  테마로 묶지 않는다. 서로 다른 관측치는 블록이 이미 처리한다.
- **`asof`를 넣는다.** 근거를 확인한 시각. 이 값으로 신선도가 자동 감쇠된다(휴장 시간 제외).
- `note`에는 반드시 숫자를 넣는다.

### 세션마다 챙길 수치

| 지표 | 쓰이는 팩터 |
|---|---|
| 미 10Y 수익률 일간 변화(bp) | NAS100 `usRates`, XAUUSD `realYield`(대용 시 conf ≤ 0.6) |
| 독 10Y와의 스프레드 변화(bp) | EURUSD `rateDiff` |
| DXY 일간 변화(%) | 3개 자산 `dollar` |
| VIX 일간 변화(pt) | NAS100·EURUSD `riskAppetite` |
| 상승종목 비율(%) | NAS100 `breadth` |
| 10Y 기대인플레(BEI) 변화(bp) | XAUUSD `inflation` |
| EIA 재고 컨센서스 대비 서프라이즈(백만 배럴) | USOIL `inventory` |

> 이 환경에서는 FMP MCP의 chart/quote/economics가 현재 플랜에서 막혀 있고 외부 시세 API도
> 네트워크 정책상 직접 호출되지 않는다. 그래서 수치는 **웹 검색 결과**로 채운다.
> 출처가 서로 어긋나면 `confidence`를 낮추고 note에 상충 사실을 적는다.

## 2. 관측 레벨

```jsonc
"levels": { "last": 84.67, "prevClose": 83.59, "support": [82.5], "resistance": [85],
            "note": "전일 대비 +1.29%", "source": "..." }
```

- `last`는 **필수**다. 예측 기준가로도 쓰이므로 없으면 채점을 못 한다.
- `prevClose`가 없으면 위치 레이어만 꺼진다(오류 아님).
- 지지·저항은 **기사에 인용된 숫자만** 넣는다. 지어내지 않는다.

## 3. 이벤트

앞으로 48시간 내 지표만 넣는다. 티어 기준은 ruleset §5.
시각은 ISO8601에 오프셋을 붙인다(`2026-08-07T12:30:00Z`).

## 4. (선택) 차트 레이어

번들을 붙일 수 있는 날에만 한다. 평소에는 건너뛴다.

```bash
npm run bundle -- --asset XAUUSD --zip ~/bundles/xauusd.zip
```

붙인 자산은 `"mode": "fusion"`으로 바꿔야 캔들이 실제로 쓰인다.

## 5. 스냅샷 생성

```bash
npm run snapshot -- --input data/session/latest.json          # macro.json 갱신 + 기록·채점
npm run snapshot -- --input data/session/latest.json --print  # 파일 안 쓰고 확인만
npm run snapshot -- --input data/session/latest.json --no-history   # 기록 건너뛰기(리허설)
```

검증에 걸리면 그대로 멈춘다. 출력에서 확인할 것:

- **레짐** — `요인 상충`이면 그 자산은 그날 방향 없음이다
- **플래그**
  - `STANCE_UNVERIFIED` → 수치형에 value를 안 넣었다. 고쳐서 다시 돌린다
  - `MACRO_COVERAGE_LOW` → 팩터를 더 채우거나, 못 채우면 그대로 두고 확신도가 낮게 나가게 둔다
  - `BLOCK_CAPPED` → 근거가 한 진영에 몰렸다는 뜻. 정상 동작이다
  - `DUPLICATE_FACT` → 같은 사건이 두 팩터에 들어가 자동 감쇠됐다. 의도한 것이면 그대로 둔다
  - `POSITION_UNAVAILABLE` → prevClose가 없다
- **확신도** — macro-only는 25 미만이면 중립으로 강등되고 상한은 70이다
- **적중률 줄** — 채점이 시작되면 함께 출력된다

## 6. 커밋과 배포

```bash
git add macro-desk/public/macro.json macro-desk/data/session/latest.json macro-desk/data/history/predictions.jsonl
git commit -m "chore: refresh macro desk <아침|오후|야간> snapshot"
git push -u origin main
```

`main`에 들어가면 `.github/workflows/macro-desk-pages.yml`이 Pages를 재배포한다.
**`predictions.jsonl`을 반드시 함께 커밋한다.** 이게 빠지면 다음 실행에서 채점할 대상이 사라진다.

## 7. 검증

```bash
npm run check   # 타입
npm test        # 엔진 테스트 138개
npm run build   # 프로덕션 번들
```

---

## 부록. 예약 작업 프롬프트

세션마다 아래 지시를 따른다.

```
NAS100·XAUUSD·USOIL·EURUSD의 당일 방향성 스냅샷을 갱신한다.

1. main 브랜치에서 작업한다 (Pages 배포가 main 푸시에만 동작).
2. docs/fusion-ruleset.md §1.3 루브릭의 팩터 키만 쓴다.
   - 수치형은 value(지표 실측치)만 넣는다. stance를 직접 넣지 않는다.
   - 서수형은 앵커 문구에 대응시킨다.
   - 같은 사건에서 나온 팩터끼리는 같은 fact를 쓴다.
   - asof(근거 확인 시각)를 넣는다.
   - 확인 못 한 팩터는 넣지 않는다.
3. levels에 last(필수)·prevClose와, 기사에 인용된 지지·저항만 넣는다.
4. 48시간 내 지표를 events에 넣는다.
5. npm run snapshot 을 돌리고 플래그를 확인한다.
   STANCE_UNVERIFIED가 뜨면 value로 고쳐 다시 돌린다.
6. macro.json · latest.json · predictions.jsonl 세 파일을 커밋해 main에 푸시한다.
7. 자산별 한 줄 요약과 적중률로 답변을 끝낸다.
```
