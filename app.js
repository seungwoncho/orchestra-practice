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

const SKIP = 10;          // 앞/뒤로 건너뛸 초
const BASS_GAIN_DB = 9;   // 악기 기본 음량 올림 (0 = 예전 크기)

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

// 데이터 주소에 배포 버전을 붙인다 (새로 배포하면 브라우저가 옛 데이터를 안 쓰도록)
const dataUrl = (path) => path + (window.DATA_VERSION ? `?v=${window.DATA_VERSION}` : "");

// JSON 을 안전하게 읽는다.
// 배포 도중에 접속하면 서버가 잠깐 오류 페이지(HTML)를 주는데, 브라우저가 그걸 캐시해
// 계속 실패하는 일이 있다. 그래서 캐시를 건너뛰고 몇 번 다시 시도한다.
async function getJSON(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, attempt === 0 ? {} : { cache: "reload" });
      const text = await r.text();
      if (!r.ok) throw new Error("HTTP " + r.status);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const api = {
  async pieces() {
    const list = await getJSON(STATIC ? dataUrl("data/pieces.json") : "/api/pieces");
    if (STATIC) list.forEach((p) => { p.youtube = ytStore.get(p.id) || p.youtube || null; });
    return list;
  },
  async piece(id) {
    const d = await getJSON(STATIC ? dataUrl(`data/${encodeURIComponent(id)}.json`)
                                   : `/api/piece/${encodeURIComponent(id)}`);
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
let firstNoteAt = 0;   // 첫 콘트라베이스 음표 위치(긴 쉼표 안내용)
let instrument = "contrabass";
let sampler = null, loadedInstrument = null, loadedSoundMode = null, clickSynth = null;
let notePart = null, clickPart = null;
let seeking = false, ready = false;
let currentPieceId = null;
let loopStart = null, loopEnd = null;   // 구간 반복 (초)
let analyzed = null;   // MIDI 분석 결과

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const pieceSel = $("piece"), infoEl = $("info"), statusEl = $("status"), player = $("player");
const seek = $("seek"), curTime = $("curTime"), totTime = $("totTime");
const playBtn = $("playBtn"), backBtn = $("backBtn"), fwdBtn = $("fwdBtn");
const speedSlider = $("speed"), speedValue = $("speedValue");
const volSlider = $("volume"), volValue = $("volumeValue");
const metroSel = $("metronome"), metroNote = $("metroNote");
const celloRow = $("celloRow"), includeCello = $("includeCello"), celloNote = $("celloNote");
const octaveDown = $("octaveDown"), wavBtn = $("wavBtn");
const loopABtn = $("loopA"), loopBBtn = $("loopB"), loopClearBtn = $("loopClear"), loopInfo = $("loopInfo");
const countIn = $("countIn");
const origWrap = $("origWrap"), ytHolder = $("ytHolder"), ytForm = $("ytForm");
const ytUrl = $("ytUrl"), ytSave = $("ytSave"), ytEdit = $("ytEdit");
const scoreFile = $("scoreFile"), analyzeBtn = $("analyzeBtn"), trackBox = $("trackBox");
const trackList = $("trackList"), trackHint = $("trackHint");
const newTitle = $("newTitle"), newCategory = $("newCategory"), saveScoreBtn = $("saveScoreBtn");
const metroStatus = $("metroStatus");
const broadcastBtn = $("broadcastBtn"), broadcastMessage = $("broadcastMessage");
const scoldBtn = $("scoldBtn"), scoldMessage = $("scoldMessage");

const BROADCAST_TEXT = "곧 cho's test가 시작됩니다. 마음을 가다듬고 베이스를 준비하시길 바랍니다.";
const SCOLD_TEXT = "땡!";
let broadcastUtterance = null, scoldUtterance = null;

function finishBroadcast() {
  broadcastUtterance = null;
  broadcastBtn.classList.remove("on");
  broadcastBtn.setAttribute("aria-pressed", "false");
  broadcastBtn.innerHTML = '<span aria-hidden="true">📢</span> TEST 사전방송';
  broadcastMessage.hidden = true;
  broadcastMessage.textContent = "";
}

function finishScold() {
  scoldUtterance = null;
  scoldBtn.classList.remove("on");
  scoldBtn.setAttribute("aria-pressed", "false");
  scoldMessage.hidden = true;
  scoldMessage.textContent = "";
}

function chooseKoreanVoice(voices) {
  const korean = voices.filter((voice) =>
    (voice.lang || "").replace("_", "-").toLowerCase().startsWith("ko"));
  const preferred = [
    /microsoft.*(sunhi|injoon).*natural/i,
    /(premium|enhanced)/i,
    /google.*(한국|korean)/i,
    /^yuna$/i,
    /siri/i,
  ];
  for (const pattern of preferred) {
    const match = korean.find((voice) => pattern.test(voice.name));
    if (match) return match;
  }
  // macOS의 캐릭터 음성은 안내방송에 어울리지 않아 기본 후보에서 제외한다.
  const novelty = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)/i;
  return korean.find((voice) => !novelty.test(voice.name)) || korean[0] || null;
}

function chooseMaleKoreanVoice(voices) {
  const korean = voices.filter((voice) =>
    (voice.lang || "").replace("_", "-").toLowerCase().startsWith("ko"));
  const preferred = [
    /microsoft.*injoon.*natural/i,
    /microsoft.*injoon/i,
    /google.*(한국|korean).*male/i,
    /^(injoon|junwoo|hyunsu|minsu)/i,
    /^(eddy|reed|rocko|grandpa)/i,
  ];
  for (const pattern of preferred) {
    const match = korean.find((voice) => pattern.test(voice.name));
    if (match) return match;
  }
  return korean.find((voice) => !/(yuna|sunhi|sandy|shelley|flo|grandma)/i.test(voice.name))
    || korean[0]
    || null;
}

function toggleBroadcast() {
  broadcastMessage.textContent = BROADCAST_TEXT;
  broadcastMessage.hidden = false;

  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    broadcastMessage.textContent += " (이 브라우저에서는 음성 방송을 지원하지 않아요.)";
    return;
  }

  if (broadcastUtterance) {
    window.speechSynthesis.cancel();
    finishBroadcast();
    return;
  }
  if (scoldUtterance || window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    finishScold();
  }

  const utterance = new SpeechSynthesisUtterance(BROADCAST_TEXT);
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = chooseKoreanVoice(voices);
  utterance.lang = "ko-KR";
  utterance.rate = 0.94;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onend = finishBroadcast;
  utterance.onerror = finishBroadcast;
  broadcastUtterance = utterance;
  broadcastBtn.classList.add("on");
  broadcastBtn.setAttribute("aria-pressed", "true");
  broadcastBtn.innerHTML = '<span aria-hidden="true">■</span> 방송 중지';
  window.speechSynthesis.speak(utterance);
}

function playScold() {
  scoldMessage.textContent = SCOLD_TEXT;
  scoldMessage.hidden = false;

  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    scoldMessage.textContent += " (이 브라우저에서는 음성을 지원하지 않아요.)";
    return;
  }

  if (scoldUtterance) {
    window.speechSynthesis.cancel();
    finishScold();
    return;
  }
  if (broadcastUtterance || window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    finishBroadcast();
  }

  const utterance = new SpeechSynthesisUtterance(SCOLD_TEXT);
  utterance.voice = chooseMaleKoreanVoice(window.speechSynthesis.getVoices());
  utterance.lang = "ko-KR";
  utterance.rate = 0.78;
  utterance.pitch = 0.65;
  utterance.volume = 1;
  utterance.onend = finishScold;
  utterance.onerror = finishScold;
  scoldUtterance = utterance;
  scoldBtn.classList.add("on");
  scoldBtn.setAttribute("aria-pressed", "true");
  window.speechSynthesis.speak(utterance);
}

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
    // 지난번에 듣던 곡이 아직 목록에 있으면 그대로 이어서
    const wanted = selectId || pendingPiece;
    pendingPiece = null;
    if (wanted && [...pieceSel.options].some((o) => o.value === wanted)) {
      pieceSel.value = wanted;
      await selectPiece(wanted);
    } else {
      setStatus("곡을 선택하면 바로 재생할 수 있어요.");
    }
  } catch (e) {
    setStatus("곡 목록을 불러오지 못했어요: " + e.message, true);
  }
}

// ---------- 원곡 유튜브 ----------
function renderYouTube(videoId) {
  if (videoId) {
    // 외부 삽입이 막힌 배포판에서는 새 탭으로 여는 링크로 대신한다
    ytHolder.innerHTML = window.NO_EXTERNAL
      ? `<a class="ytlink" href="https://www.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener">
           ▶ 유튜브에서 원곡 열기</a>`
      : `<iframe src="https://www.youtube-nocookie.com/embed/${videoId}" title="원곡"
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
  clearLoop();
  // 이전 곡의 재생 스케줄을 반드시 버린다.
  // 안 버리면 곡을 바꿔도 예전 곡이 그대로 흘러나온다.
  if (notePart) { notePart.dispose(); notePart = null; }
  if (clickPart) { clickPart.dispose(); clickPart = null; }
  Tone.Transport.cancel();
  currentPieceId = id;
  savePrefs();
  if (!id) { player.hidden = true; origWrap.hidden = true; infoEl.textContent = ""; ready = false; return; }
  ready = false;
  playBtn.disabled = true;
  wavBtn.disabled = true;
  setStatus("불러오는 중…");
  try {
    const d = await api.piece(id);
    notes = d.notes;
    beatGrid = d.beats || [];
    duration = d.duration || 0;
    firstNoteAt = notes.reduce((min, note) =>
      note.role === "bass" ? Math.min(min, Number(note.sec) || 0) : min, Infinity);
    if (!Number.isFinite(firstNoteAt)) firstNoteAt = 0;
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
    const soundMode = await ensureSampler(instrument);
    const firstNoteHint = firstNoteAt >= 2 ? `첫 음표는 ${fmt(firstNoteAt)}부터 시작해요.` : "";
    setStatus(soundMode === "synth"
      ? `악기 샘플을 불러오지 못해 합성음으로 준비했어요.${firstNoteHint ? ` ${firstNoteHint}` : ""}`
      : firstNoteHint ? `준비 완료 — ${firstNoteHint}` : "준비 완료 — ▶ 를 눌러보세요.");
  } catch (e) {
    setStatus("곡을 불러오지 못했어요: " + e.message, true);
  } finally {
    playBtn.disabled = !ready;
    wavBtn.disabled = !ready;
  }
}

// ---------- 오디오 준비 ----------
// 악기 소리가 지나는 공통 출구.
//   압축기 → 볼륨 → 리미터 순서.
//   그냥 음량만 올리면 음이 겹칠 때 1.0을 넘어 찌그러진다. 압축기로 큰 소리만 눌러
//   전체를 고르게 만든 뒤 올려야 안 깨지면서 크게 들린다.
let masterNode = null, masterVol = null;
function master() {
  if (!masterNode) {
    const limiter = new Tone.Limiter(-2).toDestination();
    masterVol = new Tone.Volume(BASS_GAIN_DB).connect(limiter);
    masterNode = new Tone.Compressor({
      threshold: -24, ratio: 4, attack: 0.004, release: 0.12,
    }).connect(masterVol);
  }
  return masterNode;
}

// 0~100 → 음량(dB). 100 이 기본값이고 그보다 키울 수도 있다.
function setVolume(pct) {
  const db = BASS_GAIN_DB + (pct - 100) * 0.28;
  if (masterVol) masterVol.volume.value = db;
  return db;
}

// 실제 녹음 샘플을 못 받아오면(오프라인·차단 환경) 합성음으로 대신한다
function makeSynthBass() {
  return new Tone.PolySynth(Tone.MonoSynth, {
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.02, decay: 0.25, sustain: 0.55, release: 0.5 },
    filterEnvelope: { attack: 0.02, decay: 0.3, sustain: 0.4, baseFrequency: 110, octaves: 2.4 },
    volume: -3,
  }).connect(master());     // 음량 조절은 마스터가 맡는다
}

// ---------- 모바일 오디오 잠금 해제 ----------
// 휴대폰 브라우저는 화면을 만지기 전에는 소리를 못 내게 막아 둔다.
// 게다가 아이폰은 웹 오디오를 '벨소리'로 취급해서, 무음 스위치가 켜져 있으면 들리지 않는다.
// → 첫 입력에서 오디오를 깨우고, '재생용 소리'로 분류해 무음 스위치의 영향을 없앤다.
let audioUnlocked = false;

function unlockAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";  // 아이폰 무음 스위치 대응
  } catch (e) { /* 지원 안 하는 브라우저는 넘어간다 */ }
  try {
    const ctx = Tone.getContext().rawContext;
    if (ctx.state !== "running") ctx.resume();
    Tone.start();
    audioUnlocked = ctx.state === "running";
  } catch (e) { /* 아직이면 다음 입력 때 다시 시도 */ }
}

// 소리가 여전히 막혀 있으면 사용자에게 알려준다 (아이폰 무음 스위치가 가장 흔한 원인)
function warnIfMuted() {
  try {
    if (Tone.getContext().rawContext.state !== "running") {
      setStatus("소리가 잠겨 있어요. 화면을 한 번 누르고, 아이폰이면 옆면 무음 스위치를 풀어주세요.", true);
      return true;
    }
  } catch (e) { /* 확인 불가하면 넘어간다 */ }
  return false;
}

["pointerdown", "touchstart", "click", "keydown"].forEach((ev) =>
  document.addEventListener(ev, () => { if (!audioUnlocked) unlockAudio(); }, { passive: true }));

// 화면을 다시 켜거나 앱으로 돌아오면 오디오가 잠들어 있을 수 있다
document.addEventListener("visibilitychange", () => { if (!document.hidden) unlockAudio(); });

async function ensureSampler(key) {
  if (loadedInstrument === key && sampler) { ready = true; return loadedSoundMode || "sample"; }
  if (sampler) sampler.dispose();

  const inst = INSTRUMENTS[key];
  if (window.NO_EXTERNAL || !inst.baseUrl) {   // 외부 접속이 막힌 배포판
    sampler = makeSynthBass();
    loadedInstrument = key;
    loadedSoundMode = "synth";
    ready = true;
    return "synth";
  }
  let mode = "sample";
  try {
    sampler = new Tone.Sampler({
      urls: inst.urls, baseUrl: inst.baseUrl, release: 0.6,
    }).connect(master());
    await Promise.race([
      Tone.loaded(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
    ]);
  } catch (e) {
    if (sampler) sampler.dispose();
    sampler = makeSynthBass();                 // 샘플 실패 → 합성음으로 계속 진행
    mode = "synth";
  }
  loadedInstrument = key;
  loadedSoundMode = mode;
  ready = true;
  return mode;
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

// ---------- 구간 반복 ----------
function updateLoopUI() {
  const has = loopStart !== null && loopEnd !== null;
  loopClearBtn.hidden = !(loopStart !== null || loopEnd !== null);
  loopABtn.classList.toggle("set", loopStart !== null);
  loopBBtn.classList.toggle("set", loopEnd !== null);
  loopInfo.textContent = has ? `${fmt(loopStart)} → ${fmt(loopEnd)} 반복`
    : loopStart !== null ? `A ${fmt(loopStart)} · B 지점을 정하세요`
    : "";
}

// 반복은 오디오 클럭(Transport)에 맡긴다.
// 화면 갱신(requestAnimationFrame)에 의존하면 다른 탭을 보고 있을 때 되돌아오지 않는다.
function applyLoop() {
  const on = loopStart !== null && loopEnd !== null && loopEnd > loopStart;
  if (on) {
    const ppq = Tone.Transport.PPQ;
    Tone.Transport.loopStart = Math.round(loopStart * ppq) + "i";
    Tone.Transport.loopEnd = Math.round(loopEnd * ppq) + "i";
  }
  Tone.Transport.loop = on;
}

function setLoopA() {
  loopStart = position();
  if (loopEnd !== null && loopEnd <= loopStart) loopEnd = null;
  applyLoop(); updateLoopUI();
}
function setLoopB() {
  const p = position();
  if (loopStart === null) loopStart = 0;
  if (p <= loopStart) { setStatus("B 지점은 A 지점보다 뒤여야 해요.", true); return; }
  loopEnd = p;
  applyLoop(); updateLoopUI();
  setStatus(`${fmt(loopStart)}~${fmt(loopEnd)} 구간을 반복해요.`);
}
function clearLoop() {
  loopStart = loopEnd = null;
  applyLoop(); updateLoopUI();
}

// 현재 위치 부근의 한 박 길이(초) — 카운트인 속도에 쓴다
function beatInterval() {
  const p = position();
  for (let i = 0; i < beatGrid.length - 1; i++) {
    if (beatGrid[i + 1] > p) return Math.max(0.15, (beatGrid[i + 1] - beatGrid[i]) / speed());
  }
  return 60 / (bpm * speed());       // 박 격자가 없을 때의 대비책
}

// ---------- 재생 컨트롤 ----------
async function togglePlay() {
  if (!notes.length) return;
  if (Tone.Transport.state === "started") {
    Tone.Transport.pause();
    playBtn.textContent = "▶";
    playBtn.title = "재생";
    playBtn.setAttribute("aria-label", "재생");
    setStatus(`일시정지 · ${fmt(position())}`);
    return;
  }
  // AudioContext 시작은 반드시 사용자가 재생 버튼을 누른 순간에 요청해야 한다.
  // 곡을 자동으로 불러오는 중에 Tone.start()를 기다리면 브라우저가 차단해
  // 로딩 상태와 비활성 재생 버튼에서 영원히 멈출 수 있다.
  unlockAudio();
  await Tone.start();
  await ensureSampler(instrument);
  warnIfMuted();
  if (!notePart) schedule();
  Tone.Transport.bpm.value = 60 * speed();

  if (countIn.checked) {
    // 시작 전 4박을 세어준다 (들어가는 타이밍 잡기 좋게).
    // 메트로놈과 같은 악기를 쓰면 예약 시각이 꼬이므로 전용 악기를 새로 만들어 쓰고 버린다.
    const iv = beatInterval();
    const t0 = Tone.now() + 0.15;
    const cs = new Tone.Synth({
      oscillator: { type: "square" },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
      volume: -12,
    }).toDestination();
    for (let i = 0; i < 4; i++) {
      cs.triggerAttackRelease(i === 0 ? "G5" : "C5", "32n", t0 + i * iv);
    }
    setTimeout(() => cs.dispose(), (4 * iv + 1) * 1000);
    Tone.Transport.start(t0 + 4 * iv);
  } else {
    Tone.Transport.start();
  }
  playBtn.textContent = "❚❚";
  playBtn.title = "일시정지";
  playBtn.setAttribute("aria-label", "일시정지");
  setStatus(position() < firstNoteAt - 0.5
    ? `재생 중 · 첫 음표는 ${fmt(firstNoteAt)}부터 시작해요.`
    : `재생 중 · ${speedSlider.value}% 속도`);
}

function stop() {
  Tone.Transport.stop();
  Tone.Transport.ticks = 0;
  playBtn.textContent = "▶";
  playBtn.title = "재생";
  playBtn.setAttribute("aria-label", "재생");
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
    // 반복 중에는 끝까지 갔다고 멈추면 안 된다 (Transport 가 알아서 되돌린다)
    if (!Tone.Transport.loop && t >= duration) stop();
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
      // 재생할 때와 같은 소리 다듬기(압축 → 음량 → 리미터)를 거쳐 내보낸다
      const lim = new Tone.Limiter(-2).toDestination();
      const vol = new Tone.Volume(BASS_GAIN_DB).connect(lim);
      const comp = new Tone.Compressor({
        threshold: -24, ratio: 4, attack: 0.004, release: 0.12,
      }).connect(vol);
      const s = useSynth
        ? new Tone.PolySynth(Tone.MonoSynth, {
            oscillator: { type: "sawtooth" },
            envelope: { attack: 0.02, decay: 0.25, sustain: 0.55, release: 0.5 },
            filterEnvelope: { attack: 0.02, decay: 0.3, sustain: 0.4, baseFrequency: 110, octaves: 2.4 },
            volume: -3,
          }).connect(comp)
        : new Tone.Sampler({
            urls: inst.urls, baseUrl: inst.baseUrl, release: 0.6,
          }).connect(comp);
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
  unlockAudio();
  await Tone.start();
  warnIfMuted();

  // 메트로놈은 곡과 같은 타임라인을 쓴다.
  // 곡의 재생 예약이 남아 있으면 메트로놈만 켜도 곡이 같이 울리므로 먼저 싹 비운다.
  // (연습 탭으로 돌아가 재생을 누르면 그때 다시 만들어진다)
  if (notePart) { notePart.dispose(); notePart = null; }
  if (clickPart) { clickPart.dispose(); clickPart = null; }
  Tone.Transport.cancel();
  Tone.Transport.loop = false;          // 구간 반복 설정도 함께 해제
  Tone.Transport.ticks = 0;
  Tone.Transport.bpm.value = 60;        // 1박 = 1초로 두어 간격 계산을 단순하게

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

  mLoop.start(0);                  // 루프를 먼저 걸고
  Tone.Transport.start();          // 타임라인을 돌린다 (이제 메트로놈만 올라가 있다)
  mRunning = true;
  mToggle.textContent = "■ 정지";
  mToggle.classList.add("on");
  metroStatus.textContent = `재생 중 · ${mBpm.value} BPM · ${mBeatSel.value}박자`;
}

function mStop() {
  if (mLoop) { mLoop.dispose(); mLoop = null; }
  mRunning = false;
  mCount = 0;
  lightBeat(-1);
  mToggle.textContent = "▶ 시작";
  mToggle.classList.remove("on");
  metroStatus.textContent = "정지됨 — ▶ 를 누르면 다시 시작해요.";
}

const mToggleRun = () => (mRunning ? mStop() : mStart());

function setBpm(v) {
  const b = Math.min(240, Math.max(30, Math.round(v)));
  mBpm.value = b;
  mBpmVal.textContent = b;
  mMark.textContent = tempoWord(b);
  paint(mBpm);
  if (mLoop) mLoop.interval = 60 / b / Number(mSub.value);
  if (mRunning) metroStatus.textContent = `재생 중 · ${b} BPM · ${mBeatSel.value}박자`;
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
  if (mRunning) metroStatus.textContent = `재생 중 · ${mBpm.value} BPM · ${mBeatSel.value}박자`;
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
    document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
    const isMetro = btn.dataset.tab === "metro";
    metroTab.hidden = !isMetro;
    practiceTab.hidden = isMetro;
    if (isMetro) {
      stop();
      if (broadcastUtterance || scoldUtterance || window.speechSynthesis?.speaking) {
        window.speechSynthesis.cancel();
        finishBroadcast();
        finishScold();
      }
    } else { mStop(); }
  });
});

drawBeats();
setBpm(90);

// ---------- 설정 기억하기 (이 브라우저에) ----------
const PREF_KEY = "chostest.prefs";
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch { return {}; } };

function savePrefs() {
  localStorage.setItem(PREF_KEY, JSON.stringify({
    piece: currentPieceId,
    volume: volSlider.value,
    speed: speedSlider.value,
    metro: metroSel.value,
    cello: includeCello.checked,
    octave: octaveDown.checked,
    countIn: countIn.checked,
    mBpm: mBpm.value,
    mBeat: mBeatSel.value,
    mSub: mSub.value,
  }));
}

function applyPrefs() {
  const p = readPrefs();
  if (p.volume) { volSlider.value = p.volume; volValue.textContent = p.volume + "%"; }
  paint(volSlider);
  setVolume(Number(volSlider.value));
  if (p.speed) { speedSlider.value = p.speed; speedValue.textContent = p.speed + "%"; paint(speedSlider); }
  if (p.metro) { metroSel.value = p.metro; metroSel.dispatchEvent(new Event("change")); }
  if (p.cello) includeCello.checked = true;
  if (p.octave) octaveDown.checked = true;
  if (p.countIn) countIn.checked = true;
  if (p.mBpm) setBpm(Number(p.mBpm));
  if (p.mBeat) { mBeatSel.value = p.mBeat; mBeatSel.dispatchEvent(new Event("change")); }
  if (p.mSub) mSub.value = p.mSub;
  return p.piece || null;
}

[volSlider, speedSlider, metroSel, includeCello, octaveDown, countIn, mBpm, mBeatSel, mSub]
  .forEach((el) => el.addEventListener("change", savePrefs));

// ---------- 이벤트 ----------
pieceSel.addEventListener("change", (e) => selectPiece(e.target.value));
broadcastBtn.addEventListener("click", toggleBroadcast);
scoldBtn.addEventListener("click", playScold);
playBtn.addEventListener("click", togglePlay);
backBtn.addEventListener("click", () => skip(-SKIP));
fwdBtn.addEventListener("click", () => skip(SKIP));
wavBtn.addEventListener("click", downloadWav);
// 업로드 UI 는 정적 배포판에 없으므로 있을 때만 연결한다
if (analyzeBtn) analyzeBtn.addEventListener("click", analyzeScore);
if (saveScoreBtn) saveScoreBtn.addEventListener("click", saveScore);

loopABtn.addEventListener("click", setLoopA);
loopBBtn.addEventListener("click", setLoopB);
loopClearBtn.addEventListener("click", clearLoop);

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

volSlider.addEventListener("input", (e) => {
  volValue.textContent = e.target.value + "%";
  paint(volSlider);
  setVolume(Number(e.target.value));
});

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

let pendingPiece = applyPrefs();   // 저장된 설정을 먼저 적용하고, 듣던 곡을 이어서 연다
loadPieces();
