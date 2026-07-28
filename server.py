"""
파트보 → 음원 추출기 백엔드.
파이프라인: PDF --Audiveris(OMR)--> MusicXML(.mxl) --music21--> 음표 목록 + MIDI

OMR 엔진은 Audiveris(자체 Java 런타임 내장 앱, ~/orchestra-tools/Audiveris.app).
PDF를 통째로 받아 모든 페이지를 한 번에 처리한다. 변환은 백그라운드 스레드에서 돌리고
프론트엔드는 상태를 폴링한다.
"""
import copy
import json
import re
import shutil
import unicodedata
import uuid
import threading
import subprocess
from collections import defaultdict
from pathlib import Path

import music21
from fastapi import FastAPI, UploadFile, File, Form, Body
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).parent
WORK = BASE / "work"
WORK.mkdir(exist_ok=True)
AUDIVERIS = str(Path.home() / "orchestra-tools" / "Audiveris.app" / "Contents" / "MacOS" / "Audiveris")

app = FastAPI()
JOBS = {}  # job_id -> {state, total, done, result, error, instrument, warnings}

# ---------- 악기 레지스트리 (확장 지점) ----------
# 새 악기 추가: 여기 항목 + 프론트(app.js)의 INSTRUMENTS 샘플만 추가하면 된다.
# OMR·MIDI 단계는 악기와 무관하므로 그대로 재사용된다.
# writtenMax: 이 악기 파트보에 "정상적으로" 적힐 수 있는 최고음(MIDI, 기보 기준).
#   파트보에는 다른 악기 큐(cue) 음표가 작게 인쇄돼 있는데 OMR이 이를 실제 음처럼 읽는다.
#   (예: "Viol. I" 큐 → E6/F6) 이 값을 넘는 음은 큐로 보고 걸러낸다.
INSTRUMENTS = {
    "contrabass": {"label": "콘트라베이스", "clef": "bass", "writtenMax": 69},  # A4
    # "cello": {"label": "첼로", "clef": "bass", "writtenMax": 76},
    # "violin": {"label": "바이올린", "clef": "treble", "writtenMax": 100},
}


def audiveris_export(pdf_path: Path, out_dir: Path):
    """Audiveris 배치 모드로 PDF 전체를 MusicXML(.mxl)로 변환. 성공 여부는 산출물 존재로 판단."""
    subprocess.run(
        [AUDIVERIS, "-batch", "-export", "-output", str(out_dir), "--", str(pdf_path)],
        capture_output=True, timeout=1800,
    )
    return sorted(out_dir.rglob("*.mxl")) or sorted(out_dir.rglob("*.xml"))


def musicxml_to_notes(xml_path: Path, offset: float):
    """MusicXML -> (음표 목록, 끝 위치(4분음표 단위), bpm 또는 None).

    첼로+베이스가 2단(divisi)으로 나뉜 구간에서는 위 staff=첼로, 아래 staff=베이스다.
    각 음표에 role을 붙인다: 'upper'(위 staff=첼로) / 'bass'(그 외=베이스·유니즌).
    music21은 2단 파트를 'X-Staff1','X-Staff2' PartStaff로 준다 → 같은 그룹에서
    staff 번호가 가장 큰 것(가장 아래)만 베이스로 보고 나머지는 첼로로 표시.
    """
    score = music21.converter.parse(str(xml_path))
    try:
        score = score.expandRepeats()  # 도돌이표 / 1·2번 볼타 펼치기 (실제 연주 순서대로)
    except Exception:
        pass  # 반복이 어긋나게 인식되면 원본(한 번만)으로 안전 폴백

    groups = defaultdict(list)
    for part in score.parts:
        m = re.match(r"(.+)-Staff(\d+)$", str(part.id or ""))
        if m:
            groups[m.group(1)].append((int(m.group(2)), id(part)))
    upper_ids = set()
    for _, lst in groups.items():
        lst.sort()
        for _, pid in lst[:-1]:  # 가장 아래(마지막) 빼고 전부 위 staff=첼로
            upper_ids.add(pid)

    notes = []
    bpm = None
    end = offset
    for part in score.parts:
        role = "upper" if id(part) in upper_ids else "bass"
        pf = part.flatten()
        if bpm is None:
            marks = pf.getElementsByClass(music21.tempo.MetronomeMark)
            if marks:
                bpm = marks[0].number
        for n in pf.notes:
            start = offset + float(n.offset)
            dur = float(n.duration.quarterLength) or 0.5
            for p in (n.pitches if n.isChord else [n.pitch]):
                notes.append({"midi": p.midi, "beat": round(start, 4),
                              "dur": round(dur, 4), "role": role})
        end = max(end, offset + float(pf.highestTime))
    return notes, end, bpm


# ---------- MIDI / MusicXML 파일에서 파트 뽑기 ----------
# 콘트라베이스 트랙 이름 후보 (앞쪽일수록 우선). "Bassoon"(파곳)에 'bass'가 들어가므로 제외해야 한다.
BASS_STRONG = ("contrabass", "double bass", "doublebass", "kontrabass",
               "contrabbasso", "콘트라베이스", "더블베이스")
BASS_WEAK = ("bassi", "basso", "bass", "베이스")
NOT_BASS = ("bassoon", "basset", "bassett", "파곳", "바순")


def tempo_map(score):
    """[(시작박, BPM), ...] — 곡 중간의 템포 변화까지 담는다."""
    marks = []
    for mm in score.flatten().getElementsByClass(music21.tempo.MetronomeMark):
        try:
            bpm = float(mm.getQuarterBPM() or 0)
        except Exception:
            bpm = float(mm.number or 0)
        if bpm > 0:
            marks.append((round(float(mm.offset), 4), round(bpm, 3)))
    marks.sort()
    if not marks or marks[0][0] > 0:
        marks.insert(0, (0.0, marks[0][1] if marks else 90.0))
    # 같은 위치 중복 제거
    out = []
    for b, t in marks:
        if out and out[-1][0] == b:
            out[-1] = (b, t)
        else:
            out.append((b, t))
    return out


def analyze_parts(path: Path):
    """악보 파일의 파트(트랙) 목록과 음역 정보를 돌려준다."""
    score = music21.converter.parse(str(path))
    tmap = tempo_map(score)
    tracks = []
    for i, part in enumerate(score.parts):
        pf = part.flatten()
        pitches = [p.midi for n in pf.notes for p in (n.pitches if n.isChord else [n.pitch])]
        if not pitches:
            continue
        pitches.sort()
        name = part.partName or ""
        if not name:
            try:
                inst = part.getInstrument(returnDefault=False)
                name = (inst.instrumentName or "") if inst else ""
            except Exception:
                name = ""
        tracks.append({
            "index": i,
            "name": name or f"트랙 {i + 1}",
            "count": len(pitches),
            "low": pitches[0],
            "high": pitches[-1],
            "median": pitches[len(pitches) // 2],
        })
    # 콘트라베이스 트랙 추천: 확실한 이름 → 약한 이름 → 그래도 없으면 가장 낮은 트랙
    def pick(words):
        for t in tracks:
            low = t["name"].lower()
            if any(bad in low for bad in NOT_BASS):
                continue
            if any(w in low for w in words):
                return t["index"]
        return None

    suggested = pick(BASS_STRONG) or pick(BASS_WEAK)
    if suggested is None and tracks:
        suggested = min(tracks, key=lambda t: t["median"])["index"]
    return score, tmap, tracks, suggested


DACAPO_RE = re.compile(r"d\.?\s*c\.?|da\s*capo|d\.?\s*s\.?|dal\s*segno", re.I)
FINE_RE = re.compile(r"fine", re.I)


def _prepare_part(score, track_index: int, expand: bool = True):
    """선택 파트에 템포 표시를 옮겨 심는다 (expand=True 면 도돌이표까지 펼친다).

    템포 표시는 보통 첫 파트에만 있어서, 그냥 파트만 펼치면 템포 위치가 어긋난다.
    그래서 먼저 해당 파트의 알맞은 마디 안에 템포를 복사한 뒤 펼친다.
    """
    part = copy.deepcopy(score.parts[track_index])
    measures = list(part.getElementsByClass(music21.stream.Measure))

    for mm in score.flatten().getElementsByClass(music21.tempo.MetronomeMark):
        off = float(mm.offset)
        target = None
        for msr in measures:
            start = float(msr.offset)
            if start <= off < start + float(msr.duration.quarterLength or 0):
                target = msr
                break
        if target is not None:
            target.insert(off - float(target.offset), copy.deepcopy(mm))
        elif measures:
            measures[0].insert(0, copy.deepcopy(mm))

    if not expand:
        return part
    try:
        return part.expandRepeats()
    except Exception:
        return part              # 반복 표시가 어긋나면 원본 그대로 (안전)


def _notes_from(stream_part, offset=0.0):
    out = []
    for n in stream_part.flatten().notes:
        beat = round(float(n.offset) + offset, 4)
        dur = round(float(n.duration.quarterLength) or 0.25, 4)
        for p in (n.pitches if n.isChord else [n.pitch]):
            out.append({"midi": p.midi, "beat": beat, "dur": dur, "role": "bass"})
    return out


def _dacapo_structure(score):
    """악보 전체에서 'Fine' 과 '다 카포' 표시를 찾아 (fine 마디번호, 다카포 있음?)을 돌려준다.
    이 표시는 보통 첫 파트(플루트 등)에만 적혀 있어서 악보 전체를 뒤져야 한다."""
    fine_measure = None
    has_dc = False
    for part in score.parts:
        for el in part.recurse():
            txt = getattr(el, "content", None) or getattr(el, "text", None)
            if not txt:
                continue
            txt = str(txt)
            msr = el.getContextByClass(music21.stream.Measure)
            if FINE_RE.search(txt) and msr is not None and fine_measure is None:
                fine_measure = msr.number
            if DACAPO_RE.search(txt):
                has_dc = True
    return fine_measure, has_dc


def _raw_tempo_marks(stream_part):
    """실제로 적혀 있는 템포 표시만 뽑는다 (없으면 빈 목록 — 기본값을 지어내지 않는다).
    구간을 이어붙일 때 앞 구간의 템포를 그대로 물려받아야 하기 때문."""
    marks = []
    for mm in stream_part.flatten().getElementsByClass(music21.tempo.MetronomeMark):
        try:
            bpm = float(mm.getQuarterBPM() or 0)
        except Exception:
            bpm = float(mm.number or 0)
        if bpm > 0:
            marks.append((round(float(mm.offset), 4), round(bpm, 3)))
    marks.sort()
    return marks


def _segment(part, first, last, expand=True):
    """마디 구간을 잘라 (음표, 템포표시, 길이)로 만든다."""
    seg = part.measures(first, last)
    if expand:
        try:
            seg = seg.expandRepeats()
        except Exception:
            pass
    return _notes_from(seg), _raw_tempo_marks(seg), float(seg.flatten().highestTime)


def octave_fix(tracks, chosen_index: int, notes):
    """콘트라베이스가 '실제 울리는 높이'로 적힌 악보를 '악보에 적힌 높이'로 맞춘다.

    파일마다 관행이 달라서, 어떤 악보는 콘트라베이스를 첼로와 같은 높이로 적고(기보 높이,
    실제로는 한 옥타브 아래로 울림) 어떤 악보는 이미 한 옥타브 내려 적어 둔다.
    그대로 두면 곡마다 '실음 8vb' 옵션이 다르게 동작하므로, 첼로보다 정확히 한 옥타브
    아래면 한 옥타브 올려 기준을 통일한다.
    """
    chosen = next((t for t in tracks if t["index"] == chosen_index), None)
    cello = next((t for t in tracks if "violoncello" in t["name"].lower()
                  or "celli" in t["name"].lower() or "cello" in t["name"].lower()), None)
    if chosen and cello and (cello["median"] - chosen["median"]) == 12:
        for n in notes:
            n["midi"] += 12
        return True
    return False


def part_to_notes(score, track_index: int):
    """선택한 파트의 (음표, 템포맵)을 실제 연주 순서로 돌려준다.
    도돌이표를 펼치고, '다 카포'가 있으면 처음~Fine 구간을 뒤에 한 번 더 붙인다."""
    prepared = _prepare_part(score, track_index, expand=False)
    fine_measure, has_dc = _dacapo_structure(score)
    measures = list(prepared.getElementsByClass(music21.stream.Measure))
    first_num = measures[0].number if measures else 1
    last_num = measures[-1].number if measures else 0

    # 다 카포 구조가 아니면: 통째로 도돌이표만 펼친다
    if not (has_dc and fine_measure and first_num < fine_measure < last_num):
        expanded = _prepare_part(score, track_index, expand=True)
        notes = _notes_from(expanded)
        return sorted(notes, key=lambda z: (z["beat"], z["midi"])), tempo_map(expanded)

    # 다 카포 구조: 앞부분(~Fine) → 뒷부분(Trio 등) → 앞부분 다시(도돌이표 없이)
    notes, tmap, offset = [], [], 0.0
    plan = [(first_num, fine_measure, True),          # 메뉴엣 (도돌이표 포함)
            (fine_measure + 1, last_num, True),       # 트리오 (도돌이표 포함)
            (first_num, fine_measure, False)]         # 다 카포 (도돌이표 없이)
    for a, b, expand in plan:
        seg_notes, seg_tempi, seg_len = _segment(prepared, a, b, expand)
        notes += [dict(n, beat=round(n["beat"] + offset, 4)) for n in seg_notes]
        tmap += [(round(t + offset, 4), bpm) for t, bpm in seg_tempi]
        offset += seg_len

    # 템포맵 정리: 같은 위치 중복 제거 + 맨 앞이 비면 첫 템포를 0박에 세운다.
    # (구간에 템포 표시가 없으면 앞 구간 템포를 그대로 물려받는다 — 새 항목을 넣지 않으므로 자동)
    tmap.sort()
    clean = []
    for b, t in tmap:
        if clean and clean[-1][0] == b:
            clean[-1] = (b, t)
        else:
            clean.append((b, t))
    if not clean:
        clean = [(0.0, 90.0)]
    elif clean[0][0] > 0:
        clean.insert(0, (0.0, clean[0][1]))

    notes.sort(key=lambda z: (z["beat"], z["midi"]))
    return notes, clean


def notes_to_midi(notes, bpm, out_path: Path):
    part = music21.stream.Part()
    part.append(music21.tempo.MetronomeMark(number=bpm))
    for nt in notes:
        m = music21.note.Note()
        m.pitch.midi = nt["midi"]
        m.quarterLength = nt["dur"]
        part.insert(nt["beat"], m)
    part.write("midi", fp=str(out_path))


def process(job_id: str, pdf_path: Path, job_dir: Path):
    """백그라운드 변환."""
    job = JOBS[job_id]
    try:
        mxls = audiveris_export(pdf_path, job_dir)
        if not mxls:
            job["state"] = "error"
            job["error"] = "악보를 인식하지 못했어요. 더 선명한(고해상도) PDF로 시도해 보세요."
            return

        all_notes, bpm, offset = [], None, 0.0
        for x in mxls:
            try:
                notes, offset, page_bpm = musicxml_to_notes(x, offset)
                all_notes += notes
                if bpm is None and page_bpm:
                    bpm = page_bpm
            except Exception as e:
                job["warnings"].append(f"{x.name}: {e}")

        if not all_notes:
            job["state"] = "error"
            job["error"] = "음표를 인식하지 못했어요."
            return

        bpm = bpm or 90
        all_notes.sort(key=lambda z: (z["beat"], z["midi"]))

        # 음역을 벗어난 음 = 다른 악기 큐(cue) 음표로 판단해 role 재지정
        wmax = INSTRUMENTS.get(job["instrument"], {}).get("writtenMax")
        cue_count = 0
        if wmax:
            for n in all_notes:
                if n["midi"] > wmax:
                    n["role"] = "cue"
                    cue_count += 1

        bass_notes = [n for n in all_notes if n["role"] == "bass"]
        # 다운로드용 MIDI는 베이스 성부만
        notes_to_midi(bass_notes, bpm, job_dir / "output.mid")
        job["result"] = {
            "instrument": job["instrument"],
            "bpm": bpm,
            "count": len(bass_notes),
            "upperCount": sum(1 for n in all_notes if n["role"] == "upper"),
            "cueCount": cue_count,
            "notes": all_notes,  # role 태그 포함 전체 (프론트에서 토글 필터)
            "midiUrl": f"/api/file/{job_id}/output.mid",
            "warnings": job["warnings"],
        }
        job["state"] = "done"
    except subprocess.TimeoutExpired:
        job["state"] = "error"
        job["error"] = "시간 초과 — 페이지 수가 너무 많습니다."
    except Exception as e:
        job["state"] = "error"
        job["error"] = str(e)


@app.post("/api/convert")
async def convert(file: UploadFile = File(...), instrument: str = Form("contrabass")):
    job_id = uuid.uuid4().hex
    job_dir = WORK / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "input.pdf").write_bytes(await file.read())
    JOBS[job_id] = {
        "state": "processing", "total": 0, "done": 0,
        "result": None, "error": None, "instrument": instrument, "warnings": [],
    }
    threading.Thread(target=process, args=(job_id, job_dir / "input.pdf", job_dir), daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/status/{job_id}")
def status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "unknown job"}, status_code=404)
    out = {"state": job["state"], "total": job["total"], "done": job["done"]}
    if job["state"] == "done":
        out["result"] = job["result"]
    elif job["state"] == "error":
        out["error"] = job["error"]
    return out


@app.get("/api/file/{job}/{name}")
def get_file(job: str, name: str):
    p = WORK / job / name
    if not p.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(p, filename=name)


@app.get("/api/instruments")
def instruments():
    return INSTRUMENTS


# ---------- 곡 라이브러리 (add_piece.py 로 미리 변환해둔 곡들) ----------
LIB = BASE / "library"
AUDIO_DIR = LIB / "audio"
AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".ogg", ".flac")


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[^\w가-힣]+", "-", text).strip("-").lower()
    return text[:48] or uuid.uuid4().hex[:8]


def beats_to_seconds(beat: float, tmap):
    """템포 변화를 반영해 '박 위치'를 '정상 속도에서의 초'로 바꾼다."""
    sec = 0.0
    for i, (b, bpm) in enumerate(tmap):
        nxt = tmap[i + 1][0] if i + 1 < len(tmap) else None
        if beat <= b:
            break
        end = beat if (nxt is None or beat < nxt) else nxt
        sec += (end - b) * 60.0 / bpm
        if nxt is None or beat < nxt:
            break
    return sec


def audio_for(piece_id: str):
    """library/audio/<piece_id>.<확장자> 가 있으면 재생용 주소를 돌려준다."""
    for ext in AUDIO_EXTS:
        f = AUDIO_DIR / (piece_id + ext)
        if f.exists():
            return f"/audio/{piece_id}{ext}"
    return None


YT_ID = re.compile(r"(?:v=|youtu\.be/|embed/|shorts/|live/)([A-Za-z0-9_-]{11})")


def youtube_id(text: str):
    """유튜브 주소(여러 형식)에서 영상 ID만 뽑는다. ID를 그대로 붙여넣어도 인식."""
    text = (text or "").strip()
    m = YT_ID.search(text)
    if m:
        return m.group(1)
    return text if re.fullmatch(r"[A-Za-z0-9_-]{11}", text) else None


def read_index():
    index = LIB / "pieces.json"
    return json.loads(index.read_text(encoding="utf-8")) if index.exists() else []


@app.get("/api/pieces")
def pieces():
    items = read_index()
    for it in items:
        it["audioUrl"] = audio_for(it["id"])
    return items


@app.post("/api/score/analyze")
async def score_analyze(file: UploadFile = File(...)):
    """MIDI / MusicXML 업로드 → 트랙 목록을 돌려준다 (아직 저장은 안 함)."""
    tmp_id = uuid.uuid4().hex
    d = WORK / tmp_id
    d.mkdir(parents=True)
    ext = Path(file.filename or "score.mid").suffix.lower() or ".mid"
    f = d / ("input" + ext)
    f.write_bytes(await file.read())
    try:
        _, tmap, tracks, suggested = analyze_parts(f)
    except Exception as e:
        return JSONResponse({"error": f"파일을 읽지 못했어요: {e}"}, status_code=422)
    if not tracks:
        return JSONResponse({"error": "음표가 있는 트랙을 찾지 못했어요."}, status_code=422)
    return {
        "tempId": tmp_id,
        "tracks": tracks,
        "suggested": suggested,
        "bpm": tmap[0][1],
        "defaultTitle": Path(file.filename or "").stem,
    }


@app.post("/api/score/save")
def score_save(payload: dict = Body(...)):
    """선택한 트랙을 라이브러리에 곡으로 저장한다."""
    tmp_id = str(payload.get("tempId", ""))
    d = WORK / tmp_id
    files = list(d.glob("input.*")) if d.exists() else []
    if not files:
        return JSONResponse({"error": "업로드한 파일을 찾지 못했어요. 다시 올려주세요."}, status_code=404)

    title = (payload.get("title") or "제목 없음").strip()
    category = payload.get("category") or "기타"
    instrument = payload.get("instrument") or "contrabass"
    try:
        track = int(payload.get("trackIndex"))
    except Exception:
        return JSONResponse({"error": "트랙을 선택해 주세요."}, status_code=400)

    try:
        score, _, tracks, _ = analyze_parts(files[0])
        notes, tmap = part_to_notes(score, track)
        octave_fix(tracks, track, notes)      # 실음 기보 악보를 기보 높이로 통일
    except Exception as e:
        return JSONResponse({"error": f"트랙을 읽지 못했어요: {e}"}, status_code=422)
    if not notes:
        return JSONResponse({"error": "선택한 트랙에 음표가 없어요."}, status_code=422)

    piece_id = slugify(title)
    LIB.mkdir(exist_ok=True)
    (LIB / f"{piece_id}.json").write_text(json.dumps({
        "bpm": tmap[0][1], "tempoMap": tmap, "notes": notes,
    }, ensure_ascii=False), encoding="utf-8")

    items = read_index()
    prev = next((i for i in items if i["id"] == piece_id), {})
    items = [i for i in items if i["id"] != piece_id]
    entry = {
        "id": piece_id, "title": title, "category": category,
        "instrument": instrument, "bpm": tmap[0][1],
        "count": len(notes), "upperCount": 0, "cueCount": 0, "source": "midi",
    }
    if prev.get("youtube"):
        entry["youtube"] = prev["youtube"]
    items.append(entry)
    items.sort(key=lambda i: (i["category"], i["title"]))
    (LIB / "pieces.json").write_text(
        json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(d, ignore_errors=True)
    return {"id": piece_id, "count": len(notes)}


@app.post("/api/piece/{piece_id}/youtube")
def set_youtube(piece_id: str, payload: dict = Body(...)):
    """곡에 원곡 유튜브 링크를 저장한다. 빈 값을 보내면 삭제."""
    raw = (payload or {}).get("url", "")
    vid = youtube_id(raw)
    if raw.strip() and not vid:
        return JSONResponse({"error": "유튜브 주소를 인식하지 못했어요."}, status_code=400)
    items = read_index()
    hit = next((i for i in items if i["id"] == piece_id), None)
    if not hit:
        return JSONResponse({"error": "not found"}, status_code=404)
    if vid:
        hit["youtube"] = vid
    else:
        hit.pop("youtube", None)
    (LIB / "pieces.json").write_text(
        json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"youtube": hit.get("youtube")}


@app.get("/api/piece/{piece_id}")
def piece(piece_id: str):
    p = (LIB / f"{piece_id}.json").resolve()
    if not str(p).startswith(str(LIB.resolve())) or not p.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    data = json.loads(p.read_text(encoding="utf-8"))
    meta = next((i for i in pieces() if i["id"] == piece_id), {})
    notes = data["notes"]
    base_bpm = data.get("bpm", 90)
    tmap = [tuple(x) for x in data.get("tempoMap") or [(0.0, base_bpm)]]

    # 박 위치 → '정상 속도에서의 초'로 변환 (곡 중간 템포 변화 반영)
    out = []
    for n in notes:
        s = beats_to_seconds(n["beat"], tmap)
        e = beats_to_seconds(n["beat"] + n["dur"], tmap)
        out.append({"midi": n["midi"], "sec": round(s, 4),
                    "dur": round(max(e - s, 0.05), 4), "role": n["role"]})

    # 메트로놈용 박 격자 (4분음표마다)
    last_beat = max((n["beat"] + n["dur"] for n in notes), default=0)
    beats = [round(beats_to_seconds(b, tmap), 4) for b in range(int(last_beat) + 2)]
    duration = max((o["sec"] + o["dur"] for o in out), default=0) + 1

    return {
        "instrument": meta.get("instrument", "contrabass"),
        "bpm": base_bpm,
        "count": sum(1 for n in notes if n["role"] == "bass"),
        "upperCount": sum(1 for n in notes if n["role"] == "upper"),
        "cueCount": sum(1 for n in notes if n["role"] == "cue"),
        "notes": out,
        "beats": beats,
        "duration": round(duration, 3),
        "title": meta.get("title", piece_id),
        "youtube": meta.get("youtube"),
        "audioUrl": audio_for(piece_id),
        "source": meta.get("source", "pdf"),
    }


@app.get("/")
def index():
    """index.html 을 주면서 css/js 링크에 파일 수정시각을 붙인다.
    (파일을 고치면 주소가 바뀌므로 브라우저가 옛 캐시를 쓰지 않는다)"""
    html = (BASE / "index.html").read_text(encoding="utf-8")
    for name in ("style.css", "app.js"):
        f = BASE / name
        if f.exists():
            html = html.replace(f"/static/{name}", f"/static/{name}?v={int(f.stat().st_mtime)}")
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=str(BASE)), name="static")

# 원곡 음원 파일을 직접 넣어 쓰고 싶을 때: library/audio/<곡id>.mp3
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/audio", StaticFiles(directory=str(AUDIO_DIR)), name="audio")
