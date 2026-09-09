(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const preview = $("preview");
  const playback = $("playback");
  const statusEl = $("status");
  const errorEl = $("error");
  const songInput = $("songInput");
  const songNameEl = $("songName");
  const songDurEl = $("songDur");
  const scrub = $("scrub");
  const btnRecord = $("btnRecord");
  const btnFlip = $("btnFlip");
  const btnMic = $("btnMic");
  const countdownToggle = $("countdownToggle");
  const countdownEl = $("countdown");
  const recBadge = $("recBadge");
  const recTimer = $("recTimer");
  const resultBar = $("resultBar");
  const btnSave = $("btnSave");
  const btnShare = $("btnShare");
  const btnRetake = $("btnRetake");

  let facingMode = "user";
  let micOn = false;
  let cameraStream = null;
  let audioBuffer = null;
  let songFileName = "";
  let audioCtx = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordedBlob = null;
  let recordedExt = "webm";
  let recording = false;
  let stopping = false;
  let bufferSource = null;
  let mixDest = null;
  let recStartMs = 0;
  let timerId = null;
  let songEndTimer = null;

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function showError(msg) {
    if (!msg) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = msg;
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }

  function stampName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      "dance-" +
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "-" +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds()) +
      "." +
      recordedExt
    );
  }

  function preferMime() {
    const candidates = [
      "video/mp4",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
    ];
    if (typeof MediaRecorder === "undefined") return "";
    for (const c of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(c)) return c;
      } catch (_) {}
    }
    return "";
  }

  function updateRecordEnabled() {
    btnRecord.disabled = !cameraStream || !audioBuffer || recording;
  }

  async function ensureAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("Web Audio API not supported in this browser.");
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
    return audioCtx;
  }

  async function startCamera() {
    showError("");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("Camera API unavailable. Open this page over HTTPS on your iPhone.");
      return;
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    const videoConstraints = {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    };
    try {
      const constraints = micOn
        ? { video: videoConstraints, audio: { echoCancellation: true, noiseSuppression: true } }
        : { video: videoConstraints, audio: false };
      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      preview.srcObject = cameraStream;
      preview.classList.toggle("mirror", facingMode === "user");
      await preview.play().catch(() => {});
      setStatus(micOn ? "Camera + mic ready" : "Camera ready — mic off (music only)");
      updateRecordEnabled();
    } catch (err) {
      console.error(err);
      const name = err && err.name ? err.name : "Error";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        showError("Camera/mic permission denied. Allow access in Settings → Safari, then reload.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        showError("No camera found on this device.");
      } else {
        showError("Could not open camera: " + (err.message || name));
      }
      updateRecordEnabled();
    }
  }

  async function onSongPicked(file) {
    if (!file) return;
    showError("");
    setStatus("Loading song…");
    songFileName = file.name || "song";
    songNameEl.textContent = songFileName;
    try {
      await ensureAudioCtx();
      const ab = await file.arrayBuffer();
      // decodeAudioData may detach the buffer; copy for Safari safety
      const copy = ab.slice(0);
      audioBuffer = await audioCtx.decodeAudioData(copy);
      songDurEl.textContent = fmtTime(audioBuffer.duration);
      scrub.max = String(Math.max(0, audioBuffer.duration - 0.05));
      scrub.value = "0";
      scrub.disabled = false;
      setStatus("Song ready — tap Record when you are");
      updateRecordEnabled();
    } catch (err) {
      console.error(err);
      audioBuffer = null;
      songDurEl.textContent = "";
      scrub.disabled = true;
      scrub.value = "0";
      showError("Could not decode audio. Use mp3 / m4a / wav / aac from Files.");
      setStatus("Pick another song");
      updateRecordEnabled();
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function runCountdown() {
    if (!countdownToggle.checked) return;
    countdownEl.hidden = false;
    for (const n of [3, 2, 1]) {
      countdownEl.textContent = String(n);
      await sleep(900);
      if (stopping) break;
    }
    countdownEl.hidden = true;
    countdownEl.textContent = "";
  }

  function stopTimer() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    if (songEndTimer) {
      clearTimeout(songEndTimer);
      songEndTimer = null;
    }
  }

  function startTimer() {
    recStartMs = performance.now();
    recTimer.textContent = "0:00";
    stopTimer();
    timerId = setInterval(() => {
      const sec = (performance.now() - recStartMs) / 1000;
      recTimer.textContent = fmtTime(sec);
    }, 250);
  }

  async function startRecording() {
    if (recording || !cameraStream || !audioBuffer) return;
    if (typeof MediaRecorder === "undefined") {
      showError("MediaRecorder not supported in this browser.");
      return;
    }
    showError("");
    stopping = false;
    recordedChunks = [];
    recordedBlob = null;
    resultBar.hidden = true;
    playback.hidden = true;
    playback.removeAttribute("src");
    playback.load();
    preview.hidden = false;

    try {
      await ensureAudioCtx();
    } catch (err) {
      showError(err.message || String(err));
      return;
    }

    btnRecord.disabled = true;
    setStatus("Get ready…");
    await runCountdown();
    if (stopping) {
      updateRecordEnabled();
      return;
    }

    try {
      mixDest = audioCtx.createMediaStreamDestination();
      const offset = Math.min(
        Math.max(0, parseFloat(scrub.value) || 0),
        Math.max(0, audioBuffer.duration - 0.05)
      );
      const remain = Math.max(0.05, audioBuffer.duration - offset);

      bufferSource = audioCtx.createBufferSource();
      bufferSource.buffer = audioBuffer;
      bufferSource.connect(audioCtx.destination);
      bufferSource.connect(mixDest);
      bufferSource.onended = () => {
        if (recording) stopRecording("Song ended");
      };

      if (micOn) {
        const micTracks = cameraStream.getAudioTracks();
        if (micTracks.length) {
          const micStream = new MediaStream(micTracks);
          const micSrc = audioCtx.createMediaStreamSource(micStream);
          micSrc.connect(mixDest);
        }
      }

      const outStream = new MediaStream();
      cameraStream.getVideoTracks().forEach((t) => outStream.addTrack(t));
      mixDest.stream.getAudioTracks().forEach((t) => outStream.addTrack(t));

      const mime = preferMime();
      const opts = mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : { videoBitsPerSecond: 6_000_000 };
      try {
        mediaRecorder = new MediaRecorder(outStream, opts);
      } catch (_) {
        mediaRecorder = new MediaRecorder(outStream);
      }
      recordedExt = (mediaRecorder.mimeType || mime || "").includes("mp4") ? "mp4" : "webm";

      mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data);
      };
      mediaRecorder.onerror = (ev) => {
        console.error(ev);
        showError("Recording error. Try again or use a different song format.");
      };
      mediaRecorder.onstop = () => {
        const type = (mediaRecorder && mediaRecorder.mimeType) || (recordedExt === "mp4" ? "video/mp4" : "video/webm");
        recordedBlob = new Blob(recordedChunks, { type });
        recordedChunks = [];
        finishRecordingUI();
      };

      bufferSource.start(0, offset);
      mediaRecorder.start(250);
      recording = true;
      btnRecord.disabled = false;
      btnRecord.textContent = "Stop";
      btnRecord.classList.add("recording");
      recBadge.hidden = false;
      startTimer();
      songEndTimer = setTimeout(() => {
        if (recording) stopRecording("Song ended");
      }, remain * 1000 + 50);
      setStatus("Recording — dance!");
    } catch (err) {
      console.error(err);
      showError("Could not start recording: " + (err.message || err));
      cleanupAudioGraph();
      recording = false;
      btnRecord.textContent = "Record";
      btnRecord.classList.remove("recording");
      recBadge.hidden = true;
      updateRecordEnabled();
    }
  }

  function cleanupAudioGraph() {
    try {
      if (bufferSource) {
        bufferSource.onended = null;
        try { bufferSource.stop(); } catch (_) {}
        try { bufferSource.disconnect(); } catch (_) {}
      }
    } catch (_) {}
    bufferSource = null;
    mixDest = null;
  }

  function stopRecording(reason) {
    if (!recording || stopping) return;
    stopping = true;
    setStatus(reason || "Stopping…");
    stopTimer();
    cleanupAudioGraph();
    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      } else {
        finishRecordingUI();
      }
    } catch (err) {
      console.error(err);
      finishRecordingUI();
    }
  }

  function finishRecordingUI() {
    recording = false;
    stopping = false;
    stopTimer();
    btnRecord.textContent = "Record";
    btnRecord.classList.remove("recording");
    recBadge.hidden = true;
    countdownEl.hidden = true;

    if (!recordedBlob || recordedBlob.size < 64) {
      showError("Recording produced no data. On iPhone, try again over HTTPS and keep Safari in the foreground.");
      setStatus("Ready to retry");
      updateRecordEnabled();
      return;
    }

    const url = URL.createObjectURL(recordedBlob);
    preview.hidden = true;
    playback.hidden = false;
    playback.src = url;
    playback.playsInline = true;
    resultBar.hidden = false;
    const canShare =
      typeof navigator.share === "function" &&
      typeof navigator.canShare === "function";
    btnShare.hidden = !canShare;
    setStatus("Preview — Save or Share");
    updateRecordEnabled();
  }

  async function saveRecording() {
    if (!recordedBlob) return;
    const name = stampName();
    const file = new File([recordedBlob], name, { type: recordedBlob.type || "video/mp4" });

    if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
      try {
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "DanceCam" });
          setStatus("Shared");
          return;
        }
      } catch (err) {
        if (err && err.name === "AbortError") return;
        // fall through to download
      }
    }

    const a = document.createElement("a");
    a.href = URL.createObjectURL(recordedBlob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("Download started — check Files / Downloads");
  }

  async function shareRecording() {
    if (!recordedBlob) return;
    const name = stampName();
    const file = new File([recordedBlob], name, { type: recordedBlob.type || "video/mp4" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "DanceCam" });
        setStatus("Shared");
      } else {
        await saveRecording();
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      showError("Share failed — use Save instead.");
    }
  }

  function retake() {
    if (playback.src) URL.revokeObjectURL(playback.src);
    playback.removeAttribute("src");
    playback.load();
    playback.hidden = true;
    preview.hidden = false;
    resultBar.hidden = true;
    recordedBlob = null;
    setStatus("Ready — tap Record");
    updateRecordEnabled();
  }

  // Events
  songInput.addEventListener("change", () => {
    const f = songInput.files && songInput.files[0];
    onSongPicked(f);
  });

  btnFlip.addEventListener("click", async () => {
    facingMode = facingMode === "user" ? "environment" : "user";
    await startCamera();
  });

  btnMic.addEventListener("click", async () => {
    micOn = !micOn;
    btnMic.setAttribute("aria-pressed", micOn ? "true" : "false");
    btnMic.textContent = micOn ? "Mic on" : "Mic off";
    await startCamera();
  });

  btnRecord.addEventListener("click", async () => {
    // User gesture: resume AudioContext for iOS
    try { await ensureAudioCtx(); } catch (_) {}
    if (recording) {
      stopRecording("Stopped");
    } else {
      await startRecording();
    }
  });

  btnSave.addEventListener("click", () => saveRecording());
  btnShare.addEventListener("click", () => shareRecording());
  btnRetake.addEventListener("click", () => retake());

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && recording) {
      // Keep going; iOS may suspend — user should keep Safari foreground
      setStatus("Keep Safari open while recording");
    }
  });

  // Boot
  setStatus("Starting camera…");
  startCamera();
})();
