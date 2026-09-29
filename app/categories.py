"""유적 분류 정의.

Pleiades의 place type 키를 지도에서 쓸 9개 분류로 묶는다.
위에서부터 우선순위가 높다. 한 장소에 여러 유형이 붙어 있으면
가장 먼저 맞는 분류 하나로 정한다 (예: settlement + amphitheatre → 원형극장).

색은 로마 시대 안료에서 따왔다.
"""

CATEGORIES = [
    {
        "key": "arena",
        "label": "원형극장·극장",
        "color": "#B03A2E",  # 진사(cinnabar)
        "types": ["amphitheatre", "theatre", "circus", "odeon", "stadion"],
    },
    {
        "key": "water",
        "label": "수도교·목욕탕",
        "color": "#2D4E9E",  # 이집션 블루(caeruleum)
        "types": ["aqueduct", "bath", "cistern", "fountain", "dam", "canal"],
    },
    {
        "key": "military",
        "label": "요새·성벽",
        "color": "#5E7A4E",  # 녹토(terra verde)
        "types": [
            "fort", "fort-2", "fort-group", "fortlet", "fortified-settlement",
            "military-base", "military-installation-or-camp-temporary",
            "tower-defensive", "city-wall", "defensive-wall", "wall", "wall-2",
            "city-gate", "gateway", "tower-gate", "tower-wall",
        ],
    },
    {
        "key": "sacred",
        "label": "신전·성소",
        "color": "#6B2A5B",  # 티리언 퍼플
        "types": ["temple", "temple-2", "sanctuary", "shrine"],
    },
    {
        "key": "villa",
        "label": "빌라",
        "color": "#C49A2C",  # 황토(yellow ochre)
        "types": ["villa", "estate", "townhouse"],
    },
    {
        "key": "road",
        "label": "다리·도로 시설",
        "color": "#3B3F46",  # 현무암(가도 포장석)
        "types": ["bridge", "road", "station", "milestone"],
    },
    {
        "key": "burial",
        "label": "무덤·기념물",
        "color": "#6E4B2E",  # 엄버(umber)
        "types": ["cemetery", "tomb", "tower-tomb", "monument", "arch"],
    },
    {
        "key": "industry",
        "label": "광산·항구·생산지",
        "color": "#2F8C7F",  # 녹청(verdigris)
        "types": ["mine", "mine-2", "quarry", "production", "lime-kiln",
                  "port", "harbor", "lighthouse"],
    },
    {
        "key": "town",
        "label": "도시·정착지",
        "color": "#9A9384",  # 응회암(tufa)
        "types": ["settlement", "forum", "basilica", "city-block",
                  "architecturalcomplex", "archaeological-site", "ruin", "building"],
    },
]

CATEGORY_BY_KEY = {c["key"]: c for c in CATEGORIES}

# 지금 가서 눈으로 볼 수 있을 가능성이 있는 유적 상태
VISIBLE_REMAINS = {"substantive", "traces", "restored"}


# 우선순위와 상관없이 특정 분류로 보낼 유형 (개선문은 성문이 아니라 기념물)
OVERRIDES = {"arch": "burial"}


def classify(place_types):
    """장소 유형 목록을 받아 분류 키를 돌려준다. 해당 없으면 None."""
    types = set(place_types)
    for t, key in OVERRIDES.items():
        if t in types:
            return key
    for cat in CATEGORIES:
        if types.intersection(cat["types"]):
            return cat["key"]
    return None
