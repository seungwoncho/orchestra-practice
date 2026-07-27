"""
외부 접속이 전혀 없는 '단일 파일' 버전을 만든다 (artifact.html).

Tone.js·곡 데이터·CSS·JS 를 전부 한 파일 안에 넣어서,
인터넷 차단 환경이나 외부 요청이 막힌 곳에서도 그대로 열린다.
악기 소리는 외부 샘플 대신 합성음을 쓴다.

    .venv/bin/python build_artifact.py
"""
import json
import re
import urllib.request
from pathlib import Path

import server

BASE = Path(__file__).parent
TONE_URL = "https://unpkg.com/tone@14.8.49/build/Tone.js"
TONE_CACHE = BASE / "scores" / "_tone.js"      # 한 번 받아 재사용
OUT = BASE / "artifact.html"


def tone_source():
    if not TONE_CACHE.exists():
        TONE_CACHE.parent.mkdir(exist_ok=True)
        print("  Tone.js 내려받는 중…")
        with urllib.request.urlopen(TONE_URL, timeout=90) as r:
            TONE_CACHE.write_bytes(r.read())
    return TONE_CACHE.read_text(encoding="utf-8", errors="ignore")


def build():
    pieces, data = server.read_index(), {}
    for it in pieces:
        payload = server.piece(it["id"])
        if isinstance(payload, dict):
            data[it["id"]] = payload
    index = [{k: it.get(k) for k in
              ("id", "title", "category", "instrument", "bpm",
               "count", "upperCount", "cueCount", "source", "youtube")}
             for it in pieces if it["id"] in data]

    html = (BASE / "index.html").read_text(encoding="utf-8")
    css = (BASE / "style.css").read_text(encoding="utf-8")
    js = (BASE / "app.js").read_text(encoding="utf-8")

    # 서버가 필요한 '새 곡 추가' 영역 제거
    html = re.sub(r'<details class="addhelp" id="addBox">.*?</details>',
                  '<p class="upnote">곡 추가는 내 컴퓨터 버전에서 할 수 있어요.</p>',
                  html, flags=re.S)
    # <head> 의 외부 링크 제거 후 본문만 사용
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    body = re.sub(r'<script src="[^"]*app\.js[^"]*"></script>', "", body)

    # 미리 구운 데이터를 fetch 대신 쓰도록 갈아끼운다
    js = js.replace(
        'const r = await fetch(STATIC ? "data/pieces.json" : "/api/pieces");\n    const list = await r.json();',
        'const list = JSON.parse(JSON.stringify(window.__PIECES__));')
    js = js.replace(
        'const r = await fetch(STATIC ? `data/${encodeURIComponent(id)}.json`\n                                 : `/api/piece/${encodeURIComponent(id)}`);\n    const d = await r.json();',
        'const d = JSON.parse(JSON.stringify(window.__DATA__[id]));')

    out = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cho's TEST — 세브란스 오케스트라</title>
<style>
{css}
.ytlink {{
  display: grid; place-items: center; height: 100%;
  color: #fff; font-weight: 700; text-decoration: none; font-size: .95rem;
}}
.ytlink:hover {{ background: #1b2432; }}
</style>
</head>
<body>
{body}
<script>{tone_source()}</script>
<script>
window.STATIC_MODE = true;
window.NO_EXTERNAL = true;
window.__PIECES__ = {json.dumps(index, ensure_ascii=False)};
window.__DATA__ = {json.dumps(data, ensure_ascii=False, separators=(",", ":"))};
</script>
<script>
{js}
</script>
</body>
</html>
"""
    OUT.write_text(out, encoding="utf-8")
    print(f"완료 → {OUT.name}  ({OUT.stat().st_size/1024:.0f} KB, 곡 {len(index)}개)")


if __name__ == "__main__":
    build()
