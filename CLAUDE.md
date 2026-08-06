# 매크로 데스크 — 작업 지침

NAS100·XAUUSD·USOIL·EURUSD의 당일 방향성을 매크로 요인으로만 판정한다.
하루 3회(08:00 · 16:00 · 22:00 KST).

배포: https://enair840926-star.github.io/-/

---

## 먼저 읽을 것

- `macro-desk/docs/runbook.md` — 운영 절차. 팩터 수집 규율이 여기 있다.
- `macro-desk/docs/fusion-ruleset.md` — 규칙서. 밴드표·점수식.
- 원본은 `macro-desk/src/engine/weights.ts`.

---

## 이 프로젝트의 경계

### 판정은 엔진이 한다

`MacroFactorInput`은 `stance`(-2~+2)와 `value`(숫자)를 둘 다 받는다.
**수치형 팩터에는 `value`만 넣는다.** stance를 직접 넣으면
`STANCE_UNVERIFIED`가 붙고 신뢰도가 0.5로 잘린다.

이게 이 시스템의 핵심이다. `data/history/predictions.jsonl`과
`calibrate.ts`가 예측을 기록하고 사후에 채점하는데, 판정을 밖에서
받아 오면 채점 대상이 우리 룰셋이 아니게 되어 그 이력이 뜻을 잃는다.

### 확인 못 한 팩터는 넣지 않는다

커버리지가 떨어지는 게 정상이다. 지어내면 경고가 무력해진다.

### 루틴은 외부 호스트를 못 읽는다

프록시 정책 때문이다. `feed.json`을 URL로 받으려다 403을 맞고 전량
웹 검색으로 되돌아간 회차가 있다. 러너는 프록시 밖이므로
`Sync Insight Feed` 워크플로가 받아 저장소에 커밋한다.

**루틴은 `macro-desk/data/feed.json`(로컬 파일)만 읽는다.**

---

## 자산 인사이트와의 관계

`enair840926-star/insight`가 장 시간에 맞춰 수집한 숫자를 피드로 준다.
두 시스템은 **숫자만 공유하고 판단은 각자 한다.**

| 오는 것 | 쓰임 |
|---|---|
| `factors` 6개 | 수치형 팩터의 `value` — 엔진이 밴드로 stance 산출 |
| `levels` | 4개 자산 last/prevClose |
| `context.news` | 서수형 팩터 판단용 원재료 (400여 건에서 추린 30건) |
| `missing` | 못 받은 항목과 이유 — 이것만 웹으로 찾는다 |

**오지 않는 것**: `stance`, 호재·악재 판정, 기사 본문. 의도한 것이다.

판단이 갈리는 것 자체가 정보다. 예를 들어 유가를 두고 이쪽은 주간
서프라이즈를 보고 하락으로, 자산 인사이트는 재고 수준과 선물커브를
보고 상방 우위로 읽은 적이 있다. 층위가 다른 것이지 어느 하나가
틀린 게 아니다.

FRED가 막혀 `realYield`·`inflation`은 계속 웹으로 채운다.
`inventory`는 API(화)·EIA(수) 발표일에만 온다 — 다른 요일에 빠지는
것은 정상이다.

---

## 브랜치와 배포

예약 루틴 세션은 main으로 직접 푸시하지 못하고 `claude/` 접두 브랜치만
쓴다. `macro-data-sync.yml`이 **데이터 파일만** main으로 옮긴다.

```
macro-desk/public/macro.json
macro-desk/data
macro-desk/src/engine/params.json
macro-desk/docs/calibration
```

이 허용 목록 밖은 넘어가지 않는다. **엔진 코드는 루틴이 고쳐도 main에
반영되지 않는다** — 의도한 장치다.

배포는 `macro-data-sync`가 끝난 뒤 `Deploy Macro Desk`가 `workflow_run`
으로 이어받는다. `github-pages` 환경이 main만 허용하기 때문이다.

---

## 커밋 메시지

무엇을 바꿨는지가 아니라 **왜 바꿨는지**를 쓴다. 실측값이 있으면 넣는다.
