"""베토벤 피아노 협주곡 3번(Op.37) MIDI 3악장을 라이브러리에 등록한다.

    .venv/bin/python import_concerto.py

이 MIDI 는 콘트라베이스를 '실제 울리는 높이'로 적어 두었다(첼로보다 한 옥타브 아래).
교향곡 쪽은 '악보에 적힌 높이' 기준이라, 옥타브 토글이 곡마다 다르게 동작하지 않도록
여기서 한 옥타브 올려 기보 높이로 맞춘다.
"""
import json
from pathlib import Path

import server

LIB = Path(__file__).parent / "library"
SCORES = Path(__file__).parent / "scores"

MOVEMENTS = [
    ("Concerto3_1-allegro-con-brio.mid", "베토벤 피아노 협주곡 3번 · 1악장 Allegro con brio"),
    ("Concerto3_2-largo.mid", "베토벤 피아노 협주곡 3번 · 2악장 Largo"),
    ("Concerto3_3-allegro.mid", "베토벤 피아노 협주곡 3번 · 3악장 Rondo: Allegro"),
]

LIB.mkdir(exist_ok=True)
index_path = LIB / "pieces.json"
items = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
items = [i for i in items if "협주곡" not in i["title"]]      # 이 곡은 새로 만든다

for fname, title in MOVEMENTS:
    src = SCORES / fname
    if not src.exists():
        print(f"  ✗ 파일 없음: {fname}")
        continue

    score, _, tracks, suggested = server.analyze_parts(src)
    cb = next((t for t in tracks if "contrabass" in t["name"].lower()), None)
    vc = next((t for t in tracks if "violoncello" in t["name"].lower()), None)
    if cb is None:
        cb = next(t for t in tracks if t["index"] == suggested)

    notes, tmap = server.part_to_notes(score, cb["index"])

    # 첼로보다 한 옥타브 아래면 실음 기보 → 기보 높이로 되돌린다
    shift = 0
    if vc and (vc["median"] - cb["median"]) == 12:
        shift = 12
        for n in notes:
            n["midi"] += 12

    piece_id = server.slugify(title)
    (LIB / f"{piece_id}.json").write_text(
        json.dumps({"bpm": tmap[0][1], "tempoMap": tmap, "notes": notes}, ensure_ascii=False),
        encoding="utf-8")
    items.append({
        "id": piece_id, "title": title, "category": "협주곡",
        "instrument": "contrabass", "bpm": tmap[0][1],
        "count": len(notes), "upperCount": 0, "cueCount": 0, "source": "midi",
    })
    lo = min(n["midi"] for n in notes)
    hi = max(n["midi"] for n in notes)
    print(f"  ✓ {title}")
    print(f"      {cb['name']} 트랙 · 음표 {len(notes)}개 · 옥타브보정 {'+12' if shift else '없음'}"
          f" · 음역 {lo}~{hi} · 템포변화 {len(tmap)}곳")

items.sort(key=lambda i: (i["category"], i["title"]))
index_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

valid = {i["id"] for i in items} | {"pieces"}
for f in LIB.glob("*.json"):
    if f.stem not in valid:
        f.unlink()
        print("  (정리)", f.name)

print("완료 — 전체 등록곡:", len(items))
