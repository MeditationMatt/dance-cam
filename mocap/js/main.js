import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Tracker } from './tracker.js';
import { Retargeter, LM } from './retarget.js';
import { PointSetFilter, OneEuro } from './filters.js';
import { MotionRecorder } from './recorder.js';
import { createMannequin } from './mannequin.js';

const $ = (id) => document.getElementById(id);
const MODEL_CDN = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/models/gltf/';
const CHARACTERS = {
  mannequin: { label: 'Mannequin (built-in)' },
  xbot: { label: 'X Bot (Mixamo)', url: MODEL_CDN + 'Xbot.glb' },
  michelle: { label: 'Michelle (Mixamo)', url: MODEL_CDN + 'Michelle.glb' },
  soldier: { label: 'Soldier (Mixamo)', url: MODEL_CDN + 'Soldier.glb' },
};
// Left/right landmark swap used for mirror mode.
const MIRROR_IDX = [0, 4, 5, 6, 1, 2, 3, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17, 20, 19, 22, 21, 24, 23, 26, 25, 28, 27, 30, 29, 32, 31];
const POSE_LINKS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32], [15, 19], [16, 20], [0, 7], [0, 8]];
const HAND_LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

// ---------------- scene ----------------
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2130);
scene.fog = new THREE.Fog(0x1a2130, 8, 22);

const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
camera.position.set(0, 1.3, 5.2);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.95, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.55;

scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a2018, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2.5, 5, 3.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 15 });
scene.add(sun);
const rim = new THREE.DirectionalLight(0x88aaff, 1.0);
rim.position.set(-3, 3, -4);
scene.add(rim);

const floor = new THREE.Mesh(new THREE.CircleGeometry(10, 64), new THREE.MeshStandardMaterial({ color: 0x232b38, roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(20, 40, 0x3c4a60, 0x2c3646);
grid.position.y = 0.001;
scene.add(grid);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------- state ----------------
const state = {
  tracker: new Tracker(),
  running: false,
  rt: null,
  model: null,
  container: null,
  skeletonHelper: null,
  recorder: null,
  mixer: null,
  playing: false,
  lastVideoTime: -1,
  poseFilter: new PointSetFilter(33),
  handFilters: { Left: new PointSetFilter(21), Right: new PointSetFilter(21) },
  handSeen: { Left: -1, Right: -1 },
  rootFilters: [new OneEuro(0.6, 1.5), new OneEuro(0.6, 1.5)],
  rootCalib: null,
  proportions: null,
  lastFrame: null,
  fpsCount: 0,
  fpsT: performance.now(),
};

const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const status = (msg) => { $('status').textContent = msg; };

// ---------------- characters ----------------
const selChar = $('selChar');
for (const [k, c] of Object.entries(CHARACTERS)) selChar.add(new Option(c.label, k));
selChar.addEventListener('change', () => loadCharacter(selChar.value));
$('fileChar').addEventListener('change', (e) => e.target.files[0] && loadCharacterFile(e.target.files[0]));

addEventListener('dragover', (e) => { e.preventDefault(); $('drop').hidden = false; });
addEventListener('dragleave', (e) => { if (e.target === document.documentElement || !e.relatedTarget) $('drop').hidden = true; });
addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) loadCharacterFile(f);
});

async function loadCharacter(key) {
  const c = CHARACTERS[key];
  if (!c.url) return installModel(createMannequin(), c.label);
  status(`Loading ${c.label}…`);
  try {
    const gltf = await new GLTFLoader().loadAsync(c.url);
    installModel(gltf.scene, c.label);
  } catch (err) {
    console.error(err);
    status(`Could not load ${c.label} (${err.message}); using mannequin.`);
    installModel(createMannequin(), 'Mannequin');
  }
}

async function loadCharacterFile(file) {
  const name = file.name.toLowerCase();
  const url = URL.createObjectURL(file);
  status(`Loading ${file.name}…`);
  try {
    let obj;
    if (name.endsWith('.fbx')) obj = await new FBXLoader().loadAsync(url);
    else if (name.endsWith('.glb') || name.endsWith('.gltf')) obj = (await new GLTFLoader().loadAsync(url)).scene;
    else throw new Error('Use .fbx, .glb or .gltf');
    installModel(obj, file.name);
    if (![...selChar.options].some((o) => o.value === 'custom')) selChar.add(new Option('Custom: ' + file.name, 'custom'));
    selChar.value = 'custom';
    selChar.options[selChar.selectedIndex].text = 'Custom: ' + file.name;
  } catch (err) {
    console.error(err);
    status(`Failed to load ${file.name}: ${err.message}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function installModel(model, label) {
  let rt;
  const container = new THREE.Group();
  container.add(model);
  model.updateMatrixWorld(true);
  // Normalize to ~1.75 m tall standing on the floor.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const s = 1.75 / (size.y || 1);
  container.scale.setScalar(s);
  container.position.set(-(box.min.x + box.max.x) / 2 * s, -box.min.y * s, -(box.min.z + box.max.z) / 2 * s);
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });
  scene.add(container);
  container.updateMatrixWorld(true);
  try {
    rt = new Retargeter(model);
  } catch (err) {
    scene.remove(container);
    status(`${label}: ${err.message}`);
    return;
  }
  if (state.container) scene.remove(state.container);
  if (state.skeletonHelper) scene.remove(state.skeletonHelper);
  stopPlayback();
  state.container = container;
  state.model = model;
  state.rt = rt;
  state.recorder = new MotionRecorder(rt);
  state.skeletonHelper = new THREE.SkeletonHelper(model);
  state.skeletonHelper.visible = $('chkSkeleton').checked;
  scene.add(state.skeletonHelper);
  state.proportions = null;
  updateTakeUI();
  status(`${label} ready.` + (state.running ? '' : ' Press “Start webcam”.'));
}

// ---------------- webcam ----------------
$('btnStart').addEventListener('click', startWebcam);
$('selDevice').addEventListener('change', () => state.running && startWebcam());
$('selQuality').addEventListener('change', async () => {
  status('Loading tracking model…');
  await state.tracker.setPoseQuality($('selQuality').value);
  status('Tracking.');
});
$('chkHands').addEventListener('change', async () => {
  if (!state.running) return;
  status($('chkHands').checked ? 'Loading hand model…' : 'Hands off.');
  await state.tracker.setHandsEnabled($('chkHands').checked);
  status('Tracking.');
});

async function startWebcam() {
  try {
    $('btnStart').disabled = true;
    status('Requesting camera…');
    if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
    const deviceId = $('selDevice').value;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) },
    });
    video.srcObject = stream;
    await video.play();
    await listDevices(stream);
    status('Loading tracking models (first time takes a few seconds)…');
    await state.tracker.setPoseQuality($('selQuality').value);
    await state.tracker.setHandsEnabled($('chkHands').checked);
    state.running = true;
    state.rootCalib = null;
    $('btnRecord').disabled = false;
    $('btnStart').textContent = 'Restart webcam';
    status('Tracking. Step back so your whole body is visible.');
  } catch (err) {
    console.error(err);
    status('Camera error: ' + err.message);
  } finally {
    $('btnStart').disabled = false;
  }
}

async function listDevices(stream) {
  const sel = $('selDevice');
  const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  sel.innerHTML = '';
  devices.forEach((d, i) => sel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  if (current) sel.value = current;
}

// ---------------- UI toggles ----------------
$('chkMirror').addEventListener('change', () => {
  $('pipInner').classList.toggle('mirrored', $('chkMirror').checked);
  state.poseFilter.reset();
  state.rootCalib = null;
});
$('chkVideo').addEventListener('change', () => $('pip').classList.toggle('hidden', !$('chkVideo').checked));
$('chkSkeleton').addEventListener('change', () => { if (state.skeletonHelper) state.skeletonHelper.visible = $('chkSkeleton').checked; });
$('chkProportions').addEventListener('change', () => {
  if (!$('chkProportions').checked && state.rt) { state.rt.setProportions(null); state.proportions = null; }
});
$('btnRecenter').addEventListener('click', () => { state.rootCalib = null; });
$('btnCollapse').addEventListener('click', () => { $('panel').classList.add('collapsed'); $('btnExpand').hidden = false; });
$('btnExpand').addEventListener('click', () => { $('panel').classList.remove('collapsed'); $('btnExpand').hidden = true; });

function smoothingParams() {
  const s = +$('rngSmooth').value;
  return { minCutoff: 3.0 + (0.3 - 3.0) * s, beta: 12 + (1.5 - 12) * s };
}

// ---------------- recording ----------------
$('btnRecord').addEventListener('click', toggleRecord);
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'KeyR') toggleRecord();
});
let countdownTimer = null;

async function toggleRecord() {
  const rec = state.recorder;
  if (!rec || !state.running) return;
  if (rec.recording || countdownTimer) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; $('countdown').hidden = true; }
    rec.stop();
    $('btnRecord').classList.remove('on');
    $('btnRecord').textContent = '● Record';
    $('recBadge').hidden = true;
    updateTakeUI();
    return;
  }
  stopPlayback();
  $('btnRecord').classList.add('on');
  $('btnRecord').textContent = '■ Stop';
  const begin = () => {
    rec.start(performance.now() / 1000);
    $('recBadge').hidden = false;
  };
  if ($('chkCountdown').checked) {
    let n = 3;
    $('countdown').hidden = false;
    $('countdown').textContent = n;
    countdownTimer = setInterval(() => {
      n--;
      if (n > 0) { $('countdown').textContent = n; return; }
      clearInterval(countdownTimer);
      countdownTimer = null;
      $('countdown').hidden = true;
      begin();
    }, 1000);
  } else begin();
}

function updateTakeUI() {
  const rec = state.recorder;
  const has = rec && !rec.recording && rec.frames.length > 1;
  for (const id of ['btnPlay', 'btnBVH', 'btnGLB', 'btnJSON']) $(id).disabled = !has;
  $('takeInfo').textContent = has
    ? `Take: ${rec.duration.toFixed(1)}s, ${rec.frames.length} frames (${(rec.frames.length / rec.duration).toFixed(0)} fps).`
    : 'No take yet. Press Record (or R).';
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `mocap-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function download(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('btnBVH').addEventListener('click', () => download(state.recorder.toBVH(30), stamp() + '.bvh', 'text/plain'));
$('btnJSON').addEventListener('click', () => download(state.recorder.toJSON(), stamp() + '.json', 'application/json'));
$('btnGLB').addEventListener('click', async () => {
  stopPlayback();
  status('Exporting GLB…');
  try {
    const glb = await state.recorder.toGLB('mocap');
    download(new Blob([glb], { type: 'model/gltf-binary' }), stamp() + '.glb');
    status('GLB exported.');
  } catch (err) {
    console.error(err);
    status('GLB export failed: ' + err.message);
  }
});
$('btnPlay').addEventListener('click', () => (state.playing ? stopPlayback() : startPlayback()));

function startPlayback() {
  const clip = state.recorder.toClip('take');
  state.mixer = new THREE.AnimationMixer(state.model);
  state.mixer.clipAction(clip).play();
  state.playing = true;
  $('btnPlay').textContent = '■ Stop';
  status('Playing take (live tracking paused).');
}
function stopPlayback() {
  if (!state.playing) return;
  state.mixer.stopAllAction();
  state.mixer = null;
  state.playing = false;
  $('btnPlay').textContent = '▶ Play take';
  state.rt?.resetPose();
  status('Tracking.');
}

// ---------------- tracking -> skeleton ----------------
const toCanon = (p, mirror) => new THREE.Vector3(mirror ? -p.x : p.x, -p.y, -p.z);
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function processResult(res, tSec) {
  const mirror = $('chkMirror').checked;
  const sp = smoothingParams();

  // Hands: assign each detected hand to the nearest pose wrist (person's own left/right).
  const rawHands = { Left: null, Right: null };
  if (res.pose && res.hands.length) {
    const img = res.pose.image;
    const cand = res.hands.map((h) => ({ h, dl: dist2(h.image[0], img[LM.lWrist]), dr: dist2(h.image[0], img[LM.rWrist]) }));
    for (const c of cand) {
      const side = c.dl < c.dr ? 'Left' : 'Right';
      const d = Math.min(c.dl, c.dr);
      if (d > 0.15) continue;
      if (!rawHands[side] || d < rawHands[side].d) rawHands[side] = { h: c.h, d };
    }
  }
  const handsCanon = { Left: null, Right: null };
  for (const side of ['Left', 'Right']) {
    const f = state.handFilters[side];
    f.setParams(sp.minCutoff * 1.5, sp.beta);
    if (rawHands[side]) {
      if (tSec - state.handSeen[side] > 0.3) f.reset();
      state.handSeen[side] = tSec;
      const fw = f.filter(rawHands[side].h.world, tSec);
      const outSide = mirror ? (side === 'Left' ? 'Right' : 'Left') : side;
      handsCanon[outSide] = fw.map((p) => toCanon(p, mirror));
    }
  }

  drawOverlay(res, rawHands);
  if (!res.pose || !state.rt) return;

  state.poseFilter.setParams(sp.minCutoff, sp.beta);
  const fw = state.poseFilter.filter(res.pose.world, tSec);
  const pose = new Array(33), vis = new Array(33);
  for (let i = 0; i < 33; i++) {
    const src = mirror ? MIRROR_IDX[i] : i;
    pose[i] = toCanon(fw[src], mirror);
    vis[i] = res.pose.world[src].visibility ?? res.pose.image[src].visibility ?? 1;
  }

  const root = $('chkRoot').checked ? estimateRoot(res.pose, mirror, tSec) : null;
  if ($('chkProportions').checked) updateProportions(fw, res.pose.world);

  state.rt.update({
    pose, vis, hands: handsCanon, root,
    opts: { legs: $('chkLegs').checked, ground: $('chkGround').checked, fingers: true },
  });
  state.lastFrame = { pose, vis };
  if (state.recorder?.recording) {
    state.recorder.add(tSec, {
      world: res.pose.world.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4), +(p.visibility ?? 0).toFixed(3)]),
      hands: Object.fromEntries(Object.entries(rawHands).map(([k, v]) => [k, v ? v.h.world.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)]) : null])),
    });
    $('recTime').textContent = state.recorder.duration.toFixed(1) + 's';
  }
}

// Root translation from the 2D image: horizontal position and distance from apparent body size.
function estimateRoot(pose, mirror, tSec) {
  const img = pose.image, w = pose.world;
  const aspect = (video.videoHeight || 720) / (video.videoWidth || 1280);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const iHip = mid(img[LM.lHip], img[LM.rHip]), iSh = mid(img[LM.lShoulder], img[LM.rShoulder]);
  const wHip = mid(w[LM.lHip], w[LM.rHip]), wSh = mid(w[LM.lShoulder], w[LM.rShoulder]);
  const imgTorso = Math.hypot(iSh.x - iHip.x, (iSh.y - iHip.y) * aspect);
  const worldTorso = Math.hypot(wSh.x - wHip.x, wSh.y - wHip.y, wSh.z - wHip.z);
  if (imgTorso < 1e-3) return null;
  const metersPerWidth = worldTorso / imgTorso;
  const depth = metersPerWidth / 1.15; // assumes ~60 deg horizontal webcam FOV
  const x = (iHip.x - 0.5) * metersPerWidth;
  const fx = state.rootFilters[0].filter(x, tSec - (state.rootT ?? tSec));
  const fz = state.rootFilters[1].filter(depth, tSec - (state.rootT ?? tSec));
  state.rootT = tSec;
  if (!state.rootCalib) state.rootCalib = { x: fx, z: fz };
  const rx = fx - state.rootCalib.x;
  return { x: mirror ? -rx : rx, z: state.rootCalib.z - fz };
}

function updateProportions(fw, raw) {
  const vis = (i) => (raw[i].visibility ?? 1) > 0.6;
  const d = (a, b) => Math.hypot(fw[a].x - fw[b].x, fw[a].y - fw[b].y, fw[a].z - fw[b].z);
  const m = (a, b) => ({ x: (fw[a].x + fw[b].x) / 2, y: (fw[a].y + fw[b].y) / 2, z: (fw[a].z + fw[b].z) / 2 });
  const sh = m(11, 12), hp = m(23, 24);
  const torso = Math.hypot(sh.x - hp.x, sh.y - hp.y, sh.z - hp.z);
  if (!(vis(11) && vis(12) && vis(23) && vis(24)) || torso < 0.1) return;
  const P = state.proportions || (state.proportions = { n: 0, user: {} });
  const meas = {
    shoulders: d(11, 12), hips: d(23, 24),
    upperArm: vis(13) && (d(11, 13) + d(12, 14)) / 2, foreArm: vis(15) && (d(13, 15) + d(14, 16)) / 2,
    thigh: vis(25) && vis(26) && (d(23, 25) + d(24, 26)) / 2, shin: vis(27) && vis(28) && (d(25, 27) + d(26, 28)) / 2,
  };
  for (const [k, val] of Object.entries(meas)) {
    if (!val) continue;
    const r = val / torso;
    P.user[k] = P.user[k] === undefined ? r : P.user[k] * 0.97 + r * 0.03;
  }
  if (++P.n % 10) return;
  const model = state.rt.modelSegments();
  const clamp = (x) => Math.min(1.35, Math.max(0.75, x));
  const scales = {};
  for (const k of ['upperArm', 'foreArm', 'thigh', 'shin', 'shoulders', 'hips']) {
    scales[k] = P.user[k] ? clamp(P.user[k] / (model[k] / model.torso)) : 1;
  }
  state.rt.setProportions(scales);
}

function drawOverlay(res, hands) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  if (overlay.width !== vw) { overlay.width = vw; overlay.height = vh; }
  octx.clearRect(0, 0, vw, vh);
  const lw = Math.max(2, vw / 320);
  if (res.pose) {
    const p = res.pose.image;
    octx.strokeStyle = 'rgba(90,169,255,0.9)';
    octx.lineWidth = lw * 1.5;
    octx.beginPath();
    for (const [a, b] of POSE_LINKS) {
      if ((p[a].visibility ?? 1) < 0.4 || (p[b].visibility ?? 1) < 0.4) continue;
      octx.moveTo(p[a].x * vw, p[a].y * vh);
      octx.lineTo(p[b].x * vw, p[b].y * vh);
    }
    octx.stroke();
  }
  for (const [side, h] of Object.entries(hands)) {
    if (!h) continue;
    const p = h.h.image;
    octx.strokeStyle = side === 'Left' ? 'rgba(255,170,80,0.95)' : 'rgba(120,255,160,0.95)';
    octx.lineWidth = lw;
    octx.beginPath();
    for (const [a, b] of HAND_LINKS) {
      octx.moveTo(p[a].x * vw, p[a].y * vh);
      octx.lineTo(p[b].x * vw, p[b].y * vh);
    }
    octx.stroke();
  }
}

// ---------------- main loop ----------------
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = clock.getDelta();
  if (state.playing) {
    state.mixer.update(dt);
  } else if (state.running && video.readyState >= 2 && video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    const now = performance.now();
    try {
      processResult(state.tracker.detect(video, now), now / 1000);
    } catch (err) {
      console.error(err);
    }
    state.fpsCount++;
  }
  const now = performance.now();
  if (now - state.fpsT > 1000) {
    $('fps').textContent = state.running ? `${Math.round(state.fpsCount * 1000 / (now - state.fpsT))} fps` : '';
    state.fpsCount = 0;
    state.fpsT = now;
  }
  controls.update();
  renderer.render(scene, camera);
}

loadCharacter('mannequin');
loop();

// Hooks for debugging / automated tests.
window.mocap = { state, THREE, processResult, loadCharacter };
