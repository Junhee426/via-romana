"""via-romana API.

로컬 실행:  uvicorn app.main:app --reload
Render:     render.yaml의 startCommand 참고
"""

import gzip
import hashlib
import json
import logging
import math
import os
import unicodedata
from pathlib import Path
from xml.sax.saxutils import escape

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from app.categories import CATEGORIES, CATEGORY_BY_KEY, VISIBLE_REMAINS

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "processed"
CURATED = ROOT / "data" / "curated.json"

log = logging.getLogger("via-romana")

# 로마 군단의 표준 하루 행군 거리: 20 로마마일
ROMAN_MILE_KM = 1.48
DAY_MARCH_KM = round(20 * ROMAN_MILE_KM, 1)

# Google 내 지도(My Maps)는 레이어 하나에 2,000곳까지 가져올 수 있다
KML_MAX = 2000

# 있으면 배경 지도를 Google 지도로 쓴다 (Map Tiles API). 브라우저에 그대로
# 노출되는 키이므로 Google Cloud 콘솔에서 사이트 주소(리퍼러)로 제한해 둔다.
GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()

# CARTO 기본 지도 키. 없으면 타일에 "API key required" 워터마크가 찍힌다.
# 어차피 브라우저에 그대로 전달되는 키라 기본값을 코드에 둔다. 환경변수가 있으면 그 값을 쓴다
CARTO_API_KEY = os.environ.get("CARTO_API_KEY", "").strip() or "cb1_441g_1_277638e48694845229389e55"

app = FastAPI(title="via-romana", version="0.1.0")
app.add_middleware(GZipMiddleware, minimum_size=1000)


# 지도 페이지가 불러와도 되는 곳만 적어 둔다 (스크립트는 이 서버와 Leaflet CDN뿐).
# 새 외부 서비스를 붙이면 여기에도 추가해야 한다. style의 'unsafe-inline'은 분류 색(--c) 인라인 스타일 때문
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    # 위키미디어 공용 사진은 upload.·thumb. 등 여러 호스트에서 내려온다
    "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://server.arcgisonline.com"
    " https://tile.googleapis.com https://*.wikimedia.org https://cdnjs.cloudflare.com",
    "connect-src 'self' https://www.wikidata.org https://commons.wikimedia.org"
    " https://*.wikipedia.org https://tile.googleapis.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
])


@app.middleware("http")
async def revalidate_static(request, call_next):
    """지도 파일(html·js·css)은 매번 새 버전인지 확인하게 해서 배포 직후 옛 화면이 남지 않게 한다."""
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    # 지도 페이지에만 붙인다 (/docs의 Swagger 화면은 다른 CDN과 인라인 스크립트를 쓴다)
    if path == "/" or path.endswith(".html"):
        response.headers.setdefault("Content-Security-Policy", CSP)
    return response


def load_sites():
    path = DATA / "sites.geojson"
    if not path.exists():
        raise RuntimeError(
            "data/processed/sites.geojson이 없습니다. "
            "먼저 `python scripts/build_sites.py`를 실행하세요."
        )
    with open(path, encoding="utf-8") as f:
        return json.load(f)["features"]


def load_meta():
    path = DATA / "meta.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def normalize(text: str) -> str:
    """검색용 정규화: 악센트 제거, 소문자, 공백 하나로. app.js의 normalize()와 같은 규칙."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(stripped.lower().split())


def load_curated(sites_by_id):
    """손으로 고른 한국어 별칭과 시작 지역. id·name이 실제 데이터와 맞지 않는 별칭은 버린다."""
    if not CURATED.exists():
        return {}, []
    data = json.loads(CURATED.read_text(encoding="utf-8"))
    aliases = {}
    for a in data.get("aliases", []):
        f = sites_by_id.get(a["id"])
        if not f or f["properties"]["name"] != a["name"]:
            log.warning("별칭을 건너뜀: %s (%s)이 데이터와 맞지 않음", a["id"], a["name"])
            continue
        aliases[a["id"]] = a["ko"]
    return aliases, data.get("regions", [])


SITES = load_sites()
SITES_BY_ID = {f["properties"]["id"]: f for f in SITES}
META = load_meta()
ALIASES, REGIONS = load_curated(SITES_BY_ID)


def korean_names(sites, aliases):
    """유적 ID → 한국어 이름 목록. 손으로 확인한 별칭이 먼저, 그다음 Wikidata 한국어 라벨(겹치면 한 번만)."""
    names = {}
    for f in sites:
        p = f["properties"]
        found = list(aliases.get(p["id"], []))
        label = p.get("ko_label")
        if label and normalize(label) not in {normalize(n) for n in found}:
            found.append(label)
        if found:
            names[p["id"]] = found
    return names


KO_NAMES = korean_names(SITES, ALIASES)

# 검색 대상: 원래 이름 + Pleiades 설명 + 한국어 이름(별칭·Wikidata 라벨) + Pleiades ID
SEARCH_TEXT = {
    f["properties"]["id"]: normalize(" ".join([
        f["properties"]["name"], f["properties"].get("desc") or "", *KO_NAMES.get(f["properties"]["id"], []),
        f["properties"]["id"],
    ]))
    for f in SITES
}


def with_ko(f):
    """응답용 사본: 한국어 이름을 ko 하나로 모은다 (ko_label은 ko에 들어 있으므로 뺀다). 원본 데이터는 그대로."""
    names = KO_NAMES.get(f["properties"]["id"])
    if not names:
        return f
    props = {k: v for k, v in f["properties"].items() if k != "ko_label"}
    return {**f, "properties": {**props, "ko": names}}


SITES_OUT = [with_ko(f) for f in SITES]
SITES_OUT_BY_ID = {f["properties"]["id"]: f for f in SITES_OUT}

# 지도는 항상 필터 없이 전체를 받는다. 요청마다 1만 곳을 직렬화·압축하지 않도록 한 번만 만들어 두고,
# 내용 해시를 ETag로 써서 다시 방문했을 때는 304(본문 없음)로 끝낸다
ALL_SITES_JSON = json.dumps(
    {"type": "FeatureCollection", "features": SITES_OUT}, ensure_ascii=False, separators=(",", ":"),
).encode("utf-8")
ALL_SITES_GZIP = gzip.compress(ALL_SITES_JSON, 9, mtime=0)
ALL_SITES_ETAG = hashlib.sha256(ALL_SITES_JSON).hexdigest()[:20]

_lons = [f["geometry"]["coordinates"][0] for f in SITES]
_lats = [f["geometry"]["coordinates"][1] for f in SITES]
EXTENT = [min(_lons), min(_lats), max(_lons), max(_lats)]   # 서, 남, 동, 북


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_cats(cat: str | None):
    """None(파라미터 없음) = 모든 분류, 빈 문자열(cat=) = 아무 분류도 아님."""
    if cat is None:
        return None
    keys = {c.strip() for c in cat.split(",") if c.strip()}
    unknown = keys - CATEGORY_BY_KEY.keys()
    if unknown:
        raise HTTPException(400, f"알 수 없는 분류: {', '.join(sorted(unknown))}")
    return keys


def parse_q(q: str | None):
    """검색어를 정규화한 단어 목록으로. 모든 단어가 들어 있어야 일치한다."""
    return normalize(q or "").split()


def matches(feature, cats, visible, terms=()):
    props = feature["properties"]
    if cats is not None and props["cat"] not in cats:
        return False
    if visible and props["remains"] not in VISIBLE_REMAINS:
        return False
    if terms:
        text = SEARCH_TEXT[props["id"]]
        if not all(t in text for t in terms):
            return False
    return True


def parse_bbox(bbox: str | None):
    if not bbox:
        return None
    try:
        west, south, east, north = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox 형식은 서,남,동,북 입니다")
    if not all(math.isfinite(v) for v in (west, south, east, north)) or west > east or south > north:
        raise HTTPException(400, "bbox는 서 ≤ 동, 남 ≤ 북인 숫자여야 합니다")
    return west, south, east, north


def in_box(feature, box):
    lon, lat = feature["geometry"]["coordinates"]
    return box[0] <= lon <= box[2] and box[1] <= lat <= box[3]


def search_near(lat, lon, km, cats, visible, terms=()):
    """반경 안의 유적을 (거리, feature) 목록으로, 가까운 순."""
    # 위도·경도 상자로 먼저 거르고 정확한 거리를 계산
    dlat = km / 111.0
    dlon = km / (111.0 * max(math.cos(math.radians(lat)), 0.01))
    found = []
    for f in SITES:
        flon, flat = f["geometry"]["coordinates"]
        if abs(flat - lat) > dlat or abs(flon - lon) > dlon:
            continue
        if not matches(f, cats, visible, terms):
            continue
        d = haversine_km(lat, lon, flat, flon)
        if d <= km:
            found.append((d, f))
    found.sort(key=lambda x: x[0])
    return found


@app.get("/healthz")
def healthz():
    return {"ok": True, "sites": len(SITES)}


@app.get("/api/meta")
def meta():
    """분류 목록(이름·색·건수), 데이터 출처, 하루 행군 거리."""
    counts = META.get("by_category", {})
    return {
        "total": len(SITES),
        "built_at": META.get("built_at"),
        "sources": META.get("sources", []),
        "day_march_km": DAY_MARCH_KM,
        "roman_mile_km": ROMAN_MILE_KM,
        "kml_max": KML_MAX,
        "google_maps_key": GOOGLE_MAPS_API_KEY or None,
        "carto_key": CARTO_API_KEY or None,
        "extent": EXTENT,
        "regions": REGIONS,
        "categories": [
            {"key": c["key"], "label": c["label"], "color": c["color"],
             "count": counts.get(c["key"], 0)}
            for c in CATEGORIES
        ],
    }


def all_sites_response(request: Request):
    """미리 만들어 둔 전체 목록. ETag가 같으면 304, gzip을 받는 클라이언트에는 미리 압축한 본문."""
    accepts_gzip = "gzip" in request.headers.get("accept-encoding", "")
    # 압축본과 원본은 바이트가 다르므로 ETag도 구분한다
    etag = f'"{ALL_SITES_ETAG}{"-gz" if accepts_gzip else ""}"'
    headers = {"ETag": etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
    candidates = {t.strip().removeprefix("W/") for t in request.headers.get("if-none-match", "").split(",")}
    if etag in candidates:
        return Response(status_code=304, headers=headers)
    if accepts_gzip:
        return Response(ALL_SITES_GZIP, media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})
    return Response(ALL_SITES_JSON, media_type="application/json", headers=headers)


@app.get("/api/sites")
def sites(
    request: Request,
    cat: str | None = Query(None, description="분류 키, 쉼표로 여러 개 (예: arena,water)"),
    visible: bool = Query(False, description="유적이 남아 있는 곳만"),
    bbox: str | None = Query(None, description="서,남,동,북 (경도·위도)"),
    q: str | None = Query(None, description="검색어: 이름·설명·한국어 별칭·Pleiades ID에 모든 단어가 들어 있는 유적"),
):
    """유적 목록을 GeoJSON FeatureCollection으로 돌려준다. 한국어 이름(별칭·Wikidata 라벨)이 있으면 ko 속성."""
    if cat is None and not visible and not bbox and not (q or "").strip():
        return all_sites_response(request)
    cats = parse_cats(cat)
    box = parse_bbox(bbox)
    terms = parse_q(q)
    result = [
        out for f, out in zip(SITES, SITES_OUT)
        if matches(f, cats, visible, terms) and (box is None or in_box(f, box))
    ]
    return {"type": "FeatureCollection", "features": result}


@app.get("/api/sites/{site_id}")
def site(site_id: str):
    f = SITES_OUT_BY_ID.get(site_id)
    if not f:
        raise HTTPException(404, "해당 유적이 없습니다")
    return f


@app.get("/api/near")
def near(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    km: float = Query(DAY_MARCH_KM, gt=0, le=300, description="반경(km), 기본값은 하루 행군 거리"),
    cat: str | None = None,
    visible: bool = False,
    limit: int = Query(50, ge=1, le=500),
    q: str | None = Query(None, description="검색어: 이름·설명·한국어 별칭·Pleiades ID에 모든 단어가 들어 있는 유적"),
):
    """한 지점에서 반경 안의 유적을 가까운 순으로."""
    found = search_near(lat, lon, km, parse_cats(cat), visible, parse_q(q))
    return {
        "center": [lon, lat],
        "km": km,
        "count": len(found),
        "sites": [
            {**f["properties"], "coordinates": f["geometry"]["coordinates"],
             "distance_km": round(d, 2),
             **({"ko": KO_NAMES[f["properties"]["id"]]} if f["properties"]["id"] in KO_NAMES else {})}
            for d, f in found[:limit]
        ],
    }


def kml_color(hex_color):
    """#RRGGBB → KML의 aabbggrr."""
    r, g, b = hex_color[1:3], hex_color[3:5], hex_color[5:7]
    return f"ff{b}{g}{r}".lower()


def to_kml(features, title):
    styles = "".join(
        f'<Style id="{c["key"]}"><IconStyle><color>{kml_color(c["color"])}</color>'
        f"<Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>"
        f"</IconStyle></Style>"
        for c in CATEGORIES
    )
    folders = []
    for c in CATEGORIES:
        marks = []
        for f in features:
            p = f["properties"]
            if p["cat"] != c["key"]:
                continue
            lon, lat = f["geometry"]["coordinates"]
            desc = f'{p.get("desc") or ""}\nhttps://pleiades.stoa.org/places/{p["id"]}'.strip()
            marks.append(
                f"<Placemark><name>{escape(p['name'])}</name>"
                f"<description>{escape(desc)}</description>"
                f"<styleUrl>#{c['key']}</styleUrl>"
                f"<Point><coordinates>{lon},{lat}</coordinates></Point></Placemark>"
            )
        if marks:
            folders.append(f"<Folder><name>{escape(c['label'])}</name>{''.join(marks)}</Folder>")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        f"<name>{escape(title)}</name>{styles}{''.join(folders)}</Document></kml>"
    )


@app.get("/api/export.kml")
def export_kml(
    cat: str | None = None,
    visible: bool = False,
    bbox: str | None = Query(None, description="서,남,동,북: 이 범위 안의 유적"),
    lat: float | None = Query(None, ge=-90, le=90),
    lon: float | None = Query(None, ge=-180, le=180),
    km: float = Query(DAY_MARCH_KM, gt=0, le=300),
    q: str | None = Query(None, description="검색어: 이름·설명·한국어 별칭·Pleiades ID에 모든 단어가 들어 있는 유적"),
):
    """Google 내 지도(My Maps)로 가져갈 KML. bbox 또는 lat·lon(반경 km) 중 하나."""
    cats = parse_cats(cat)
    terms = parse_q(q)
    if lat is not None and lon is not None:
        features = [f for _, f in search_near(lat, lon, km, cats, visible, terms)]
        title = f"Via Romana: 하루 행군 반경 ({km}km)"
    elif bbox:
        box = parse_bbox(bbox)
        features = [f for f in SITES if matches(f, cats, visible, terms) and in_box(f, box)]
        title = "Via Romana: 로마 유적"
    else:
        raise HTTPException(400, "bbox 또는 lat·lon이 필요합니다")
    if not features:
        raise HTTPException(404, "조건에 맞는 유적이 없습니다")
    if len(features) > KML_MAX:
        raise HTTPException(
            400, f"유적이 {len(features):,}곳으로 {KML_MAX:,}곳을 넘습니다. 지도를 더 확대해 주세요"
        )
    return Response(
        to_kml(features, title),
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": 'attachment; filename="via-romana.kml"'},
    )


# API 경로를 모두 등록한 뒤에 정적 파일(지도)을 루트에 붙인다
app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
