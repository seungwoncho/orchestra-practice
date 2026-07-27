"""내려받은 베토벤 교향곡 1번 MusicXML 4악장을 라이브러리에 등록한다.
   (출처: markGotham/hauptstimme — OpenScore 계열, CC0/MIT)
   실행:  .venv/bin/python import_beethoven.py
"""
import json
from pathlib import Path

import server

LIB = Path(__file__).parent / "library"
SCORES = Path(__file__).parent / "scores"

MOVEMENTS = [
    (1, "베토벤 교향곡 1번 · 1악장 Adagio molto — Allegro con brio"),
    (2, "베토벤 교향곡 1번 · 2악장 Andante cantabile con moto"),
    (3, "베토벤 교향곡 1번 · 3악장 Menuetto: Allegro molto e vivace"),
    (4, "베토벤 교향곡 1번 · 4악장 Adagio — Allegro molto e vivace"),
]

LIB.mkdir(exist_ok=True)
index_path = LIB / "pieces.json"
items = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
items = [i for i in items if "베토벤" not in i["title"]]   # 기존 베토벤 항목은 새로 만든다

for num, title in MOVEMENTS:
    src = SCORES / f"Beethoven_Op21_mvt{num}.mxl"
    if not src.exists():
        print(f"  ✗ 파일 없음: {src.name}")
        continue

    score, _, tracks, suggested = server.analyze_parts(src)
    track = next((t for t in tracks if t["name"].strip().lower() == "contrabass"), None)
    if track is None:
        track = next(t for t in tracks if t["index"] == suggested)
    notes, tmap = server.part_to_notes(score, track["index"])

    piece_id = server.slugify(title)
    (LIB / f"{piece_id}.json").write_text(
        json.dumps({"bpm": tmap[0][1], "tempoMap": tmap, "notes": notes}, ensure_ascii=False),
        encoding="utf-8")
    items.append({
        "id": piece_id, "title": title, "category": "교향곡",
        "instrument": "contrabass", "bpm": tmap[0][1],
        "count": len(notes), "upperCount": 0, "cueCount": 0, "source": "midi",
    })
    print(f"  ✓ {title}  —  {track['name']} 트랙, 음표 {len(notes)}개, 템포변화 {len(tmap)}곳")

items.sort(key=lambda i: (i["category"], i["title"]))
index_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

# 인덱스에 없는 파일 정리
valid = {i["id"] for i in items} | {"pieces"}
for f in LIB.glob("*.json"):
    if f.stem not in valid:
        f.unlink()
        print("  (정리)", f.name)

print("완료 — 등록된 곡:", len(items))
