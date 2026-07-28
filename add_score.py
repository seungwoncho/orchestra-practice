"""악보 파일(MIDI/MusicXML)에서 내 파트를 뽑아 라이브러리에 등록한다.

    .venv/bin/python add_score.py <파일> --title "곡 제목" --category 서곡
    .venv/bin/python add_score.py <파일> --title "..." --track 11      # 트랙 직접 지정
    .venv/bin/python add_score.py <파일> --list                        # 트랙만 보기

콘트라베이스 트랙은 자동으로 찾고, 실음 기보 악보는 기보 높이로 맞춘다.
등록 후 `python build_static.py` 로 다시 굽고 `bash deploy.sh` 로 배포하면 반영된다.
"""
import argparse
import json
from pathlib import Path

import server

LIB = Path(__file__).parent / "library"


def show(tracks, suggested):
    for t in tracks:
        mark = "  ← 추천" if t["index"] == suggested else ""
        print(f"  [{t['index']:2}] {t['name'][:32]:32} {t['count']:5}음  "
              f"MIDI {t['low']:3}~{t['high']:3}{mark}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--title")
    ap.add_argument("--category", default="기타")
    ap.add_argument("--instrument", default="contrabass")
    ap.add_argument("--track", type=int, default=None)
    ap.add_argument("--list", action="store_true", help="트랙 목록만 보고 끝낸다")
    args = ap.parse_args()

    src = Path(args.path)
    if not src.exists():
        print(f"✗ 파일 없음: {src}")
        return

    print(f"악보 읽는 중… ({src.name})")
    score, _, tracks, suggested = server.analyze_parts(src)

    if args.list:
        show(tracks, suggested)
        return

    track = args.track if args.track is not None else suggested
    chosen = next((t for t in tracks if t["index"] == track), None)
    if chosen is None:
        print(f"✗ {track}번 트랙이 없습니다. 아래에서 골라 --track 으로 지정하세요:")
        show(tracks, suggested)
        return

    title = args.title or src.stem
    notes, tmap = server.part_to_notes(score, track)
    if not notes:
        print("✗ 선택한 트랙에 음표가 없습니다.")
        return
    shifted = server.octave_fix(tracks, track, notes)

    piece_id = server.slugify(title)
    LIB.mkdir(exist_ok=True)
    (LIB / f"{piece_id}.json").write_text(
        json.dumps({"bpm": tmap[0][1], "tempoMap": tmap, "notes": notes}, ensure_ascii=False),
        encoding="utf-8")

    index_path = LIB / "pieces.json"
    items = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    prev = next((i for i in items if i["id"] == piece_id), {})
    items = [i for i in items if i["id"] != piece_id]
    entry = {
        "id": piece_id, "title": title, "category": args.category,
        "instrument": args.instrument, "bpm": tmap[0][1],
        "count": len(notes), "upperCount": 0, "cueCount": 0, "source": "midi",
    }
    if prev.get("youtube"):
        entry["youtube"] = prev["youtube"]
    items.append(entry)
    items.sort(key=lambda i: (i["category"], i["title"]))
    index_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

    lo, hi = min(n["midi"] for n in notes), max(n["midi"] for n in notes)
    print(f"✓ 등록 완료: {title}")
    print(f"   {chosen['name']} 트랙 · 음표 {len(notes)}개 · 음역 {lo}~{hi}"
          f" · 옥타브보정 {'+12' if shifted else '없음'} · 템포변화 {len(tmap)}곳")
    print(f"   이제 `python build_static.py` 후 `bash deploy.sh` 하면 공개판에 반영됩니다.")


if __name__ == "__main__":
    main()
