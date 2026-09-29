# Via Romana

유럽에 남아 있는 로마 유적을 지도에서 찾아보는 재미용 프로젝트.

## 지금 되는 것

- [Pleiades](https://pleiades.stoa.org) 기반 유럽 로마 유적 약 1만 곳, 9개 분류
- 분류별 켜기·끄기, 유적이 남아 있는 곳만 보기
- **하루 행군**: 출발점을 고르면 로마 군단 하루 행군 거리(20 로마마일 ≈ 29.6km) 안의 유적을 가까운 순으로
- 지도·위성 배경 전환, 유적별 Pleiades 링크와 길찾기

## 구조

```
via-romana/
├── app/
│   ├── main.py          # FastAPI (API + 지도 페이지)
│   ├── categories.py    # 유적 분류·색 정의
│   └── static/          # Leaflet 지도 (index.html, app.js, style.css)
├── scripts/
│   └── build_sites.py   # Pleiades 원본 → data/processed/sites.geojson
├── data/
│   ├── raw/             # 원본 (git 제외, 스크립트가 내려받음)
│   └── processed/       # 가공본 (커밋)
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

데이터를 새로 만들 때만:

```bash
python scripts/build_sites.py            # 원본이 없으면 내려받음 (약 38MB)
python scripts/build_sites.py --refresh  # 원본을 새로 받아서 다시 가공
```

## API

| 경로 | 설명 |
|---|---|
| `GET /api/meta` | 분류 목록(이름·색·건수), 출처, 하루 행군 거리 |
| `GET /api/sites?cat=arena,water&visible=true&bbox=서,남,동,북` | 유적 GeoJSON |
| `GET /api/sites/{id}` | 유적 하나 (id는 Pleiades ID) |
| `GET /api/near?lat=43.84&lon=4.36&km=29.6` | 반경 안 유적, 가까운 순 |
| `GET /healthz` | 상태 확인 (Render 헬스체크) |

분류 키: `arena` 원형극장·극장, `water` 수도교·목욕탕, `military` 요새·성벽, `sacred` 신전·성소, `villa` 빌라, `road` 다리·도로 시설, `burial` 무덤·기념물, `industry` 광산·항구·생산지, `town` 도시·정착지

## Render 배포

1. Render 대시보드에서 **New → Blueprint** 를 고르고 이 저장소를 연결
2. `render.yaml`이 자동으로 읽힘 → **Apply**
3. 이후 `main` 브랜치에 푸시할 때마다 자동 배포

무료 플랜은 한동안 접속이 없으면 잠들었다가, 다음 접속 때 깨어나느라 첫 로딩이 느릴 수 있다.

## 데이터와 가공 기준

- 출처: Pleiades gazetteer, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- 포함 조건
  - Pleiades에서 위치 정밀도가 `precise`인 장소
  - 존속 기간이 기원전 30년 이후 ~ 서기 400년 이전과 겹치는 곳 (원형극장·수도교·목욕탕·빌라는 연대가 없어도 포함)
  - `scripts/build_sites.py`의 대략적인 유럽 경계 다각형 안 (북아프리카·아나톨리아 제외, 에게해 동쪽 일부 섬도 빠짐)
- "유적이 남아 있음"은 Pleiades의 `archaeological_remains`가 substantive·traces·restored인 곳

## 다음 단계

- [ ] 로마 가도 레이어: [Itiner-e](https://doi.org/10.5281/zenodo.17122148) (CC BY 4.0, GeoJSON 78MB → 유럽만 잘라서 단순화)
- [ ] 하드모드: 위치가 불확실한 가도 구간 위에 LiDAR·위성영상 겹쳐 흔적 찾기

## 라이선스

코드는 MIT. `data/processed/`의 데이터는 Pleiades에서 가공한 것으로 CC BY 3.0을 따른다.
