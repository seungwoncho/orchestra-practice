// Cho's TEST — 라이브러리에서 곡을 골라 내 파트만 재생/추출한다.
//
// 재생 시간 계산 방식:
//   서버가 각 음표를 '정상 속도에서의 초(sec)'로 내려준다 (곡 중간 템포 변화 반영 완료).
//   Tone.Transport 의 BPM 을 60×속도 로 두면 트랜스포트의 1박 = 1초(정상 속도)가 되어,
//   sec 값을 그대로 스케줄에 쓸 수 있고 속도 조절도 한 번에 처리된다.

// ---------- 악기 레지스트리 (확장 지점) ----------
const INSTRUMENTS = {
  contrabass: {
    label: "콘트라베이스",
    baseUrl: "https://nbrosowsky.github.io/tonejs-instruments/samples/contrabass/",
    urls: {
      "F#1": "Fs1.mp3", "G1": "G1.mp3", "A#1": "As1.mp3", "C2": "C2.mp3",
      "D2": "D2.mp3", "E2": "E2.mp3", "A2": "A2.mp3", "E3": "E3.mp3",
    },
  },
};

const SKIP = 10; // 앞/뒤로 건너뛸 초

// ---------- 데이터 접근 (서버 모드 / 정적 모드) ----------
// 정적 배포판에는 파이썬 서버가 없으므로 미리 구운 JSON 을 읽고,
// 유튜브 링크는 이 브라우저(localStorage)에 저장한다.
const STATIC = !!window.STATIC_MODE;
const YT_KEY = "chostest.youtube";

const ytStore = {
  all: () => { try { return JSON.parse(localStorage.getItem(YT_KEY) || "{}"); } catch { return {}; } },
  get(id) { return this.all()[id] || null; },
  set(id, v) {
    const m = this.all();
    if (v) m[id] = v; else delete m[id];
    localStorage.setItem(YT_KEY, JSON.stringify(m));
  },
};

// 유튜브 주소에서 영상 ID 11자리만 뽑기 (정적 모드용)
function parseYouTubeId(text) {
  const s = (text || "").trim();
  const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
}

const api = {
  async pieces() {
    const r = await fetch(STATIC ? "data/pieces.json" : "/api/pieces");
    const list = await r.json();
    if (STATIC) list.forEach((p) => { p.youtube = ytStore.get(p.id) || p.youtube || null; });
    return list;
  },
  async piece(id) {
    const r = await fetch(STATIC ? `data/${encodeURIComponent(id)}.json`
                                 : `/api/piece/${encodeURIComponent(id)}`);
    const d = await r.json();
    if (STATIC) d.youtube = ytStore.get(id) || d.youtube || null;
    return d;
  },
  async setYouTube(id, url) {
    if (STATIC) {
      const vid = parseYouTubeId(url);
      if (url.trim() && !vid) throw new Error("유튜브 주소를 인식하지 못했어요.");
      ytStore.set(id, vid);
      return { youtube: vid };
    }
    const r = await fetch(`/api/piece/${encodeURIComponent(id)}/youtube`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "저장 실패");
    return d;
  },
};

// ---------- 상태 ----------
let notes = [];        // [{midi, sec, dur, role}]
let beatGrid = [];     // 메트로놈용 박 위치(초)
let duration = 0;      // 전체 길이(초, 정상 속도)
let instrument = "contrabass";
let sampler = null, loadedInstrument = null, clickSynth = null;
let notePart = null, clickPart = null;
let seeking = false, ready = false;
let currentPieceId = null;
let analyzed = null;   // MIDI 분석 결과

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const pieceSel = $("piece"), infoEl = $("info"), statusEl = $("status"), player = $("player");
const seek = $("seek"), curTime = $("curTime"), totTime = $("totTime");
const playBtn = $("playBtn"), backBtn = $("backBtn"), fwdBtn = $("fwdBtn");
const speedSlider = $("speed"), speedValue = $("speedValue");
const metroSel = $("metronome"), metroNote = $("metroNote");
const celloRow = $("celloRow"), includeCello = $("includeCello"), celloNote = $("celloNote");
const octaveDown = $("octaveDown"), wavBtn = $("wavBtn");
const origWrap = $("origWrap"), ytHolder = $("ytHolder"), ytForm = $("ytForm");
const ytUrl = $("ytUrl"), ytSave = $("ytSave"), ytEdit = $("ytEdit");
const scoreFile = $("scoreFile"), analyzeBtn = $("analyzeBtn"), trackBox = $("trackBox");
const trackList = $("trackList"), trackHint = $("trackHint");
const newTitle = $("newTitle"), newCategory = $("newCategory"), saveScoreBtn = $("saveScoreBtn");

const setStatus = (m, err) => { statusEl.textContent = m; statusEl.style.color = err ? "#c0392b" : ""; };
const midiToNote = (m) => Tone.Frequency(m, "midi").toNote();
const speed = () => Number(speedSlider.value) / 100;
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

// 슬라이더의 채워진 구간 표시
function paint(el) {
  const min = Number(el.min) || 0, max = Number(el.max) || 100;
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--p", pct.toFixed(2));
}

// 재생할 음표: role bass(내 파트) + 옵션에 따라 upper(첼로). cue(다른 악기)는 항상 제외.
function activeNotes() {
  const keep = notes.filter((n) =>
    n.role === "bass" || (includeCello.checked && n.role === "upper"));
  const shift = octaveDown.checked ? -12 : 0;
  return shift ? keep.map((n) => ({ ...n, midi: n.midi + shift })) : keep;
}

// 현재 재생 위치(초, 정상 속도 기준)
const position = () => Tone.Transport.ticks / Tone.Transport.PPQ;

// ---------- 곡 목록 ----------
async function loadPieces(selectId) {
  try {
    const list = await api.pieces();
    pieceSel.innerHTML = "";
    if (!list.length) {
      pieceSel.innerHTML = '<option value="">(등록된 곡이 없어요)</option>';
      setStatus("아래 '새 곡 추가'에서 MIDI 파일을 올려보세요.");
      return;
    }
    const ph = document.createElement("option");
    ph.value = ""; ph.textContent = "— 곡을 선택하세요 —";
    pieceSel.appendChild(ph);
    const byCat = {};
    list.forEach((p) => (byCat[p.category] = byCat[p.category] || []).push(p));
    for (const [cat, items] of Object.entries(byCat)) {
      const g = document.createElement("optgroup");
      g.label = cat;
      items.forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.title;
        g.appendChild(o);
      });
      pieceSel.appendChild(g);
    }
    if (selectId) { pieceSel.value = selectId; await selectPiece(selectId); }
    else setStatus("곡을 선택하면 바로 재생할 수 있어요.");
  } catch (e) {
    setStatus("곡 목록을 불러오지 못했어요: " + e.message, true);
  }
}

// ---------- 원곡 유튜브 ----------
function renderYouTube(videoId) {
  if (videoId) {
    ytHolder.innerHTML =
      `<iframe src="https://www.youtube-nocookie.com/embed/${videoId}" title="원곡"
        frameborder="0" allowfullscreen
        allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"></iframe>`;
    ytHolder.hidden = false; ytForm.hidden = true; ytEdit.hidden = false;
  } else {
    ytHolder.innerHTML = "";
    ytHolder.hidden = true; ytForm.hidden = false; ytEdit.hidden = true;
  }
}

async function saveYouTube() {
  if (!currentPieceId) return;
  ytSave.disabled = true;
  try {
    const d = await api.setYouTube(currentPieceId, ytUrl.value);
    renderYouTube(d.youtube);
    setStatus(d.youtube ? "원곡 링크를 저장했어요." : "원곡 링크를 지웠어요.");
  } catch (e) {
    setStatus("저장 실패: " + e.message, true);
  } finally { ytSave.disabled = false; }
}

// ---------- 곡 선택 ----------
async function selectPiece(id) {
  stop();
  currentPieceId = id;
  if (!id) { player.hidden = true; origWrap.hidden = true; infoEl.textContent = ""; return; }
  setStatus("불러오는 중…");
  try {
    const d = await api.piece(id);
    notes = d.notes;
    beatGrid = d.beats || [];
    duration = d.duration || 0;
    instrument = d.instrument || "contrabass";

    const extra = [];
    if (d.upperCount > 0) {
      celloRow.hidden = false; includeCello.checked = false;
      celloNote.textContent = `첼로 ${d.upperCount}개`;
      extra.push(`첼로 ${d.upperCount}개 분리`);
    } else celloRow.hidden = true;
    if (d.cueCount > 0) extra.push(`큐 ${d.cueCount}개 제외`);
    if (d.source === "midi") extra.push("MIDI");
    infoEl.textContent = `${INSTRUMENTS[instrument].label} · 내 파트 ${d.count}개`
      + (extra.length ? ` (${extra.join(", ")})` : "");

    origWrap.hidden = false;
    ytUrl.value = "";
    renderYouTube(d.youtube);

    player.hidden = false;
    seek.max = duration.toFixed(2);
    totTime.textContent = fmt(duration);
    seek.value = 0; curTime.textContent = "0:00";
    paint(seek); paint(speedSlider);

    setStatus("악기 음색 불러오는 중…");
    await ensureSampler(instrument);
    setStatus("준비 완료 — ▶ 를 눌러보세요.");
  } catch (e) {
    setStatus("곡을 불러오지 못했어요: " + e.message, true);
  }
}

// ---------- 오디오 준비 ----------
// 실제 녹음 샘플을 못 받아오면(오프라인·차단 환경) 합성음으로 대신한다
function makeSynthBass() {
  return new Tone.PolySynth(Tone.MonoSynth, {
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.02, decay: 0.25, sustain: 0.55, release: 0.5 },
    filterEnvelope: { attack: 0.02, decay: 0.3, sustain: 0.4, baseFrequency: 110, octaves: 2.4 },
    volume: -6,
  }).toDestination();
}

async function ensureSampler(key) {
  await Tone.start();
  ready = true;
  if (loadedInstrument === key && sampler) return;
  if (sampler) sampler.dispose();

  const inst = INSTRUMENTS[key];
  if (window.NO_EXTERNAL || !inst.baseUrl) {   // 외부 접속이 막힌 배포판
    sampler = makeSynthBass();
    loadedInstrument = key;
    return;
  }
  try {
    sampler = new Tone.Sampler({ urls: inst.urls, baseUrl: inst.baseUrl, release: 0.6 }).toDestination();
    await Promise.race([
      Tone.loaded(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
    ]);
  } catch (e) {
    if (sampler) sampler.dispose();
    sampler = makeSynthBass();                 // 샘플 실패 → 합성음으로 계속 진행
    setStatus("악기 샘플을 못 받아와 합성음으로 재생해요.");
  }
  loadedInstrument = key;
}

function getClick() {
  if (!clickSynth) {
    clickSynth = new Tone.Synth({
      oscillator: { type: "square" },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
    }).toDestination();
    clickSynth.volume.value = -14;
  }
  return clickSynth;
}

// ---------- 스케줄링 ----------
function schedule() {
  Tone.Transport.cancel();
  if (notePart) notePart.dispose();
  if (clickPart) clickPart.dispose();

  const ppq = Tone.Transport.PPQ;
  // 트랜스포트 1박 = 정상 속도 1초 → sec 값을 그대로 위치로 쓴다
  notePart = new Tone.Part((time, ev) => {
    sampler.triggerAttackRelease(midiToNote(ev.midi), ev.dur / speed(), time);
  }, activeNotes().map((n) => ({ time: Math.round(n.sec * ppq) + "i", midi: n.midi, dur: n.dur })));
  notePart.start(0);

  // 메트로놈: '인 N' = N박마다 첫 박에 강세 (박 격자 위에 올리므로 구간 이동해도 안 어긋남)
  clickPart = new Tone.Part((time, ev) => {
    const n = Number(metroSel.value);
    if (n > 0) getClick().triggerAttackRelease(ev.i % n === 0 ? "G5" : "C5", "32n", time);
  }, beatGrid.map((sec, i) => ({ time: Math.round(sec * ppq) + "i", i })));
  clickPart.start(0);
}

// ---------- 재생 컨트롤 ----------
async function togglePlay() {
  if (!notes.length) return;
  if (Tone.Transport.state === "started") {
    Tone.Transport.pause();
    playBtn.textContent = "▶";
    return;
  }
  await ensureSampler(instrument);
  if (!notePart) schedule();
  Tone.Transport.bpm.value = 60 * speed();
  Tone.Transport.start();
  playBtn.textContent = "❚❚";
}

function stop() {
  Tone.Transport.stop();
  Tone.Transport.ticks = 0;
  playBtn.textContent = "▶";
  seek.value = 0; curTime.textContent = "0:00";
  paint(seek);
}

function seekTo(sec) {
  const t = Math.min(Math.max(0, sec), duration);
  Tone.Transport.ticks = t * Tone.Transport.PPQ;
  seek.value = t; curTime.textContent = fmt(t);
  paint(seek);
}

const skip = (delta) => seekTo(position() + delta);

function tick() {
  if (ready && !seeking && Tone.Transport.state === "started") {
    const t = position();
    if (t >= duration) stop();
    else { seek.value = t; curTime.textContent = fmt(t); paint(seek); }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- WAV 저장 (메트로놈 없이 내 파트만) ----------
async function downloadWav() {
  const ns = activeNotes();
  if (!ns.length) return;
  wavBtn.disabled = true;
  setStatus("WAV 렌더링 중…");
  const sp = speed();
  const inst = INSTRUMENTS[instrument];
  try {
    const useSynth = window.NO_EXTERNAL || !inst.baseUrl;
    const buffer = await Tone.Offline(async () => {
      const s = useSynth
        ? makeSynthBass()
        : new Tone.Sampler({ urls: inst.urls, baseUrl: inst.baseUrl, release: 0.6 }).toDestination();
      if (!useSynth) await Tone.loaded();
      ns.forEach((n) => s.triggerAttackRelease(midiToNote(n.midi), n.dur / sp, n.sec / sp));
    }, duration / sp);
    const url = URL.createObjectURL(new Blob([audioBufferToWav(buffer.get())], { type: "audio/wav" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = (pieceSel.options[pieceSel.selectedIndex]?.textContent || "part") + ".wav";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("WAV 저장 완료.");
  } catch (e) {
    setStatus("WAV 실패: " + e.message, true);
  } finally { wavBtn.disabled = false; }
}

function audioBufferToWav(buffer) {
  const numCh = buffer.numberOfChannels, sr = buffer.sampleRate;
  const total = buffer.length * numCh * 2 + 44;
  const ab = new ArrayBuffer(total), view = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  let o = 0;
  w(o, "RIFF"); o += 4; view.setUint32(o, total - 8, true); o += 4; w(o, "WAVE"); o += 4;
  w(o, "fmt "); o += 4; view.setUint32(o, 16, true); o += 4; view.setUint16(o, 1, true); o += 2;
  view.setUint16(o, numCh, true); o += 2; view.setUint32(o, sr, true); o += 4;
  view.setUint32(o, sr * numCh * 2, true); o += 4; view.setUint16(o, numCh * 2, true); o += 2;
  view.setUint16(o, 16, true); o += 2;
  w(o, "data"); o += 4; view.setUint32(o, buffer.length * numCh * 2, true); o += 4;
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return ab;
}

// ---------- 새 곡 추가: MIDI / MusicXML ----------
const noteName = (m) => {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return names[m % 12] + (Math.floor(m / 12) - 1);
};

async function analyzeScore() {
  const f = scoreFile.files[0];
  if (!f) { setStatus("MIDI 또는 MusicXML 파일을 선택하세요.", true); return; }
  analyzeBtn.disabled = true;
  setStatus("파일 분석 중…");
  try {
    const fd = new FormData();
    fd.append("file", f);
    const r = await fetch("/api/score/analyze", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) { setStatus(d.error || "분석 실패", true); return; }
    analyzed = d;
    renderTracks(d);
    newTitle.value = d.defaultTitle || "";
    trackBox.hidden = false;
    setStatus(`트랙 ${d.tracks.length}개를 찾았어요. 내 파트를 고르세요.`);
  } catch (e) {
    setStatus("분석 실패: " + e.message, true);
  } finally { analyzeBtn.disabled = false; }
}

function renderTracks(d) {
  trackHint.textContent = d.suggested !== null ? "(추천 트랙이 미리 선택돼 있어요)" : "";
  trackList.innerHTML = "";
  d.tracks.forEach((t) => {
    const id = "trk" + t.index;
    const row = document.createElement("label");
    row.className = "trackrow";
    row.innerHTML =
      `<input type="radio" name="track" value="${t.index}" id="${id}" ${t.index === d.suggested ? "checked" : ""}>
       <span class="tname">${t.name}</span>
       <span class="tmeta">${noteName(t.low)}–${noteName(t.high)} · ${t.count}개</span>`;
    trackList.appendChild(row);
  });
}

async function saveScore() {
  if (!analyzed || !trackList) return;
  const sel = trackList.querySelector('input[name="track"]:checked');
  if (!sel) { setStatus("트랙을 선택하세요.", true); return; }
  if (!newTitle.value.trim()) { setStatus("곡 제목을 입력하세요.", true); return; }
  saveScoreBtn.disabled = true;
  setStatus("저장 중…");
  try {
    const r = await fetch("/api/score/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tempId: analyzed.tempId, trackIndex: Number(sel.value),
        title: newTitle.value.trim(), category: newCategory.value,
      }),
    });
    const d = await r.json();
    if (!r.ok) { setStatus(d.error || "저장 실패", true); return; }
    trackBox.hidden = true;
    scoreFile.value = "";
    analyzed = null;
    $("addBox").open = false;
    await loadPieces(d.id);
    setStatus(`저장 완료 — 음표 ${d.count}개.`);
  } catch (e) {
    setStatus("저장 실패: " + e.message, true);
  } finally { saveScoreBtn.disabled = false; }
}

// ═══════════════ 단독 메트로놈 ═══════════════
// 곡과 무관하게 혼자 돌아간다. 별도의 Tone.Loop 를 쓰므로 파트 재생과 섞이지 않는다.
const mBpm = $("mBpm"), mBpmVal = $("mBpmVal"), mBeatSel = $("mBeat"), mBeatNote = $("mBeatNote");
const mSub = $("mSub"), mToggle = $("mToggle"), mTap = $("mTap"), mBeatsBox = $("mBeats");
const mMark = $("mMark"), mMinus = $("mMinus"), mPlus = $("mPlus");

let mLoop = null, mCount = 0, mRunning = false, mSynth = null, taps = [];

// 이탈리아어 빠르기말 (참고용)
const TEMPO_WORDS = [
  [40, "Grave"], [46, "Largo"], [52, "Lento"], [56, "Adagio"], [66, "Adagietto"],
  [76, "Andante"], [96, "Moderato"], [112, "Allegretto"], [132, "Allegro"],
  [160, "Vivace"], [184, "Presto"], [999, "Prestissimo"],
];
const tempoWord = (b) => TEMPO_WORDS.find(([lim]) => b < lim)[1];

function mClick() {
  if (!mSynth) {
    mSynth = new Tone.Synth({
      oscillator: { type: "square" },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
    }).toDestination();
  }
  return mSynth;
}

// 박자 점 그리기
function drawBeats() {
  const n = Number(mBeatSel.value);
  mBeatsBox.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const d = document.createElement("span");
    d.className = "mdot";
    mBeatsBox.appendChild(d);
  }
}

function lightBeat(i) {
  const dots = mBeatsBox.children;
  for (let k = 0; k < dots.length; k++) dots[k].classList.toggle("on", k === i);
}

async function mStart() {
  await Tone.start();
  if (mLoop) mLoop.dispose();
  mCount = 0;
  const sub = Number(mSub.value);

  // 보조 클릭까지 고려해 잘게 쪼갠 간격으로 돈다
  mLoop = new Tone.Loop((time) => {
    const n = Number(mBeatSel.value);
    const isMain = mCount % sub === 0;
    const beatIdx = Math.floor(mCount / sub) % n;
    const s = mClick();
    if (isMain) {
      const strong = beatIdx === 0;
      s.volume.value = strong ? -6 : -12;
      s.triggerAttackRelease(strong ? "G5" : "C5", "32n", time);
      Tone.Draw.schedule(() => lightBeat(beatIdx), time);
    } else {
      s.volume.value = -22;                       // 보조 클릭은 작게
      s.triggerAttackRelease("C6", "64n", time);
    }
    mCount++;
  }, 60 / Number(mBpm.value) / sub);

  Tone.Transport.start();          // 파트 재생과 공유하지만 메트로놈 루프는 독립
  mLoop.start(0);
  mRunning = true;
  mToggle.textContent = "■ 정지";
  mToggle.classList.add("on");
}

function mStop() {
  if (mLoop) { mLoop.dispose(); mLoop = null; }
  mRunning = false;
  mCount = 0;
  lightBeat(-1);
  mToggle.textContent = "▶ 시작";
  mToggle.classList.remove("on");
}

const mToggleRun = () => (mRunning ? mStop() : mStart());

function setBpm(v) {
  const b = Math.min(240, Math.max(30, Math.round(v)));
  mBpm.value = b;
  mBpmVal.textContent = b;
  mMark.textContent = tempoWord(b);
  paint(mBpm);
  if (mLoop) mLoop.interval = 60 / b / Number(mSub.value);
}

// 탭 템포: 두드린 간격의 평균으로 BPM 계산
function tapTempo() {
  const now = performance.now();
  taps = taps.filter((t) => now - t < 3000);
  taps.push(now);
  if (taps.length >= 2) {
    const gaps = taps.slice(1).map((t, i) => t - taps[i]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    setBpm(60000 / avg);
  }
}

mBpm.addEventListener("input", (e) => setBpm(Number(e.target.value)));
mMinus.addEventListener("click", () => setBpm(Number(mBpm.value) - 1));
mPlus.addEventListener("click", () => setBpm(Number(mBpm.value) + 1));
mToggle.addEventListener("click", mToggleRun);
mTap.addEventListener("click", tapTempo);
mBeatSel.addEventListener("change", () => {
  mBeatNote.textContent = `${mBeatSel.value}박마다 강세`;
  drawBeats();
  mCount = 0;
});
mSub.addEventListener("change", () => {
  if (mLoop) mLoop.interval = 60 / Number(mBpm.value) / Number(mSub.value);
  mCount = 0;
});

// ---------- 탭 전환 ----------
const practiceTab = $("practiceTab"), metroTab = $("metroTab");
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    const isMetro = btn.dataset.tab === "metro";
    metroTab.hidden = !isMetro;
    practiceTab.hidden = isMetro;
    if (isMetro) { stop(); } else { mStop(); }
  });
});

drawBeats();
setBpm(90);

// ---------- 이벤트 ----------
pieceSel.addEventListener("change", (e) => selectPiece(e.target.value));
playBtn.addEventListener("click", togglePlay);
backBtn.addEventListener("click", () => skip(-SKIP));
fwdBtn.addEventListener("click", () => skip(SKIP));
wavBtn.addEventListener("click", downloadWav);
// 업로드 UI 는 정적 배포판에 없으므로 있을 때만 연결한다
if (analyzeBtn) analyzeBtn.addEventListener("click", analyzeScore);
if (saveScoreBtn) saveScoreBtn.addEventListener("click", saveScore);

ytSave.addEventListener("click", saveYouTube);
ytUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") saveYouTube(); });
ytEdit.addEventListener("click", () => {
  ytForm.hidden = !ytForm.hidden;
  if (!ytForm.hidden) ytUrl.focus();
});

seek.addEventListener("input", () => {
  seeking = true;
  curTime.textContent = fmt(Number(seek.value));
  paint(seek);
});
seek.addEventListener("change", () => { seekTo(Number(seek.value)); seeking = false; });

speedSlider.addEventListener("input", (e) => {
  speedValue.textContent = e.target.value + "%";
  paint(speedSlider);
  Tone.Transport.bpm.value = 60 * speed();
});

metroSel.addEventListener("change", () => {
  const n = Number(metroSel.value);
  metroNote.textContent = n > 0 ? `${n}박마다 강세` : "꺼짐";
});

[includeCello, octaveDown].forEach((el) => el.addEventListener("change", () => {
  const wasPlaying = Tone.Transport.state === "started";
  const at = position();
  schedule();
  seekTo(at);
  if (wasPlaying) Tone.Transport.start();
}));

document.addEventListener("keydown", (e) => {
  const t = e.target.tagName;
  if (t === "SELECT" || t === "INPUT" || t === "TEXTAREA") return;
  const onMetro = !metroTab.hidden;

  if (e.code === "Space") {                 // 스페이스: 현재 탭의 재생/정지
    e.preventDefault();
    onMetro ? mToggleRun() : togglePlay();
  } else if (e.key === "t" || e.key === "T") {
    if (onMetro) { e.preventDefault(); tapTempo(); }
  } else if (onMetro && (e.code === "ArrowUp" || e.code === "ArrowDown")) {
    e.preventDefault();
    setBpm(Number(mBpm.value) + (e.code === "ArrowUp" ? 1 : -1));
  } else if (!onMetro && e.code === "ArrowLeft") { e.preventDefault(); skip(-SKIP); }
  else if (!onMetro && e.code === "ArrowRight") { e.preventDefault(); skip(SKIP); }
});

loadPieces();
