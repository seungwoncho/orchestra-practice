"""
서버 없이 도는 정적 사이트를 docs/ 폴더에 만든다.
GitHub Pages · Netlify · Cloudflare Pages 어디에 올려도 그대로 돌아간다.

    .venv/bin/python build_static.py

정적 모드에서 달라지는 점
  · 곡 데이터는 미리 계산해 docs/data/*.json 으로 굽는다 (파이썬 불필요)
  · 유튜브 링크는 브라우저 localStorage 에 저장 (서버가 없으므로)
  · MIDI 업로드/트랙분석은 서버가 필요해서 숨긴다 (로컬에서 곡을 추가한 뒤 다시 빌드)
"""
import json
import re
import shutil
from pathlib import Path

import server

BASE = Path(__file__).parent
OUT = BASE / "docs"
DATA = OUT / "data"


def build():
    if OUT.exists():
        shutil.rmtree(OUT)
    DATA.mkdir(parents=True)

    # 1) 곡 데이터 굽기 -------------------------------------------------
    items = server.read_index()
    index_out = []
    for it in items:
        payload = server.piece(it["id"])
        if not isinstance(payload, dict):
            print(f"  ! 건너뜀: {it['title']}")
            continue
        (DATA / f"{it['id']}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        index_out.append({k: it.get(k) for k in
                          ("id", "title", "category", "instrument", "bpm",
                           "count", "upperCount", "cueCount", "source", "youtube")})
        print(f"  ✓ {it['title']}  ({payload['count']}음표, {payload['duration']:.0f}초)")
    (DATA / "pieces.json").write_text(
        json.dumps(index_out, ensure_ascii=False, indent=1), encoding="utf-8")

    # 2) 화면 파일 복사 --------------------------------------------------
    # 파일이 바뀌면 주소도 바뀌게 버전을 붙인다.
    # 안 붙이면 배포해도 브라우저가 예전 style.css / app.js 를 계속 쓴다.
    ver = max(int((BASE / n).stat().st_mtime) for n in ("style.css", "app.js"))
    html = (BASE / "index.html").read_text(encoding="utf-8")
    html = (html.replace("/static/style.css", f"style.css?v={ver}")
                .replace("/static/app.js", f"app.js?v={ver}"))
    # 정적 모드 표시와 데이터 버전을 심는다.
    # (주소에 ?v= 가 붙어도 걸리도록 정규식으로 찾는다)
    html, n = re.subn(
        r'<script src="app\.js[^"]*"></script>',
        f'<script>window.STATIC_MODE=true;window.DATA_VERSION={ver};</script>\n  '
        f'<script src="app.js?v={ver}"></script>',
        html)
    if n != 1:
        raise RuntimeError(f"app.js 스크립트 태그를 찾지 못했습니다 (일치 {n}건) — 정적 모드가 켜지지 않습니다")
    # 서버가 필요한 '새 곡 추가' 영역은 공개판에서 통째로 뺀다 (안내문도 남기지 않는다)
    html = re.sub(r'<details class="addhelp" id="addBox">.*?</details>', "", html, flags=re.S)
    (OUT / "index.html").write_text(html, encoding="utf-8")

    for name in ("style.css", "app.js"):
        shutil.copy(BASE / name, OUT / name)

    # 3) GitHub Pages 가 폴더를 그대로 쓰도록
    (OUT / ".nojekyll").write_text("", encoding="utf-8")

    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"\n완료 → {OUT}  (곡 {len(index_out)}개, 총 {total/1024:.0f} KB)")
    print("이 폴더를 GitHub Pages 등에 올리면 어디서나 접속됩니다.")


if __name__ == "__main__":
    build()
