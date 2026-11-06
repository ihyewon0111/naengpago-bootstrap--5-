"""
더블클릭(파일로 열기)으로도 냉파고가 동작하도록 data/data.js 를 만듭니다.

크롬은 파일을 더블클릭해서 열면(file://) data/*.json 을 읽지 못하게 막습니다.
그래서 JSON 내용을 data/data.js 안에 함께 넣어 두고, 파일로 열었을 때만 그 내용을 쓰게 합니다.
(Live Server나 Vercel로 열 때는 원래대로 JSON 파일을 읽습니다)

사용법 (레시피·재료 데이터를 바꿀 때마다 한 번 실행)
  python scripts/make_offline.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ["data/recipes.json", "data/ai_recipes.json", "data/ingredients.json", "data/demo_vision.json"]

bundle = {}
for rel in FILES:
    path = ROOT / rel
    if path.exists():
        bundle[rel] = json.loads(path.read_text(encoding="utf-8"))

js = (
    "// 자동 생성 파일입니다. 직접 고치지 말고 python scripts/make_offline.py 를 다시 실행하세요.\n"
    "window.NPG_DATA = " + json.dumps(bundle, ensure_ascii=False) + ";\n"
    "(function () {\n"
    "  if (location.protocol !== 'file:') return; // Live Server·Vercel에서는 원래 방식 그대로\n"
    "  var original = window.fetch;\n"
    "  window.fetch = function (url, options) {\n"
    "    var key = String(url).replace(/^\\.\\//, '');\n"
    "    if (window.NPG_DATA[key]) {\n"
    "      return Promise.resolve(new Response(JSON.stringify(window.NPG_DATA[key]),\n"
    "        { headers: { 'Content-Type': 'application/json' } }));\n"
    "    }\n"
    "    return original ? original(url, options) : Promise.reject(new Error('offline'));\n"
    "  };\n"
    "})();\n"
)
out = ROOT / "data" / "data.js"
out.write_text(js, encoding="utf-8")
print(f"저장 완료: {out} (레시피 {len(bundle.get('data/recipes.json', []))}개 포함)")
