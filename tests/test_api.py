"""API 회귀 테스트. 저장소의 로컬 데이터만 쓰고 외부 서비스에 접속하지 않는다.

    pip install -r requirements.txt pytest httpx
    python -m pytest tests
"""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import ALIASES, REGIONS, SITES, app, normalize

ROOT = Path(__file__).resolve().parent.parent
client = TestClient(app)


def count(path, **params):
    r = client.get(path, params=params)
    assert r.status_code == 200, r.text
    return len(r.json()["features"])


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "sites": 10580}


def test_static_assets_revalidate():
    for path in ["/", "/app.js", "/style.css"]:
        r = client.get(path)
        assert r.status_code == 200
        assert r.headers["cache-control"] == "no-cache"


def test_meta_keeps_existing_fields_and_adds_regions():
    m = client.get("/api/meta").json()
    for key in ["total", "built_at", "sources", "day_march_km", "roman_mile_km", "kml_max", "categories", "carto_key"]:
        assert key in m
    assert m["day_march_km"] == 29.6
    assert m["roman_mile_km"] == 1.48
    assert m["kml_max"] == 2000
    assert len(m["categories"]) == 9
    assert m["regions"] and len(m["extent"]) == 4


def test_sites_unfiltered_and_filters():
    assert count("/api/sites") == 10580
    assert count("/api/sites", cat="arena") == 374
    assert count("/api/sites", cat="arena,water") == 374 + 354
    assert 0 < count("/api/sites", visible="true") < 10580
    assert 0 < count("/api/sites", bbox="12.4,41.8,12.6,42.0") < 10580


def test_empty_cat_means_no_category_not_all():
    assert count("/api/sites", cat="") == 0


def test_unknown_category_and_bad_bbox_are_400():
    assert client.get("/api/sites", params={"cat": "nope"}).status_code == 400
    assert client.get("/api/sites", params={"bbox": "a,b"}).status_code == 400


def test_original_geojson_names_and_ids_unchanged():
    data = json.loads((ROOT / "data/processed/sites.geojson").read_text(encoding="utf-8"))
    served = client.get("/api/sites").json()["features"]
    assert [f["properties"]["id"] for f in served] == [f["properties"]["id"] for f in data["features"]]
    assert [f["properties"]["name"] for f in served] == [f["properties"]["name"] for f in data["features"]]
    assert "ko" not in data["features"][0]["properties"]


@pytest.mark.parametrize("q,expected_id", [
    ("콜로세움", "285857974"),
    ("colosseum", None),            # 원문 설명에 'Colosseum'이 있으면 잡히고, 없으면 0 (가정하지 않음)
    ("nimes", "356648400"),         # Arènes de Nîmes: 악센트 무시
    ("ARÈNES DE NÎMES", "356648400"),
    ("pont   du  gard", "149496"),
    ("퐁 뒤 가르", "149496"),
])
def test_search(q, expected_id):
    ids = [f["properties"]["id"] for f in client.get("/api/sites", params={"q": q}).json()["features"]]
    if expected_id:
        assert expected_id in ids


def test_search_combines_with_filters():
    q = "amphitheat"
    all_ = count("/api/sites", q=q)
    arena = count("/api/sites", q=q, cat="arena")
    visible = count("/api/sites", q=q, cat="arena", visible="true")
    assert all_ >= arena >= visible > 0


def test_aliases_are_verified_and_served():
    curated = json.loads((ROOT / "data/curated.json").read_text(encoding="utf-8"))
    assert len(ALIASES) == len(curated["aliases"]), "모든 별칭의 id·name이 실제 데이터와 맞아야 한다"
    colosseum = client.get("/api/sites", params={"q": "콜로세움"}).json()["features"][0]
    assert colosseum["properties"]["ko"] == ["콜로세움", "콜로세오"]


def test_regions_have_sites_nearby():
    for r in REGIONS:
        lat, lon = r["center"]
        near = client.get("/api/near", params={"lat": lat, "lon": lon, "km": 15, "limit": 1}).json()
        assert near["count"] >= 10, r["label"]


def test_near_keeps_shape_and_supports_q():
    r = client.get("/api/near", params={"lat": 41.8902, "lon": 12.4922, "limit": 3}).json()
    assert r["km"] == 29.6 and r["count"] > 100 and len(r["sites"]) == 3
    first = r["sites"][0]
    assert first["id"] == "285857974" and "distance_km" in first and "coordinates" in first
    q = client.get("/api/near", params={"lat": 41.8902, "lon": 12.4922, "q": "circus"}).json()
    assert 0 < q["count"] < r["count"]
    assert client.get("/api/near", params={"lat": 41.89, "lon": 12.49, "cat": ""}).json()["count"] == 0


def test_near_is_sorted_and_within_radius():
    r = client.get("/api/near", params={"lat": 43.84, "lon": 4.36, "km": 29.6, "limit": 500}).json()
    d = [s["distance_km"] for s in r["sites"]]
    assert d == sorted(d) and max(d) <= 29.6


def test_export_kml_ok_and_errors():
    r = client.get("/api/export.kml", params={"bbox": "12.4,41.8,12.6,42.0", "q": "theat"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.google-earth.kml+xml")
    assert r.text.startswith("<?xml") and "<Placemark>" in r.text
    assert client.get("/api/export.kml").status_code == 400
    assert client.get("/api/export.kml", params={"bbox": "-10,35,30,60"}).status_code == 400   # 상한 초과
    assert client.get("/api/export.kml", params={"bbox": "-31,35,-29,37"}).status_code == 404  # 0건
    assert client.get("/api/export.kml", params={"bbox": "12.4,41.8,12.6,42.0", "cat": ""}).status_code == 404
    radius = client.get("/api/export.kml", params={"lat": 41.89, "lon": 12.49, "q": "circus"})
    assert radius.status_code == 200 and "하루 행군 반경" in radius.text


def test_normalize_rules():
    assert normalize("  Arènes   de NÎMES ") == "arenes de nimes"
    assert normalize("콜로세움") == normalize("콜로세움")
    assert normalize("콜로") in normalize("콜로세움")  # 한글은 자모로 분해되므로 양쪽 모두 정규화


def test_site_detail():
    assert client.get("/api/sites/285857974").json()["properties"]["name"] == "Amphitheatrum Flavium"
    assert client.get("/api/sites/0").status_code == 404


# ── 고고학 아이콘 ──────────────────────────────
CATS = ["town", "military", "sacred", "arena", "water", "road", "villa", "burial", "industry"]


@pytest.mark.parametrize("kind", ["glyph", "outline"])
@pytest.mark.parametrize("cat", CATS)
def test_icons_exist_and_follow_spec(kind, cat):
    import xml.etree.ElementTree as ET
    r = client.get(f"/icons/{kind}/{cat}.svg")
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/svg+xml")
    root = ET.fromstring(r.text)
    assert root.get("viewBox") == "0 0 24 24"
    assert root.get("aria-hidden") == "true"
    if kind == "glyph":
        assert root.get("fill") == "currentColor"
    else:
        assert root.get("fill") == "none" and root.get("stroke") == "currentColor" and root.get("stroke-width") == "1.6"


def test_every_category_has_both_icons():
    from app.categories import CATEGORIES
    assert sorted(c["key"] for c in CATEGORIES) == sorted(CATS)


def test_category_colors_contrast_with_marble_icon():
    """분류 색 배지 위의 대리석색(#F1F2EF) 아이콘은 그래픽 대비 3:1 이상."""
    from app.categories import CATEGORIES

    def lum(h):
        c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

    for c in CATEGORIES:
        hi, lo = sorted([lum(c["color"]), lum("#F1F2EF")], reverse=True)
        assert (hi + 0.05) / (lo + 0.05) >= 3, c["key"]


def test_search_by_pleiades_id():
    ids = [f["properties"]["id"] for f in client.get("/api/sites", params={"q": "149496"}).json()["features"]]
    assert ids[0] == "149496"
