"""
파트보 PDF를 라이브러리에 등록한다 (미리 변환해두면 앱에서 즉시 재생 가능).

사용법:
    .venv/bin/python add_piece.py <PDF경로> --title "곡 제목" --category 교향곡
    .venv/bin/python add_piece.py *.pdf --category 서곡          # 여러 개도 가능

옵션:
    --category   서곡 / 협주곡 / 교향곡  (기본: 기타)
    --title      곡 제목 (생략하면 파일명 사용)
    --instrument 악기 키 (기본: contrabass)
"""
import argparse
import json
import re
import shutil
import sys
import unicodedata
import uuid
from pathlib import Path

import server

BASE = Path(__file__).parent
LIB = BASE / "library"
INDEX = LIB / "pieces.json"


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[^\w가-힣]+", "-", text).strip("-").lower()
    return text[:48] or uuid.uuid4().hex[:8]


def load_index():
    if INDEX.exists():
        return json.loads(INDEX.read_text(encoding="utf-8"))
    return []


def save_index(items):
    LIB.mkdir(exist_ok=True)
    INDEX.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def add(pdf_path: Path, title: str, category: str, instrument: str):
    LIB.mkdir(exist_ok=True)
    piece_id = slugify(title)
    workdir = LIB / f"_work_{piece_id}"
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)

    print(f"[{title}] 악보 인식 중… (몇 분 걸립니다)", flush=True)
    mxls = server.audiveris_export(pdf_path, workdir)
    if not mxls:
        print(f"  ✗ 실패: 악보를 인식하지 못했습니다 — {pdf_path.name}")
        shutil.rmtree(workdir, ignore_errors=True)
        return None

    all_notes, bpm, offset = [], None, 0.0
    for x in mxls:
        try:
            notes, offset, page_bpm = server.musicxml_to_notes(x, offset)
            all_notes += notes
            if bpm is None and page_bpm:
                bpm = page_bpm
        except Exception as e:
            print(f"  ! {x.name} 파싱 경고: {e}")

    if not all_notes:
        print(f"  ✗ 실패: 음표 없음 — {pdf_path.name}")
        shutil.rmtree(workdir, ignore_errors=True)
        return None

    bpm = bpm or 90
    all_notes.sort(key=lambda z: (z["beat"], z["midi"]))

    # 음역을 벗어난 음 = 다른 악기 큐(cue)
    wmax = server.INSTRUMENTS.get(instrument, {}).get("writtenMax")
    if wmax:
        for n in all_notes:
            if n["midi"] > wmax:
                n["role"] = "cue"

    counts = {"bass": 0, "upper": 0, "cue": 0}
    for n in all_notes:
        counts[n["role"]] = counts.get(n["role"], 0) + 1

    (LIB / f"{piece_id}.json").write_text(
        json.dumps({"bpm": bpm, "notes": all_notes}, ensure_ascii=False), encoding="utf-8")
    shutil.rmtree(workdir, ignore_errors=True)

    items = [i for i in load_index() if i["id"] != piece_id]
    items.append({
        "id": piece_id, "title": title, "category": category,
        "instrument": instrument, "bpm": bpm,
        "count": counts["bass"], "upperCount": counts["upper"], "cueCount": counts["cue"],
    })
    items.sort(key=lambda i: (i["category"], i["title"]))
    save_index(items)
    print(f"  ✓ 등록 완료: {title} — 내 파트 {counts['bass']}개 "
          f"(첼로 {counts['upper']}, 큐 {counts['cue']} 제외), {bpm} BPM")
    return piece_id


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdfs", nargs="+")
    ap.add_argument("--title", default=None)
    ap.add_argument("--category", default="기타")
    ap.add_argument("--instrument", default="contrabass")
    args = ap.parse_args()

    if args.title and len(args.pdfs) > 1:
        print("--title 은 PDF 하나일 때만 쓸 수 있어요.")
        sys.exit(1)

    for p in args.pdfs:
        path = Path(p)
        if not path.exists():
            print(f"  ✗ 파일 없음: {p}")
            continue
        title = args.title or path.stem
        add(path, title, args.category, args.instrument)


if __name__ == "__main__":
    main()
