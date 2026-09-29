"""via-romana API.

로컬 실행:  uvicorn app.main:app --reload
Render:     render.yaml의 startCommand 참고
"""

import json
import math
import os
from pathlib import Path
from xml.sax.saxutils import escape

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from app.categories import CATEGORIES, CATEGORY_BY_KEY, VISIBLE_REMAINS

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "processed"

# 로마 군단의 표준 하루 행군 거리: 20 로마마일
ROMAN_MILE_KM = 1.48
DAY_MARCH_KM = round(20 * ROMAN_MILE_KM, 1)

# Google 내 지도(My Maps)는 레이어 하나에 2,000곳까지 가져올 수 있다
KML_MAX = 2000

# 있으면 배경 지도를 Google 지도로 쓴다 (Map Tiles API). 브라우저에 그대로
# 노출되는 키이므로 Google Cloud 콘솔에서 사이트 주소(리퍼러)로 제한해 둔다.
GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()

app = FastAPI(title="via-romana", version="0.1.0")
app.add_middleware(GZipMiddleware, minimum_size=1000)


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


SITES = load_sites()
SITES_BY_ID = {f["properties"]["id"]: f for f in SITES}
META = load_meta()


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_cats(cat: str | None):
    if not cat:
        return None
    keys = {c.strip() for c in cat.split(",") if c.strip()}
    unknown = keys - CATEGORY_BY_KEY.keys()
    if unknown:
        raise HTTPException(400, f"알 수 없는 분류: {', '.join(sorted(unknown))}")
    return keys


def matches(feature, cats, visible):
    props = feature["properties"]
    if cats and props["cat"] not in cats:
        return False
    if visible and props["remains"] not in VISIBLE_REMAINS:
        return False
    return True


def parse_bbox(bbox: str | None):
    if not bbox:
        return None
    try:
        west, south, east, north = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox 형식은 서,남,동,북 입니다")
    return west, south, east, north


def in_box(feature, box):
    lon, lat = feature["geometry"]["coordinates"]
    return box[0] <= lon <= box[2] and box[1] <= lat <= box[3]


def search_near(lat, lon, km, cats, visible):
    """반경 안의 유적을 (거리, feature) 목록으로, 가까운 순."""
    # 위도·경도 상자로 먼저 거르고 정확한 거리를 계산
    dlat = km / 111.0
    dlon = km / (111.0 * max(math.cos(math.radians(lat)), 0.01))
    found = []
    for f in SITES:
        flon, flat = f["geometry"]["coordinates"]
        if abs(flat - lat) > dlat or abs(flon - lon) > dlon:
            continue
        if not matches(f, cats, visible):
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
        "categories": [
            {"key": c["key"], "label": c["label"], "color": c["color"],
             "count": counts.get(c["key"], 0)}
            for c in CATEGORIES
        ],
    }


@app.get("/api/sites")
def sites(
    cat: str | None = Query(None, description="분류 키, 쉼표로 여러 개 (예: arena,water)"),
    visible: bool = Query(False, description="유적이 남아 있는 곳만"),
    bbox: str | None = Query(None, description="서,남,동,북 (경도·위도)"),
):
    """유적 목록을 GeoJSON FeatureCollection으로 돌려준다."""
    cats = parse_cats(cat)
    box = parse_bbox(bbox)
    result = [
        f for f in SITES
        if matches(f, cats, visible) and (box is None or in_box(f, box))
    ]
    return {"type": "FeatureCollection", "features": result}


@app.get("/api/sites/{site_id}")
def site(site_id: str):
    f = SITES_BY_ID.get(site_id)
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
):
    """한 지점에서 반경 안의 유적을 가까운 순으로."""
    found = search_near(lat, lon, km, parse_cats(cat), visible)
    return {
        "center": [lon, lat],
        "km": km,
        "count": len(found),
        "sites": [
            {**f["properties"], "coordinates": f["geometry"]["coordinates"],
             "distance_km": round(d, 2)}
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
):
    """Google 내 지도(My Maps)로 가져갈 KML. bbox 또는 lat·lon(반경 km) 중 하나."""
    cats = parse_cats(cat)
    if lat is not None and lon is not None:
        features = [f for _, f in search_near(lat, lon, km, cats, visible)]
        title = f"Via Romana: 하루 행군 반경 ({km}km)"
    elif bbox:
        box = parse_bbox(bbox)
        features = [f for f in SITES if matches(f, cats, visible) and in_box(f, box)]
        title = "Via Romana: 로마 유적"
    else:
        raise HTTPException(400, "bbox 또는 lat·lon이 필요합니다")
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
