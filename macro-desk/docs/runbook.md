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

| 지표 | 쓰이는 팩터 | 출처 |
|---|---|---|
| 미 10Y 수익률 일간 변화(bp) | NAS100 `usRates`, XAUUSD `realYield`(대용 시 conf ≤ 0.6) | 피드 |
| 독 10Y와의 스프레드 변화(bp) | EURUSD `rateDiff` | 피드 (ECB 유로존 AAA 10Y) |
| DXY 일간 변화(%) | 3개 자산 `dollar` | 피드 |
| VIX 일간 변화(pt) | NAS100·EURUSD `riskAppetite` | 피드 |
| 상승종목 비율(%) | NAS100 `breadth` | 피드 (전종목 집계) |
| 원유 재고 컨센서스 대비 서프라이즈(백만 배럴) | USOIL `inventory` | 피드 (EIA 우선, 없으면 API) |
| 10Y 기대인플레(BEI) 변화(bp) | XAUUSD `inflation` | **웹** — FRED 접속 불가 |
| 10Y 실질금리 변화(bp) | XAUUSD `realYield` | **웹** — FRED 접속 불가 |

서수형 팩터(`fedPolicy`·`safeHaven`·`opec`·`geopolitics`·`ecbPolicy` 등)는
그대로 웹 리서치로 판단한다. 피드는 숫자만 주므로 이쪽은 바뀌지 않는다.

### 수치 출처 — 피드를 먼저 읽는다

**`macro-desk/data/feed.json`** (저장소 안의 로컬 파일)

자산 인사이트가 장 시간에 맞춰 수집한 숫자다(평일 07:20~08:20 · 20:50~22:50 KST).

**URL로 직접 받으려 하지 마라.** 루틴 세션은 프록시 정책상 외부 호스트를
못 읽는다 — `enair840926-star.github.io/insight/feed.json`을 시도했다가 403을
받고 전량 웹 검색으로 되돌아간 회차가 있다. `Sync Insight Feed` 워크플로가
세션 40분 전에 받아 저장소에 커밋해 두므로, 클론된 로컬 파일만 읽으면 된다.

파일이 없거나 `collectedAt`이 낡았으면 동기화가 실패한 것이다. 그 사실을
`note`에 적고 그 회차는 웹 검색으로 채운다.

```jsonc
"factors": {
  "usRates":  { "value": 0.8, "unit": "bp", "fact": "미 10년물 4.635% (전일 4.627%)",
                "source": "Yahoo ^TNX", "asof": "2026-08-05T22:26:55" }
}
"missing": [ { "key": "realYield", "reason": "FRED 접속 불가 — 직접 확인 필요" } ]
```

- `factors`의 `value`를 **그대로** 쓴다. 단위가 이미 이 표와 맞춰져 있다.
- **`stance`는 오지 않는다.** 의도한 것이다 — 피드는 숫자만 주고 판정은 엔진이 한다.
  판정까지 받아 오면 스코어보드가 채점하는 대상이 우리 룰셋이 아니게 된다.
- `fact`·`source`·`asof`를 그대로 옮긴다. 출처를 다시 쓰지 않는다.
- **`missing`에 있는 것만 웹으로 찾는다.** 피드에 있는 값을 웹에서 다시 찾아
  다른 숫자를 쓰면 재현이 안 된다.
- 피드가 12시간 넘게 낡았으면(`collectedAt` 확인) 그 사실을 `note`에 적고
  해당 팩터의 `confidence`를 낮춘다.
- `context`는 팩터가 아니다. 재고 수준·공포탐욕·금리커브가 들어 있다.
  단위가 팩터와 다르므로 `value`로 쓰지 않는다.

- **`context.news`는 서수형 팩터의 원재료다.** 매크로 뉴스 400여 건에서
  추린 30건이 제목·날짜·출처·주제와 함께 온다. `fedPolicy`·`safeHaven`·
  `opec`·`geopolitics`·`ecbPolicy`·`supplyRisk`·`demand`를 잡을 때 먼저 읽는다.
  호재·악재 판정은 붙어 있지 않다 — 의도한 것이고, 판단은 여기서 한다.
  같은 사건이면 `fact`를 공유하는 규칙은 그대로다(호르무즈 → `"hormuz"`).
  뉴스에 없는 팩터는 웹으로 보완하거나 빼둔다.

> 피드에 없는 수치는 여전히 **웹 검색 결과**로 채운다. FMP MCP의
> chart/quote/economics는 현재 플랜에서 막혀 있고 시세 API도 직접 호출되지 않는다.
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
```

**`predictions.jsonl`을 반드시 함께 커밋한다.** 이게 빠지면 다음 실행에서 채점할 대상이 사라진다.

### 푸시 — 두 경로

```bash
git push origin HEAD:main || git push -f origin HEAD:claude/macro-data
```

`main`에 직접 들어가면 `.github/workflows/macro-desk-pages.yml`이 Pages를 재배포한다.

**main 푸시가 거부되면** `claude/macro-data`로 보낸다. 예약 루틴 세션은 저장소를 클론만
할 수 있고 `claude/` 접두 브랜치에만 푸시할 수 있는 경우가 있다 — 그때 403이 난다.
이 브랜치에 푸시되면 `.github/workflows/macro-data-sync.yml`이 **데이터 파일만** main으로
옮기고 Pages를 배포한다. 옮기는 경로는 아래로 고정되어 있어 엔진 코드는 절대 넘어가지 않는다.

| 경로 | 쓰는 쪽 |
|---|---|
| `macro-desk/public/macro.json` | 스냅샷 |
| `macro-desk/data/**` | 스냅샷 (입력·예측 기록) |
| `macro-desk/src/engine/params.json` | 주간 보정 |
| `macro-desk/docs/calibration/**` | 주간 보정 |

루틴 세션은 **항상 기본 브랜치를 클론**한다. 그래서 기록을 브랜치에 남겨두면 다음 실행이
이전 예측을 채점하지 못한다. 반드시 main으로 되돌아가야 한다 — 워크플로가 그 일을 한다.

## 7. 주간 보정

일요일 10:00 KST에 별도 루틴이 돈다. 수동으로 돌리려면:

```bash
npm run calibrate -- --dry   # 계산만 확인
npm run calibrate            # 중립밴드 자동 적용 + 리포트 생성
```

중립밴드만 자동으로 갱신되고, 확신도·게이트·가중치는 리포트 제안으로만 남는다.
절차는 [`calibration.md`](calibration.md) 참고.

## 8. 검증

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

1. main 브랜치에서 작업한다. 푸시는 main을 먼저 시도하고, 거부되면
   claude/macro-data로 보낸다 (워크플로가 데이터만 main으로 옮긴다).
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
6. macro.json · latest.json · predictions.jsonl 세 파일을 커밋해 푸시한다.
   git push origin HEAD:main || git push -f origin HEAD:claude/macro-data
7. 자산별 한 줄 요약과 적중률로 답변을 끝낸다.
```
