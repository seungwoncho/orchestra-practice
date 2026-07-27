"""파이프라인 1페이지 검증: PDF -> PNG -> oemer -> 음표. (oemer 첫 실행은 모델 다운로드로 느림)"""
import glob
import time
from pathlib import Path

import fitz
import server

pdfs = sorted(glob.glob("*.pdf"))
assert pdfs, "PDF 없음"
pdf = Path(pdfs[0])
print("PDF:", pdf.name, flush=True)

work = server.WORK / "smoke"
work.mkdir(parents=True, exist_ok=True)

doc = fitz.open(pdf)
print("PAGES:", doc.page_count, flush=True)
doc.close()

pngs = server.pdf_to_pngs(pdf, work)
print("rendered pages:", len(pngs), flush=True)

t = time.time()
xml = server.png_to_musicxml(pngs[0], work)
print(f"oemer page0 -> {xml} ({time.time()-t:.0f}s)", flush=True)

notes, bpm = server.musicxml_files_to_notes([xml])
print("NOTES:", len(notes), "BPM:", bpm, flush=True)
print("first 12:", notes[:12], flush=True)
