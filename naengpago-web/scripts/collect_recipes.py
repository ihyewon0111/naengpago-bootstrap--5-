"""
냉파고 1단계: 식품안전나라 「조리식품의 레시피 DB」(COOKRCP01) 수집 + 규칙 기반 1차 정제

사용법 (VS Code 터미널에서, 프로젝트 폴더 기준)
  pip install requests
  python scripts/collect_recipes.py --key 발급받은인증키          # 수집만 → data/raw/recipes_raw.json
  python scripts/collect_recipes.py --rough                      # 수집한 원본으로 data/recipes.json 1차 생성
  python scripts/collect_recipes.py --key 인증키 --rough          # 둘 다

--rough 는 틸론 LLM 태깅이 늦어질 때를 대비한 '안전망'입니다.
규칙(키워드)으로 재료·도구·시간·난이도를 대충 채워서 사이트가 일단 돌아가게 만듭니다.
틸론 노트북(01_recipe_tagging.ipynb)이 끝나면 그 결과로 data/recipes.json 을 덮어쓰세요.
"""
import argparse
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_PATH = ROOT / "data" / "raw" / "recipes_raw.json"
OUT_PATH = ROOT / "data" / "recipes.json"
MASTER_PATH = ROOT / "data" / "ingredients.json"

API = "http://openapi.foodsafetykorea.go.kr/api/{key}/COOKRCP01/json/{start}/{end}"
PAGE = 1000  # 한 번에 최대 1000건


# ---------------------------------------------------------------- 수집
def fetch(key: str, start: int, end: int) -> dict:
    import requests
    url = API.format(key=key, start=start, end=end)
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            return r.json()["COOKRCP01"]
        except Exception as e:  # 네트워크가 불안정할 때 재시도
            print(f"  재시도 {attempt + 1}/3: {e}")
            time.sleep(2)
    raise RuntimeError("API 호출 실패 – 인증키, 서비스명(COOKRCP01) 승인 여부를 확인하세요")


def collect(key: str) -> list:
    first = fetch(key, 1, PAGE)
    code = first.get("RESULT", {}).get("CODE")
    if code != "INFO-000":
        raise RuntimeError(f"API 오류: {first.get('RESULT')}")
    total = int(first["total_count"])
    rows = first["row"]
    print(f"전체 {total}건, 1~{PAGE} 수집 완료")
    start = PAGE + 1
    while start <= total:
        end = min(start + PAGE - 1, total)
        rows += fetch(key, start, end).get("row", [])
        print(f"{start}~{end} 수집 완료")
        start = end + 1
    RAW_PATH.parent.mkdir(parents=True, exist_ok=True)
    RAW_PATH.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장: {RAW_PATH} ({len(rows)}건)")
    return rows


# ---------------------------------------------------------------- 규칙 기반 정제
def load_master():
    m = json.loads(MASTER_PATH.read_text(encoding="utf-8"))
    names = set(m["pantry"]) | set(m["synonyms"]) | {i for v in m["categories"].values() for i in v}
    m["names_sorted"] = sorted(names, key=len, reverse=True)  # 긴 이름부터 매칭
    return m


HEADER_WORDS = {"재료", "주재료", "부재료", "양념", "양념장", "소스", "고명", "드레싱", "육수", "반죽",
                "장식", "토핑", "곁들임", "기타", "밑간", "튀김옷", "가니쉬", "소스재료", "양념재료"}
HEADER_SUFFIX = ("양념", "소스", "재료", "드레싱", "육수", "고명", "장식", "반죽", "인분")
PREFIXES = ("다진", "채썬", "삶은", "데친", "불린", "깐", "손질한", "익힌", "냉동", "건조", "말린")


def clean_token(token: str) -> str:
    """'다진 양파 50g(1/4개)' 같은 원문 조각에서 재료 이름만 남깁니다."""
    token = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", token)          # 괄호 속 분량·설명 제거
    token = re.sub(r"[\d./~]+\s*(g|kg|ml|L|cc|개|큰술|작은술|컵|모|장|줄기|쪽|마리|대|봉|팩|공기|알|톨|뿌리|송이|줌|꼬집)?", " ", token)
    token = re.sub(r"약간|적당량|조금|소량|기호에\s*따라", " ", token)
    return re.sub(r"[^가-힣]", "", token)                          # 한글만 남김


def match_ingredients(parts_text: str, m: dict, recipe_name: str = "") -> list:
    """재료 원문에서 재료 목록을 뽑습니다.
    - 기준 목록(ingredients.json)에 있는 재료는 그 이름으로 맞춥니다. (예: 달걀 → 계란)
    - 목록에 없는 재료(예: 장어)도 버리지 않고 그대로 남깁니다. ← 그래야 '양파만으로 장어수육' 같은 잘못된 추천이 안 생겨요
    """
    title = re.sub(r"[^가-힣]", "", recipe_name)
    found = []
    for raw in re.split(r"[,\n·:]", parts_text or ""):
        token = clean_token(raw)
        if not token or token == title or token in HEADER_WORDS:
            continue
        hit = None
        for name in m["names_sorted"]:
            # 한 글자 이름(물, 파, 무, 김, 밥, 떡, 깨)은 정확히 같을 때만 → '해물'을 '물'로 잘못 읽지 않게
            if (len(name) == 1 and token == name) or (len(name) > 1 and name in token):
                hit = m["synonyms"].get(name, name)
                break
        if hit is None:  # 기준 목록에 없는 재료
            for pre in PREFIXES:
                if token.startswith(pre) and len(token) > len(pre) + 1:
                    token = token[len(pre):]
            if token.endswith(HEADER_SUFFIX) or not (2 <= len(token) <= 8):
                continue
            hit = token
        if hit not in found:
            found.append(hit)
    return found


TOOL_KEYWORDS = {
    "프라이팬": ["볶", "부치", "구워", "굽", "팬"],
    "냄비": ["끓", "삶", "데치", "냄비"],
    "전자레인지": ["전자레인지"],
    "오븐": ["오븐"],
    "찜기": ["찜기"],
}


CATEGORY_EMOJI = {"밥": "🍚", "국&찌개": "🍲", "반찬": "🥢", "일품": "🍳", "후식": "🍰", "기타": "🍽️"}


def clean_step(s: str) -> str:
    s = re.sub(r"^\s*\d+\.\s*", "", s.strip())
    return re.sub(r"[a-z]$", "", s).strip()  # 원본 단계 끝에 붙은 a,b,c 표기 제거


def rough_tag(row: dict, m: dict):
    steps = [clean_step(row.get(f"MANUAL{i:02d}", "")) for i in range(1, 21)]
    steps = [s for s in steps if s]
    pantry = set(m["pantry"])
    ings_all = match_ingredients(row.get("RCP_PARTS_DTLS", ""), m, row.get("RCP_NM", ""))
    main = [i for i in ings_all if i not in pantry]
    if len(main) < 1 or not steps:
        return None
    joined = " ".join(steps)
    tools = [t for t, kws in TOOL_KEYWORDS.items() if any(k in joined for k in kws)]
    minutes = max(5, min(60, len(steps) * 4 + (5 if "끓" in joined or "삶" in joined else 0)))
    difficulty = "초보" if len(steps) <= 3 and len(main) <= 4 else "보통" if len(steps) <= 5 else "도전"
    jachwi = 5 - (len(main) > 6) - (len(tools) > 1) - (minutes > 30) - ("오븐" in tools)
    image = (row.get("ATT_FILE_NO_MAIN") or "").replace("http://", "https://")
    try:
        kcal = round(float(row.get("INFO_ENG") or 0))
    except ValueError:
        kcal = None
    return {
        "id": row.get("RCP_SEQ"),
        "name": row.get("RCP_NM", "").strip(),
        "emoji": CATEGORY_EMOJI.get(row.get("RCP_PAT2", ""), "🍽️"),
        "image": image,
        "category": row.get("RCP_PAT2", ""),
        "kcal": kcal,
        "ingredients": main + [i for i in ings_all if i in pantry],
        "difficulty": difficulty,
        "minutes": minutes,
        "tools": tools,
        "jachwi_score": max(1, jachwi),
        "easy_steps": steps,           # 틸론 LLM이 '초보용 문장'으로 다시 써 줄 부분
        "substitutes": {},
        "tip": (row.get("RCP_NA_TIP") or "").strip()[:30],
    }


def rough(rows: list) -> list:
    m = load_master()
    out = [r for r in (rough_tag(row, m) for row in rows) if r]
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"1차 정제 저장: {OUT_PATH} ({len(out)}/{len(rows)}건 사용)")
    # 더블클릭(파일로 열기)용 data/data.js 도 함께 갱신
    offline = ROOT / "scripts" / "make_offline.py"
    if offline.exists():
        import runpy
        runpy.run_path(str(offline))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", help="식품안전나라 Open API 인증키")
    ap.add_argument("--rough", action="store_true", help="규칙 기반 1차 정제로 data/recipes.json 생성")
    args = ap.parse_args()

    rows = collect(args.key) if args.key else None
    if args.rough:
        if rows is None:
            rows = json.loads(RAW_PATH.read_text(encoding="utf-8"))
        rough(rows)
    if not args.key and not args.rough:
        ap.print_help()
