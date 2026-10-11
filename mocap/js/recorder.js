// Captures the retargeted skeleton every tracking frame and exports it as
// BVH (Blender / MotionBuilder / Maya), animated GLB, or raw landmark JSON.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { canonicalBoneName } from './retarget.js';

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3(), _p2 = new THREE.Vector3();
const RAD2DEG = 180 / Math.PI;

export class MotionRecorder {
  constructor(retargeter) {
    this.rt = retargeter;
    this.bones = retargeter.allBones;
    this.hips = retargeter.bones.Hips;
    this.clear();
  }

  clear() {
    this.frames = [];
    this.landmarks = [];
    this.recording = false;
    this.t0 = 0;
  }

  get duration() {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }

  start(tSec) {
    this.clear();
    this.recording = true;
    this.t0 = tSec;
  }

  stop() { this.recording = false; }

  add(tSec, rawLandmarks) {
    if (!this.recording) return;
    const t = tSec - this.t0;
    const q = new Float32Array(this.bones.length * 4);
    this.bones.forEach((b, i) => b.quaternion.toArray(q, i * 4));
    this.frames.push({ t, q, hp: this.hips.position.toArray() });
    if (rawLandmarks) this.landmarks.push({ t, ...rawLandmarks });
  }

  // Interpolated pose at time t: { q: Quaternion[], hp: Vector3 }
  sample(t) {
    const f = this.frames;
    let i = 0;
    while (i < f.length - 2 && f[i + 1].t < t) i++;
    const a = f[i], b = f[Math.min(i + 1, f.length - 1)];
    const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const q = this.bones.map((_, j) => {
      _q.fromArray(a.q, j * 4);
      _q2.fromArray(b.q, j * 4);
      return new THREE.Quaternion().slerpQuaternions(_q, _q2, k);
    });
    const hp = new THREE.Vector3().fromArray(a.hp).lerp(_p.fromArray(b.hp), k);
    return { q, hp };
  }

  toClip(name = 'mocap') {
    const times = new Float32Array(this.frames.map((f) => f.t));
    const tracks = this.bones.map((b, j) => {
      const vals = new Float32Array(this.frames.length * 4);
      this.frames.forEach((f, i) => { for (let c = 0; c < 4; c++) vals[i * 4 + c] = f.q[j * 4 + c]; });
      return new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, vals);
    });
    const pos = new Float32Array(this.frames.length * 3);
    this.frames.forEach((f, i) => pos.set(f.hp, i * 3));
    tracks.push(new THREE.VectorKeyframeTrack(`${this.hips.name}.position`, times, pos));
    return new THREE.AnimationClip(name, this.duration, tracks);
  }

  async toGLB(name = 'mocap') {
    const clip = this.toClip(name);
    this.rt.resetPose();
    const exporter = new GLTFExporter();
    return exporter.parseAsync(this.rt.root, { binary: true, animations: [clip], onlyVisible: false });
  }

  toJSON() {
    return JSON.stringify({
      format: 'mediapipe-pose-world-landmarks',
      note: 'Raw (unfiltered, un-mirrored) MediaPipe world landmarks in meters; y down, z away from camera.',
      frames: this.landmarks,
    });
  }

  // BVH in centimeters, Hips as root, ZXY Euler channels (Blender/MotionBuilder/Maya friendly).
  toBVH(fps = 30) {
    const root = this.rt.root;
    root.updateMatrixWorld(true);
    // Bake whatever sits between the model root and the hips (e.g. a rotated, 0.01-scaled armature).
    const parentRel = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(this.hips.parent.matrixWorld);
    const pPos = new THREE.Vector3(), pQuat = new THREE.Quaternion(), pScale = new THREE.Vector3();
    parentRel.decompose(pPos, pQuat, pScale);
    const rootScale = root.getWorldScale(new THREE.Vector3()).y;
    const hipHeightRootUnits = this.rt.restHipHeight / rootScale;
    const unit = hipHeightRootUnits > 10 ? 1 : 100; // root units -> cm
    const childScale = pScale.x * unit;

    const index = new Map(this.bones.map((b, i) => [b, i]));
    const used = new Set();
    const nameOf = (b) => {
      let n = canonicalBoneName(b.name).replace(/\s+/g, '_') || 'Bone';
      let k = n, i = 1;
      while (used.has(k)) k = `${n}_${i++}`;
      used.add(k);
      return k;
    };
    const f = (x) => (Math.abs(x) < 1e-6 ? 0 : x).toFixed(4);
    const order = []; // bones with channels, in DFS order
    const lines = ['HIERARCHY'];

    const rootOffset = _p2.set(0, 0, 0); // root position channels are absolute
    const walk = (b, depth, isRoot) => {
      const pad = '  '.repeat(depth);
      const kids = b.children.filter((c) => c.isBone);
      lines.push(`${pad}${isRoot ? 'ROOT' : 'JOINT'} ${nameOf(b)}`, `${pad}{`);
      const off = isRoot ? rootOffset : _p.copy(b.position).multiplyScalar(childScale);
      lines.push(`${pad}  OFFSET ${f(off.x)} ${f(off.y)} ${f(off.z)}`);
      lines.push(isRoot
        ? `${pad}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`
        : `${pad}  CHANNELS 3 Zrotation Xrotation Yrotation`);
      order.push(b);
      for (const c of kids) walk(c, depth + 1, false);
      if (!kids.length) lines.push(`${pad}  End Site`, `${pad}  {`, `${pad}    OFFSET 0 0 0`, `${pad}  }`);
      lines.push(`${pad}}`);
    };
    walk(this.hips, 0, true);

    const dt = 1 / fps;
    const n = Math.max(1, Math.floor(this.duration * fps) + 1);
    lines.push('MOTION', `Frames: ${n}`, `Frame Time: ${dt.toFixed(6)}`);
    for (let i = 0; i < n; i++) {
      const s = this.sample(i * dt);
      const row = [];
      for (const b of order) {
        let q = s.q[index.get(b)];
        if (b === this.hips) {
          const p = _p.copy(s.hp).applyMatrix4(parentRel).multiplyScalar(unit);
          row.push(f(p.x), f(p.y), f(p.z));
          q = _q.multiplyQuaternions(pQuat, q);
        }
        _e.setFromQuaternion(q, 'ZXY');
        row.push(f(_e.z * RAD2DEG), f(_e.x * RAD2DEG), f(_e.y * RAD2DEG));
      }
      lines.push(row.join(' '));
    }
    return lines.join('\n') + '\n';
  }
}
