# Via Romana — Explore the Roman World

유럽에 남아 있는 로마 유적을 지도에서 찾아보는 고고학 지도(archaeological atlas).

> Shape communicates type. Zoom reveals detail. Selection tells a story.

## 지금 되는 것

- [Pleiades](https://pleiades.stoa.org) 기반 유럽 로마 유적 약 1만 곳, 9개 분류
- **고고학 아이콘**: 분류마다 채움형(glyph)·윤곽형(outline) SVG 두 벌, 확대할수록 밀도 → 채움형 → 윤곽형 → 윤곽형+이름으로 정보가 늘어난다
- **박물관 카드**: 유적을 고르면 사진 → 이름 → 분류 아이콘 → 존속 기간 막대 → 남은 정도 → 설명 → 행동 순서의 상세
- **검색**: 상단 검색창에서 유적 이름·Pleiades 설명·Pleiades ID로 찾는다. 대소문자·공백·악센트를 무시하고(`nimes` → Arènes de Nîmes), 확인된 한국어 별칭 20곳(`콜로세움`, `퐁 뒤 가르` 등)도 찾는다
- **시작 지역**: 로마, 폼페이·나폴리만, 프로방스, 트리어, 스플리트·살로나, 메리다, 바스로 바로 이동
- **지도와 동기화된 목록**: 하루 행군 없이도 "지금 지도 범위" 목록을 보고, "전체"·"행군 반경"으로 범위를 바꿀 수 있다. 목록·지도 마커 어느 쪽에서 골라도 같은 상세가 열린다
- **건수 구분**: 조건 일치 N곳(전체 데이터) · 지금 지도 범위 M곳 · 행군 반경 K곳을 따로 보여 준다
- 분류별 켜기·끄기, 유적이 남아 있는 곳만 보기 (남아 있음 = 보존 상태이지 개방·입장 가능 여부가 아님)
- **하루 행군**: 출발점(지도·지도 중심·현재 위치·상세의 "이곳 주변 탐색")에서 20 로마마일 ≈ 29.6km 직선 반경 안의 유적을 가까운 순으로. 실제 도보 거리나 고대 가도 경로가 아니다
- **상세**: 사진·위키백과 요약(한국어 우선, 없으면 영어)·Pleiades 설명, "이곳 주변 탐색"·"구글맵"·"길찾기"
- 로마·지도·위성 배경 전환. "로마"(기본)는 현대 지명을 뺀 지도를 양피지 톤으로 바꾼 것 (Google 지도 키가 있으면 "지도"·"위성"은 Google 지도)
- 지금 지도 범위 또는 행군 반경의 유적을 검색어·분류·유적 상태 필터 그대로 KML로 받아 Google 내 지도로 가져가기

## 화면 흐름

1. **처음**: 검색창에 유적 이름을 넣거나 "시작 지역"을 고른다. 모바일은 아래 시트가 요약 상태로 시작한다
2. **목록**: 검색하면 "전체", 지역·지도 이동은 "지금 지도 범위" 목록. 50곳씩 "더 보기"
3. **상세**: 목록 항목이나 지도 마커를 누르면 상세(모바일은 아래 시트, 넓은 화면은 왼쪽 패널). "← 목록으로"나 Escape로 돌아가면 스크롤·검색·필터가 그대로다
4. **주변 탐색**: 상세의 "이곳 주변 탐색" → 그 유적 중심의 행군 반경 목록
5. **내보내기**: 패널 아래 "KML 파일 받기". 어떤 범위·필터로 몇 곳을 내보내는지 버튼 위에 적혀 있다

작은 마커를 정확히 누르지 않아도 검색·지역·목록으로 모든 기능을 쓸 수 있고, 키보드만으로도(Tab·Enter·Escape) 같은 흐름을 따라갈 수 있다. 출발점 고르기 중에는 지도 위 안내에 "지도 중심에서 출발"과 "취소"가 항상 보인다.

## Archaeological Icon System

분류마다 SVG 두 벌(`app/static/icons/glyph/*.svg`, `app/static/icons/outline/*.svg`, 모두 `viewBox="0 0 24 24"`, 장식용이라 `aria-hidden="true"`).

| 분류 | 모티프 | glyph (16–20px, 채움) | outline (24–32px, 선 1.6) |
|---|---|---|---|
| `town` 도시·정착지 | 포룸·바실리카 | 넓고 낮은 열주 | 박공과 열주 |
| `military` 요새·성벽 | 스쿠툼(방패) | 방패 + 가운데 돌기 | 방패 + 돌기 + 십자 |
| `sacred` 신전·성소 | 신전 | 높은 삼각 박공 | 박공 + 기둥 4개 |
| `arena` 원형극장·극장 | 콜로세움 | 아치가 뚫린 타원 | 2층 아치 |
| `water` 수도교·목욕탕 | 수도교 | 아치 3개 + 물결 | 아치 + 물결 2줄 |
| `road` 다리·도로 시설 | 포장도로 | 원근이 있는 길 + 중앙선 | 포장석 줄눈 |
| `villa` 빌라 | 빌라 | 낮은 박공 주택 | 박공 + 열주 현관 |
| `burial` 무덤·기념물 | 비석(스텔레) | 둥근 머리 비석 + 새김 | 비석 + 새김 줄 |
| `industry` 광산·항구·생산지 | 닻 | 닻 | 닻 + 톱니바퀴 |

- **glyph**: 작은 크기에서 실루엣으로 알아보는 채움형. 지도에서는 분류 색 원 위에 대리석색으로 그리고, 흰 음각 디테일(방패 돌기, 도로 중앙선, 비석 글자)은 배지 색으로 칠해 뚫려 보이게 한다
- **outline**: 건축적 특징이 보이는 윤곽형. 높은 줌에서는 밝은 바탕 + 분류 색 테두리·윤곽(B안)을 쓴다. 분류 색 바탕(A안)은 `?badge=a`로 비교할 수 있다. B안이 채움형 단계와 뚜렷이 구분되고 지도책처럼 가벼워서 기본으로 골랐다
- **레지스트리**: `app/static/js/icons.js`의 `SITE_ICON_PATHS`. 18개를 한 번만 받아 DOM용 `<symbol>` 스프라이트(범례·필터·목록·상세에서 `<use>`)와 지도용 캔버스 배지를 만든다
- **품질 검사**: `cd tests && node e2e/icons.mjs` — 18개를 16/20/24/32px로 렌더링한 시트(`tests/e2e/screenshots/icons-sheet.png`)를 만들고, 헷갈리기 쉬운 쌍(town↔sacred, town↔villa, sacred↔villa, arena↔water, road↔water, burial↔town, industry↔military)의 실루엣 겹침(IoU)이 0.8 이하인지 잰다. 지금 최대값은 glyph town↔sacred 0.66
- 흰 대리석색 아이콘과의 대비를 3:1 이상으로 맞추려고 `villa`(#C49A2C → #9C7A22)와 `town`(#9A9384 → #7D7566)만 같은 안료 계열에서 어둡게 했다

## Zoom Visualization

| Leaflet 줌 | 단계 | 보여 주는 것 |
|---|---|---|
| 3–5 | Density | 16px 격자에 모은 유적 수. 양피지 → 청동 → 로마 적색 (무지개색 히트맵 아님). 칸을 누르면 두 단계 확대 |
| 6–8 | Glyph | 분류 색 배지(22px) + 채움형 아이콘(14px). 라벨 없음 |
| 9–11 | Outline | 밝은 배지(30px) + 윤곽형 아이콘(19px) |
| 12+ | Outline + Label | 윤곽형 + 이름 최대 36개. 라벨 우선순위: 선택 → 목록에서 가리킨 곳 → 남아 있음 → Wikidata 연결. 라벨끼리·다른 배지와 겹치면 생략 |

- 단계는 `visualizationModeForZoom(zoom)` 하나로 정한다. 범례의 "확대 단계"가 지금 단계를 표시한다
- 배지가 겹치면 우선순위가 높은 것만 그린다: 행군 반경 안 → 남아 있음+Wikidata → 남아 있음 → Wikidata → 나머지. 데이터에 없는 역사적 중요도는 만들지 않는다. 겹쳐서 생략된 수는 범례에 "겹친 N곳은 확대하면 보여요"로 알린다
- 진한 배지는 유적이 남아 있는 곳, 흐린 배지는 남은 정도 정보가 없거나 지표에서 보이지 않는 곳
- 선택한 유적은 모든 단계에서 1.18배 배지 + 테두리 두 겹으로 보인다
- glyph ↔ outline은 140ms 겹쳐 바뀐다(모양 모핑은 하지 않음). `prefers-reduced-motion`이면 바로 바뀌고 지도 이동 애니메이션도 끈다

## Roman March

- 출발점에서 **20 로마마일 = 20 × 1.48km = 29.6km** 직선(대원 거리, haversine) 반경 안의 유적을 가까운 순으로 보여 준다. 실제 도보 이동거리나 고대 가도 경로와는 다를 수 있다
- 가운데에 `XX / MP` 이정표, 점선 반경. 반경 안 유적은 밀도 단계로 축소해도 아이콘으로 남는다
- 반경 안의 유적을 고르면 출발점에서 그곳까지 점선과 거리(`XII MP · 17.8km`처럼 로마 숫자 로마마일과 km)를 보여 준다. 목록에는 km와 로마마일을 함께 적는다
- 가도 경로처럼 보이는 선은 그리지 않는다(연결선은 직선 거리 표시)

## Accessibility

- 분류는 항상 **모양 + 색 + 글자**로 전한다. 범례·필터·목록·상세 모두 아이콘 옆에 분류 이름이 있고, 색을 구분하기 어려워도 모양으로 알아볼 수 있다
- 아이콘은 장식(`aria-hidden="true"`), 필터 칩은 `aria-pressed`와 `aria-label`("원형극장·극장 374곳")을 가진다
- 지도 마커를 정확히 누르기 어려우면 목록이 같은 선택으로 이어진다(검색 → 목록 → 상세 → 행동을 키보드만으로 할 수 있음). 마커를 44px로 키우지 않는 대신 주요 버튼은 44×44px 이상
- `prefers-reduced-motion`: 사진 로딩 깜빡임, 아이콘 전환, 지도 이동 애니메이션을 끈다

## Performance

- 유적 1만 곳에 DOM 마커를 만들지 않는다. `app/static/js/canvas-layer.js`의 캔버스 레이어 두 장(유적, 선택·라벨)에 그린다. 화면보다 35% 큰 캔버스를 이동이 끝날 때(`moveend`)만 다시 그린다
- 분류 배지 18종(9 × glyph·outline)은 한 번만 래스터화해 두고 `drawImage`로 찍는다. 아이콘 SVG 요청은 18번뿐이다
- 각 유적의 줌 0 투영 좌표를 한 번만 계산해 두고, 그릴 때 2^zoom만 곱한다
- 레이어 순서(아래 → 위): BASE → DENSITY → ROADS(향후 Itiner-e 가도용, 지금은 빈 pane) → SITES → MARCH → TOP(선택·라벨)
- 측정(1366×768, 헤드리스 Chromium, 두 번 실행): 한 번 그리는 데 밀도 단계(줌 4–5, 격자 437–1,225칸) 1.9–3.9ms, 줌 7 이탈리아 화면(배지 621개, 겹쳐서 생략 2,004곳) 8.2–8.4ms, 줌 10(185개) 2.1–3.0ms, 줌 13(113개 + 라벨 27개) 2.2–2.5ms

## 구조

```
via-romana/
├── app/
│   ├── main.py          # FastAPI (API + 지도 페이지, 검색 정규화)
│   ├── categories.py    # 유적 분류·색 정의
│   └── static/          # Leaflet 지도 (index.html, app.js, style.css)
│       ├── icons/       # glyph/·outline/ 분류 아이콘 SVG 18개
│       └── js/          # icons.js (아이콘 레지스트리), canvas-layer.js (지도 캔버스 레이어)
├── scripts/
│   └── build_sites.py   # Pleiades 원본 → data/processed/sites.geojson
├── data/
│   ├── raw/             # 원본 (git 제외, 스크립트가 내려받음)
│   ├── processed/       # 가공본 (커밋)
│   └── curated.json     # 손으로 확인한 한국어 별칭·시작 지역
├── tests/
│   ├── test_api.py      # API 회귀 테스트 (pytest)
│   ├── e2e/run.mjs      # 브라우저 회귀 테스트 (Playwright, 외부 요청은 가짜 응답)
│   └── e2e/icons.mjs    # 아이콘 품질·실루엣 검사
├── render.yaml          # Render 배포 설정
└── requirements.txt
```

## 로컬 실행

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

- 지도: http://127.0.0.1:8000
- API 문서: http://127.0.0.1:8000/docs

### 테스트

```bash
pip install pytest httpx
python -m pytest tests                 # API·/healthz 회귀 테스트

cd tests && npm install                # Leaflet·Playwright (브라우저는 따로 설치: npx playwright install chromium)
VIA_PYTHON=../.venv/bin/python npm run e2e          # 브라우저 회귀 테스트 전체
VIA_PYTHON=../.venv/bin/python npm run e2e -- KML   # 이름에 'KML'이 들어간 테스트만
```

브라우저 테스트는 지도 타일·글꼴·Wikidata·위키백과·위키미디어 공용 요청을 모두 가짜 응답으로 바꿔서, 외부 서비스 상태와 상관없이 같은 결과가 나온다(타일은 옅은 격자 무늬로 대체되므로 캡처의 배경은 실제 지도가 아니다). 1920×1080, 1366×768, 390×844, 360×800 화면과 줌 4·7·10·13 캡처, 아이콘 시트는 `tests/e2e/screenshots/`에 남는다(git 제외).

데이터를 새로 만들 때만:

```bash
python scripts/build_sites.py            # 원본이 없으면 내려받음 (약 38MB)
python scripts/build_sites.py --refresh  # 원본을 새로 받아서 다시 가공
```

## API

| 경로 | 설명 |
|---|---|
| `GET /api/meta` | 분류 목록(이름·색·건수), 출처, 하루 행군 거리, 시작 지역(`regions`), 데이터 범위(`extent`: 서·남·동·북) |
| `GET /api/sites?cat=arena,water&visible=true&bbox=서,남,동,북&q=검색어` | 유적 GeoJSON. 확인된 한국어 별칭이 있으면 `ko` 속성 |
| `GET /api/sites/{id}` | 유적 하나 (id는 Pleiades ID) |
| `GET /api/near?lat=43.84&lon=4.36&km=29.6&q=…` | 반경 안 유적, 가까운 순 |
| `GET /api/export.kml?bbox=서,남,동,북` 또는 `?lat=…&lon=…&km=…` | Google 내 지도용 KML (최대 2,000곳, `cat`·`visible`·`q` 필터 가능). 0곳이면 404, 상한 초과면 400 |
| `GET /healthz` | 상태 확인 (Render 헬스체크) |

공통 규칙
- `q`: 이름·Pleiades 설명·한국어 별칭을 정규화(악센트 제거, 소문자, 공백 정리)해서, 검색어의 모든 단어가 들어 있는 유적. 브라우저의 `normalize()`와 서버의 `normalize()`가 같은 규칙을 쓴다
- `cat`: 생략하면 모든 분류, **빈 값(`cat=`)이면 아무 분류도 아님(0곳)**. 화면에서 분류를 모두 끄면 API를 부르지 않는다

분류 키: `arena` 원형극장·극장, `water` 수도교·목욕탕, `military` 요새·성벽, `sacred` 신전·성소, `villa` 빌라, `road` 다리·도로 시설, `burial` 무덤·기념물, `industry` 광산·항구·생산지, `town` 도시·정착지

## Render 배포

1. Render 대시보드에서 **New → Blueprint** 를 고르고 이 저장소를 연결
2. `render.yaml`이 자동으로 읽힘 → **Apply**
3. 이후 `main` 브랜치에 푸시할 때마다 자동 배포

### CARTO 지도 키 (기본 배경 지도)

CARTO 지도는 키 없이 쓰면 타일에 "API key required" 워터마크가 찍힌다. 비상업적 사용은 월 500만 타일 요청, 상업적 사용은 월 100만 요청까지 무료다.

키는 `app/main.py`의 `CARTO_API_KEY` 기본값으로 들어 있다 (어차피 브라우저에 그대로 전달되는 키). 바꾸려면:

1. <https://carto.com/basemaps/apikey/> 에서 새 키를 발급 (약관: <https://carto.com/legal/basemap-terms/>)
2. `app/main.py`의 기본값을 고치거나, Render 대시보드 → 서비스 → Environment → `CARTO_API_KEY`에 넣는다 (환경변수가 우선)

### Google 지도 연결

- **링크(설정 필요 없음)**: 유적 상세의 "구글맵"과 "길찾기"는 키 없이 Google 지도 앱·웹으로 연결된다.
- **내 지도로 가져가기(설정 필요 없음)**: 패널의 "KML 파일 받기" → [Google 내 지도](https://www.google.com/maps/d/)에서 새 지도 → 가져오기. 휴대폰 구글맵의 저장됨 → 지도에서도 보인다. 행군 반경이 있으면 그 안, 없으면 지금 지도 범위를 검색어·분류·유적 상태 필터를 적용해 내보낸다. 레이어 하나에 2,000곳까지라 그보다 많으면 지도를 확대하거나 필터를 줄인다. 서버 응답이 KML로 확인된 뒤에만 파일 다운로드를 시작한다.
- **배경 지도를 Google 지도로(선택)**: 환경변수 `GOOGLE_MAPS_API_KEY`가 있으면 "지도"·"위성" 배경이 Google 지도로 바뀐다. 없거나 키가 거부되면 기존 CARTO·Esri 지도를 그대로 쓴다.
  1. [Google Cloud 콘솔](https://console.cloud.google.com/)에서 프로젝트를 만들고 결제 계정을 연결
  2. API 및 서비스 → 라이브러리 → **Map Tiles API** 사용 설정
  3. 사용자 인증 정보 → API 키 만들기 → 키 제한
     - 애플리케이션 제한: **웹사이트**, `https://via-romana.onrender.com/*` (로컬에서 쓰려면 `http://127.0.0.1:8000/*`도)
     - API 제한: **Map Tiles API**만
  4. Render 대시보드 → 서비스 → Environment → `GOOGLE_MAPS_API_KEY`에 키 입력 → 저장(자동 재배포)

  키는 브라우저에 그대로 전달되므로 위의 리퍼러·API 제한을 반드시 걸어 둔다. 무료 사용량을 넘기면 요금이 나오니 Cloud 콘솔에서 할당량(일일 요청 수) 상한도 정해 두면 안전하다.

무료 플랜은 한동안 접속이 없으면 잠들었다가, 다음 접속 때 깨어나느라 첫 로딩이 느릴 수 있다.

## 데이터와 가공 기준

- 출처: Pleiades gazetteer, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- 포함 조건
  - Pleiades에서 위치 정밀도가 `precise`인 장소
  - 존속 기간이 기원전 30년 이후 ~ 서기 400년 이전과 겹치는 곳 (원형극장·수도교·목욕탕·빌라는 연대가 없어도 포함)
  - `scripts/build_sites.py`의 대략적인 유럽 경계 다각형 안 (북아프리카·아나톨리아 제외, 에게해 동쪽 일부 섬도 빠짐)
- Wikidata 연결은 Pleiades가 관리하는 연결표(`data/indexes/wikidata.json`)에서 가져와 `wd` 속성에 넣는다. 사진·설명 자체는 저장하지 않고, 팝업을 열 때 브라우저가 Wikidata·위키백과·위키미디어 공용 API에서 바로 불러온다 (키 필요 없음). 사진마다 저작자·라이선스를 함께 표시한다
- "유적이 남아 있음"은 Pleiades의 `archaeological_remains`가 substantive·traces·restored인 곳. 개방 중·입장 가능·방문 추천이라는 뜻은 아니다
- 사진은 그 유적의 Wikidata 항목에 등록된 대표 사진(P18)만 쓴다. 위키백과 문서 썸네일처럼 다른 대상일 수 있는 사진은 쓰지 않는다
- `data/curated.json`의 한국어 별칭은 Pleiades ID와 원래 이름을 함께 적어 두고, 서버가 시작할 때 둘이 실제 데이터와 맞는지 확인해 맞지 않는 항목은 버린다. 원본 GeoJSON의 이름·ID는 바꾸지 않는다

## 다음 단계

- [ ] 즐겨찾기, 공유 URL(선택 유적·지도 위치), 방문 기록
- [ ] 행군 반경 직접 선택 (지금은 20 로마마일 고정)
- [ ] 시대(연대) 필터와 시간 흐름 보기 (존속 기간 막대는 상세에 있음)
- [ ] 밀도 표현 다듬기 (예: Tabula Peutingeriana에서 영감을 받은 표현)
- [ ] 로마 가도 레이어: [Itiner-e](https://doi.org/10.5281/zenodo.17122148) (CC BY 4.0, GeoJSON 78MB → 유럽만 잘라서 단순화). 지도에 `roads` pane(DENSITY와 SITES 사이)을 미리 만들어 두었다
- [ ] 하드모드: 위치가 불확실한 가도 구간 위에 LiDAR·위성영상 겹쳐 흔적 찾기

## 라이선스

코드는 MIT. `data/processed/`의 데이터는 Pleiades에서 가공한 것으로 CC BY 3.0을 따른다.
