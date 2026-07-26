# Macro Desk

NAS100, XAUUSD, USOIL, EURUSD의 당일 외부·매크로 방향을 한 화면에서 확인하는 모바일 우선 대시보드입니다.

## 동작 구조

- `public/macro.json`: 예약 분석이 갱신하는 단일 데이터 원본
- `src/App.tsx`: 예약 데이터 표시, 세션 유효시간, 수동 방향·메모
- `localStorage`: 수동 설정과 메모를 현재 기기에만 저장
- `.github/workflows/macro-desk-pages.yml`: 변경 시 GitHub Pages 재배포

브라우저에서 AI API를 직접 호출하지 않습니다. API 키 노출과 CORS 문제를 피하기 위해 예약 작업이 `macro.json`을 갱신하고, 화면은 해당 파일을 읽습니다.

## 로컬 실행

```bash
npm ci
npm run dev
```

## 검증

```bash
npm run check
npm run build
```

## GitHub Pages

저장소의 **Settings → Pages → Build and deployment**에서 Source를 **GitHub Actions**로 설정하면 워크플로가 `macro-desk/dist`를 배포합니다.

프로젝트 사이트 기준 경로는 저장소 이름에 맞춰 `/-/`로 설정되어 있습니다.
