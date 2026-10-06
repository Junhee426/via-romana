"""API 회귀 테스트. 저장소의 로컬 데이터만 쓰고 외부 서비스에 접속하지 않는다.

    pip install -r requirements.txt pytest httpx
    python -m pytest tests
"""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import ALIASES, KO_NAMES, REGIONS, SITES, app, normalize

ROOT = Path(__file__).resolve().parent.parent
client = TestClient(app)
# 건수는 데이터를 새로 만들면 바뀌므로 meta.json에서 읽는다
META = json.loads((ROOT / "data/processed/meta.json").read_text(encoding="utf-8"))
TOTAL = META["total"]
BY_CAT = META["by_category"]


def count(path, **params):
    r = client.get(path, params=params)
    assert r.status_code == 200, r.text
    return len(r.json()["features"])


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "sites": TOTAL}
    assert TOTAL == len(SITES) == sum(BY_CAT.values()) > 0


def test_static_assets_revalidate():
    for path in ["/", "/app.js", "/style.css"]:
        r = client.get(path)
        assert r.status_code == 200
        assert r.headers["cache-control"] == "no-cache"


def test_csp_only_on_map_page():
    csp = client.get("/").headers["content-security-policy"]
    assert "default-src 'self'" in csp and "script-src 'self' https://cdnjs.cloudflare.com;" in csp
    assert "https://*.wikimedia.org" in csp   # 사진은 upload.·thumb. 두 호스트에서 온다
    assert "content-security-policy" not in client.get("/docs").headers
    assert "content-security-policy" not in client.get("/api/meta").headers


def test_all_sites_is_cached_and_revalidates():
    r = client.get("/api/sites", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers["content-encoding"] == "gzip"
    assert r.headers["cache-control"] == "no-cache" and "accept-encoding" in r.headers["vary"].lower()
    etag = r.headers["etag"]
    assert len(r.json()["features"]) == TOTAL
    again = client.get("/api/sites", headers={"Accept-Encoding": "gzip", "If-None-Match": etag})
    assert again.status_code == 304 and again.content == b""
    # 프록시가 약한 ETag(W/)로 바꿔 보내도 같은 것으로 본다
    assert client.get("/api/sites", headers={"Accept-Encoding": "gzip", "If-None-Match": f"W/{etag}"}).status_code == 304
    assert client.get("/api/sites", headers={"Accept-Encoding": "gzip", "If-None-Match": '"old"'}).status_code == 200
    # 압축을 받지 않는 클라이언트는 원본을 받고 ETag도 다르다
    plain = client.get("/api/sites", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.headers["etag"] != etag
    assert plain.json() == r.json()
    # 필터가 있으면 미리 만든 본문을 쓰지 않는다
    assert "etag" not in client.get("/api/sites", params={"cat": "arena"}).headers


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
    assert count("/api/sites") == TOTAL
    assert count("/api/sites", cat="arena") == BY_CAT["arena"]
    assert count("/api/sites", cat="arena,water") == BY_CAT["arena"] + BY_CAT["water"]
    assert 0 < count("/api/sites", visible="true") < TOTAL
    assert 0 < count("/api/sites", bbox="12.4,41.8,12.6,42.0") < TOTAL


def test_empty_cat_means_no_category_not_all():
    assert count("/api/sites", cat="") == 0


def test_unknown_category_and_bad_bbox_are_400():
    assert client.get("/api/sites", params={"cat": "nope"}).status_code == 400
    assert client.get("/api/sites", params={"bbox": "a,b"}).status_code == 400
    assert client.get("/api/sites", params={"bbox": "nan,nan,nan,nan"}).status_code == 400
    assert client.get("/api/sites", params={"bbox": "12.6,41.8,12.4,42.0"}).status_code == 400   # 서 > 동
    assert client.get("/api/export.kml", params={"bbox": "12.4,42.0,12.6,41.8"}).status_code == 400  # 남 > 북


def test_original_geojson_names_and_ids_unchanged():
    data = json.loads((ROOT / "data/processed/sites.geojson").read_text(encoding="utf-8"))
    served = client.get("/api/sites").json()["features"]
    assert [f["properties"]["id"] for f in served] == [f["properties"]["id"] for f in data["features"]]
    assert [f["properties"]["name"] for f in served] == [f["properties"]["name"] for f in data["features"]]
    assert not any("ko" in f["properties"] for f in data["features"])


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
    assert colosseum["properties"]["ko"] == ["콜로세움", "콜로세오"]   # Wikidata 라벨 '콜로세움'은 겹치므로 한 번만


def test_wikidata_korean_labels_and_links():
    """빌드 때 받아 둔 Wikidata 한국어 라벨로도 찾을 수 있고, 응답에는 ko 하나로 모아서 준다."""
    labelled = [f["properties"] for f in SITES if f["properties"].get("ko_label")]
    assert len(labelled) == META["with_ko_label"] > 100
    assert all(p["wd"] and "links" in p for p in labelled)
    assert all(isinstance(f["properties"]["links"], int) for f in SITES if f["properties"]["wd"])
    assert not any("links" in f["properties"] for f in SITES if not f["properties"]["wd"])
    # 별칭이 없는 유적도 Wikidata 한국어 라벨로 검색된다
    p = next(p for p in labelled if p["id"] not in ALIASES)
    found = client.get("/api/sites", params={"q": p["ko_label"]}).json()["features"]
    hit = next(f["properties"] for f in found if f["properties"]["id"] == p["id"])
    assert hit["ko"] == [p["ko_label"]] and "ko_label" not in hit
    # 유명한 곳은 위키백과 언어판이 많다 (지도에서 겹칠 때 우선순위로 쓴다)
    by_id = {f["properties"]["id"]: f["properties"] for f in SITES}
    assert by_id["285857974"]["links"] >= 50
    assert set(ALIASES) <= set(KO_NAMES)


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
    props = client.get("/api/sites/285857974").json()["properties"]
    assert props["name"] == "Amphitheatrum Flavium"
    assert props["ko"] == ["콜로세움", "콜로세오"]   # 목록 API와 같은 한국어 이름
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
