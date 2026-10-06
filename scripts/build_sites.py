"""Pleiades 데이터로 유럽 로마 유적 GeoJSON을 만든다.

사용법:
    python scripts/build_sites.py            # 원본이 없으면 내려받고 가공
    python scripts/build_sites.py --refresh  # 원본을 새로 내려받고 가공
    python scripts/build_sites.py --wikidata-only  # 유적 목록은 그대로 두고 Wikidata 정보만 새로 받음

결과:
    data/processed/sites.geojson  (지도와 API가 읽는 파일, git에 커밋)
    data/processed/meta.json      (건수·빌드 시각·출처)

표준 라이브러리만 쓴다. 원본(data/raw/)은 .gitignore로 제외된다.
"""

import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.categories import CATEGORIES, classify  # noqa: E402

RAW_DIR = ROOT / "data" / "raw" / "pleiades"
OUT_DIR = ROOT / "data" / "processed"

PLEIADES_BASE = "https://raw.githubusercontent.com/isawnyu/pleiades.datasets/main/data/gis/"
PLEIADES_FILES = [
    "places.csv",
    "places_place_types.csv",
    "location_points.csv",       # 점 위치 (대부분의 유적)
    "location_linestrings.csv",  # 선 위치 (성벽, 수도교, 다리 등)
    "location_polygons.csv",     # 면 위치 (요새, 원형극장 등)
]
LOCATION_FILES = PLEIADES_FILES[2:]

# Pleiades ↔ Wikidata 연결표. 유적 사진·설명은 지도에서 이 ID로 Wikidata·위키백과를 찾는다
WIKIDATA_INDEX = "https://raw.githubusercontent.com/isawnyu/pleiades.datasets/main/data/indexes/wikidata.json"

# Wikidata에서 유적마다 한국어 라벨과 위키백과 언어판 수를 받아 둔다 (키 필요 없음).
#   ko_label: 한국어 검색·표시용.  links: 얼마나 널리 알려진 곳인지 (지도에서 겹칠 때 우선순위)
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
WIKIDATA_CACHE = ROOT / "data" / "raw" / "wikidata_details.json"
WIKIDATA_BATCH = 50   # wbgetentities가 한 번에 받는 최대 개수
USER_AGENT = "via-romana-build/0.1 (https://github.com/junhee426/via-romana)"
# 사이트링크 중 위키백과가 아닌 것 (이름이 'wiki'로 끝나지만 백과사전이 아님)
NOT_WIKIPEDIA = {"commonswiki", "wikidatawiki", "specieswiki", "metawiki",
                 "mediawikiwiki", "sourceswiki", "wikimaniawiki", "outreachwiki"}
HANGUL = re.compile(r"[가-힣]")

# 로마 시대로 볼 기간: 위치의 존속 기간이 이 구간과 겹치면 포함
# Pleiades 기준 'roman'은 기원전 30년~서기 300년, 'late-antique'는 300~640년
ROMAN_START = -30   # 이 해 '이후'까지 존속해야 함 (공화정기에만 존재한 곳 제외)
ROMAN_END = 400     # 이 해 '이전'에 시작해야 함

# 연대 정보가 없어도 로마 유적일 가능성이 매우 높은 분류
ROMAN_BY_NATURE = {"arena", "water", "villa"}

# 대략적인 유럽 경계 (경도, 위도). 북아프리카·아나톨리아를 제외하려고 그린 다각형이라
# 해안 근처 몇몇 섬(로도스, 사모스 등)은 빠진다. 필요하면 꼭짓점을 고치면 된다.
EUROPE = [
    (-11.5, 35.9), (-5.6, 35.95), (-5.2, 36.0), (-2.0, 36.55), (2.0, 37.2),
    (5.0, 37.3), (8.0, 37.6), (9.5, 37.6), (11.2, 37.35), (11.6, 36.4),
    (13.8, 35.6), (14.8, 35.6), (22.0, 34.6), (26.6, 34.6), (26.6, 38.0),
    (26.1, 38.5), (26.62, 39.0), (26.62, 39.4), (26.3, 39.42), (25.95, 40.0),
    (26.15, 40.07), (26.65, 40.42), (27.5, 40.8), (28.95, 40.93), (29.0, 41.0),
    (29.08, 41.25), (31.0, 42.5), (33.0, 44.2), (36.55, 45.0), (36.55, 45.6),
    (40.0, 48.0), (40.0, 62.0), (-12.0, 62.0),
]

VISIBILITY_RANK = {"substantive": 6, "restored": 5, "traces": 4,
                   "notvisible": 3, "none": 2, "unknown": 1, "notapplicable": 0}


def in_polygon(lon, lat, poly=EUROPE):
    """레이 캐스팅으로 점이 다각형 안에 있는지 판정."""
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def download(refresh=False):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for name in PLEIADES_FILES:
        dest = RAW_DIR / name
        if dest.exists() and not refresh:
            print(f"  있음: {name}")
            continue
        print(f"  내려받는 중: {name}")
        urllib.request.urlretrieve(PLEIADES_BASE + name, dest)
    dest = RAW_DIR / "wikidata.json"
    if refresh or not dest.exists():
        print("  내려받는 중: wikidata.json")
        urllib.request.urlretrieve(WIKIDATA_INDEX, dest)
    else:
        print("  있음: wikidata.json")


def wikidata_ids():
    """Pleiades ID → Wikidata QID.

    연결표에는 장소 → QID, QID → 장소 두 방향이 섞여 있고 URL 표기도 제각각이다.
    한 장소에 QID가 여럿이면 그 장소에만 연결된(더 구체적인) QID를 고른다.
    """
    with open(RAW_DIR / "wikidata.json", encoding="utf-8") as f:
        index = json.load(f)

    def qid(url):
        m = re.search(r"wikidata\.org/.*?(Q\d+)$", url)
        return m.group(1) if m else None

    def pid(url):
        m = re.search(r"pleiades\.stoa\.org/places/(\d+)", url)
        return m.group(1) if m else None

    candidates = defaultdict(set)
    places_per_qid = defaultdict(set)
    for key, entry in index.items():
        links = entry.get("alignments", [])
        if pid(key):
            pairs = [(pid(key), qid(u)) for u in links]
        else:
            pairs = [(pid(u), qid(key)) for u in links]
        for p, q in pairs:
            if p and q:
                candidates[p].add(q)
                places_per_qid[q].add(p)

    return {
        p: min(qs, key=lambda q: (len(places_per_qid[q]), int(q[1:])))
        for p, qs in candidates.items()
    }


def fetch_wikidata(qids):
    """QID 묶음 하나의 { QID: { ko, links } }. 없는 항목은 결과에서 빠진다."""
    url = WIKIDATA_API + "?" + urllib.parse.urlencode({
        "action": "wbgetentities", "format": "json", "ids": "|".join(qids),
        "props": "labels|sitelinks", "languages": "ko",
    })
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                data = json.load(res)
            break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    found = {}
    for key, entity in data.get("entities", {}).items():
        if "missing" in entity:
            continue
        # 합쳐진 항목은 새 QID로 돌아온다. 우리가 물은 QID로 되돌려 적는다
        qid = entity.get("redirects", {}).get("from", key)
        label = entity.get("labels", {}).get("ko", {}).get("value", "").strip()
        links = sum(1 for site in entity.get("sitelinks", {})
                    if site.endswith("wiki") and site not in NOT_WIKIPEDIA)
        # 한국어 라벨 칸에 로마자 표기만 들어 있는 경우는 쓰지 않는다 (이미 name으로 찾을 수 있음)
        found[qid] = {"ko": label if HANGUL.search(label) else None, "links": links}
    return found


def wikidata_details(qids, refresh=False):
    """QID → { ko: 한국어 라벨 또는 None, links: 위키백과 언어판 수 }. data/raw/에 캐시한다."""
    cache = {}
    if WIKIDATA_CACHE.exists() and not refresh:
        cache = json.loads(WIKIDATA_CACHE.read_text(encoding="utf-8"))
    todo = sorted(set(qids) - cache.keys(), key=lambda q: int(q[1:]))
    if todo:
        print(f"  Wikidata에서 받는 중: {len(todo):,}개 항목")
    for i in range(0, len(todo), WIKIDATA_BATCH):
        batch = todo[i:i + WIKIDATA_BATCH]
        found = fetch_wikidata(batch)
        for q in batch:
            cache[q] = found.get(q, {"ko": None, "links": 0})
        time.sleep(0.2)
    if todo:
        WIKIDATA_CACHE.parent.mkdir(parents=True, exist_ok=True)
        WIKIDATA_CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return cache


def add_wikidata(features, refresh=False):
    """wd가 있는 유적에 links(항상)와 ko_label(한국어 라벨이 있을 때만)을 붙인다."""
    details = wikidata_details([f["properties"]["wd"] for f in features if f["properties"]["wd"]], refresh)
    for f in features:
        props = f["properties"]
        props.pop("ko_label", None)
        props.pop("links", None)
        info = details.get(props["wd"]) if props["wd"] else None
        if not info:
            continue
        props["links"] = info["links"]
        if info["ko"]:
            props["ko_label"] = info["ko"]


def read_csv(name):
    csv.field_size_limit(10**9)
    with open(RAW_DIR / name, encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f)


def to_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def short(text, limit=240):
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "…"


def build():
    wikidata = wikidata_ids()
    types_by_place = defaultdict(list)
    for row in read_csv("places_place_types.csv"):
        types_by_place[row["place_id"]].append(row["place_type"])

    # 장소별 위치 기록(점·선·면)에서 연대·유적 상태·확실성을 모은다
    locs_by_place = defaultdict(list)
    for name in LOCATION_FILES:
        for row in read_csv(name):
            locs_by_place[row["place_id"]].append({
                "start": to_int(row["year_after_which"]),
                "end": to_int(row["year_before_which"]),
                "remains": row["archaeological_remains"] or "unknown",
                "certainty": row["association_certainty"] or "certain",
            })

    features = []
    skipped = Counter()
    for place in read_csv("places.csv"):
        pid = place["id"]
        if place["location_precision"] != "precise":
            skipped["위치가 대략적임"] += 1
            continue
        cat = classify(types_by_place.get(pid, []))
        if cat is None:
            skipped["유적 유형 아님(강·산·지역 등)"] += 1
            continue

        locs = locs_by_place.get(pid, [])
        dated = [l for l in locs if l["start"] is not None and l["end"] is not None]
        roman = [l for l in dated if l["end"] > ROMAN_START and l["start"] < ROMAN_END]
        if dated and not roman:
            skipped["로마 시대 아님"] += 1
            continue
        if not dated and cat not in ROMAN_BY_NATURE:
            skipped["연대 정보 없음"] += 1
            continue

        lon = float(place["representative_longitude"])
        lat = float(place["representative_latitude"])
        if not in_polygon(lon, lat):
            skipped["유럽 밖"] += 1
            continue

        remains = max((l["remains"] for l in locs), default="unknown",
                      key=lambda r: VISIBILITY_RANK.get(r, 0))
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
            "properties": {
                "id": pid,
                "name": place["title"],
                "cat": cat,
                "types": sorted(set(types_by_place[pid])),
                "desc": short(place["description"]),
                "from": min(l["start"] for l in roman) if roman else None,
                "to": max(l["end"] for l in roman) if roman else None,
                "remains": remains,
                "certain": any(l["certainty"] == "certain" for l in locs) if locs else True,
                "wd": wikidata.get(pid),
            },
        })

    features.sort(key=lambda f: f["properties"]["id"])
    print("제외:", dict(skipped))
    return features


def write(features, built_at):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "sites.geojson", "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features},
                  f, ensure_ascii=False, separators=(",", ":"))

    counts = Counter(f["properties"]["cat"] for f in features)
    with_wd = sum(1 for f in features if f["properties"]["wd"])
    with_ko = sum(1 for f in features if f["properties"].get("ko_label"))
    meta = {
        "built_at": built_at,
        "wikidata_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": len(features),
        "by_category": {c["key"]: counts.get(c["key"], 0) for c in CATEGORIES},
        "period": [ROMAN_START, ROMAN_END],
        "with_wikidata": with_wd,
        "with_ko_label": with_ko,
        "sources": [{
            "name": "Pleiades",
            "url": "https://pleiades.stoa.org",
            "license": "CC BY 3.0",
        }, {
            "name": "Wikidata",
            "url": "https://www.wikidata.org",
            "license": "CC0",
        }],
    }
    with open(OUT_DIR / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"\n유적 {len(features):,}곳 저장 → data/processed/sites.geojson")
    for c in CATEGORIES:
        print(f"  {c['label']:<12} {counts.get(c['key'], 0):>6,}")
    print(f"Wikidata 연결: {with_wd:,}곳 (한국어 라벨 {with_ko:,}곳)")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--refresh", action="store_true", help="원본 다시 내려받기")
    parser.add_argument("--wikidata-only", action="store_true",
                        help="지금의 sites.geojson은 그대로 두고 Wikidata 정보(한국어 라벨·위키백과 수)만 새로 받기")
    args = parser.parse_args()
    if args.wikidata_only:
        features = json.loads((OUT_DIR / "sites.geojson").read_text(encoding="utf-8"))["features"]
        built_at = json.loads((OUT_DIR / "meta.json").read_text(encoding="utf-8"))["built_at"]
        print("Wikidata 정보 받는 중")
        add_wikidata(features, refresh=True)
    else:
        print("Pleiades 원본 확인")
        download(refresh=args.refresh)
        print("가공 중")
        features = build()
        built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        add_wikidata(features, refresh=args.refresh)
    write(features, built_at)


if __name__ == "__main__":
    main()
