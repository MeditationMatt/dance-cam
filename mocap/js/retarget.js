// Retargets MediaPipe 3D landmarks onto any Mixamo-style humanoid skeleton.
//
// Landmarks arrive in a "canonical" person frame: +X = the person's left,
// +Y = up, +Z = toward the camera (the way the person faces). Every bone's
// target is expressed as a world-space rotation *delta* from its rest pose,
// built from landmark directions, so it works for any rest pose (T or A),
// any bone roll convention and any model orientation/scale.
import * as THREE from 'three';

// Pose landmark indices (MediaPipe BlazePose, 33 points).
export const LM = {
  nose: 0, lEar: 7, rEar: 8, lMouth: 9, rMouth: 10,
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lThumb: 21, rThumb: 22,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
};

// Hand landmark chains (MediaPipe hand, 21 points) -> Mixamo finger bones.
const FINGER_LM = {
  Thumb: [1, 2, 3, 4], Index: [5, 6, 7, 8], Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16], Pinky: [17, 18, 19, 20],
};

// Common non-Mixamo humanoid names (VRM, Unity/Unreal-ish) mapped to Mixamo.
const ALIASES = {
  hips: 'Hips', pelvis: 'Hips', spine: 'Spine', chest: 'Spine1', upperchest: 'Spine2',
  spine01: 'Spine', spine02: 'Spine1', spine03: 'Spine2', neck: 'Neck', head: 'Head',
  leftupperarm: 'LeftArm', rightupperarm: 'RightArm', leftlowerarm: 'LeftForeArm', rightlowerarm: 'RightForeArm',
  upperarml: 'LeftArm', upperarmr: 'RightArm', lowerarml: 'LeftForeArm', lowerarmr: 'RightForeArm',
  leftclavicle: 'LeftShoulder', rightclavicle: 'RightShoulder', claviclel: 'LeftShoulder', clavicler: 'RightShoulder',
  handl: 'LeftHand', handr: 'RightHand',
  leftupperleg: 'LeftUpLeg', rightupperleg: 'RightUpLeg', leftlowerleg: 'LeftLeg', rightlowerleg: 'RightLeg',
  thighl: 'LeftUpLeg', thighr: 'RightUpLeg', calfl: 'LeftLeg', calfr: 'RightLeg',
  footl: 'LeftFoot', footr: 'RightFoot', lefttoes: 'LeftToeBase', righttoes: 'RightToeBase',
  balll: 'LeftToeBase', ballr: 'RightToeBase',
};

export function canonicalBoneName(name) {
  let n = name.replace(/^mixamorig\d*[:_]?/i, '').replace(/^.*[:|]/, '');
  const key = n.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ALIASES[key] || n;
}

const v = () => new THREE.Vector3();
const _m = new THREE.Matrix4();
const _x = v(), _y = v(), _z = v();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _va = v(), _vb = v(), _vc = v();

// Rotation whose X axis is `primary` and whose Z axis is `hint` made orthogonal.
function basisQuat(primary, hint, out) {
  _x.copy(primary).normalize();
  _z.copy(hint).addScaledVector(_x, -hint.dot(_x));
  if (_z.lengthSq() < 1e-10) return null;
  _z.normalize();
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

function perp(a, axis, out) {
  const n = _vc.copy(axis).normalize();
  return out.copy(a).addScaledVector(n, -a.dot(n));
}

const smooth01 = (x, a, b) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Retargeter {
  constructor(root) {
    this.root = root;
    this.bones = {};
    this.allBones = [];
    root.traverse((o) => {
      if (!o.isBone) return;
      this.allBones.push(o);
      const c = canonicalBoneName(o.name);
      if (!this.bones[c]) this.bones[c] = o;
    });
    const need = ['Hips', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand',
      'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot', 'Head'];
    this.missing = need.filter((n) => !this.bones[n]);
    if (this.missing.length) throw new Error('Rig is missing bones: ' + this.missing.join(', '));

    this.spineChain = ['Spine', 'Spine1', 'Spine2'].map((n) => this.bones[n]).filter(Boolean);
    this.chest = this.spineChain[this.spineChain.length - 1] || this.bones.Hips;

    this.restLocal = new Map();
    for (const b of this.allBones) {
      this.restLocal.set(b, { q: b.quaternion.clone(), p: b.position.clone() });
    }
    this.captureRest();
    this.lengthScale = new Map(); // bone -> scale applied to rest local position (proportions)
  }

  b(name) { return this.bones[name]; }

  resetPose() {
    for (const [b, r] of this.restLocal) {
      b.quaternion.copy(r.q);
      b.position.copy(r.p).multiplyScalar(this.lengthScale?.get(b) ?? 1);
    }
    this.root.updateMatrixWorld(true);
  }

  captureRest() {
    this.root.updateMatrixWorld(true);
    this.restWorld = new Map();
    for (const b of this.allBones) {
      this.restWorld.set(b, { q: b.getWorldQuaternion(new THREE.Quaternion()), p: b.getWorldPosition(v()) });
    }
    const P = (n) => this.restWorld.get(this.bones[n]).p;
    const mid = (a, b) => v().addVectors(P(a), P(b)).multiplyScalar(0.5);

    // Model frame (left, up, forward) in world space.
    const left = v().subVectors(P('LeftUpLeg'), P('RightUpLeg')).normalize()
      .add(v().subVectors(P('LeftArm'), P('RightArm')).normalize()).normalize();
    const hipC = mid('LeftUpLeg', 'RightUpLeg');
    const shC = mid('LeftArm', 'RightArm');
    let up = v().subVectors(shC, hipC).normalize();
    const fwd = v().crossVectors(left, up).normalize();
    up = v().crossVectors(fwd, left).normalize();
    this.left = left; this.up = up; this.fwd = fwd;
    this.frameQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, fwd));

    // Model scale: hip height above the lowest foot point.
    this.restFloor = Math.min(...this.footBones().map((b) => this.restWorld.get(b).p.dot(up)));
    this.restHipHeight = this.restWorld.get(this.bones.Hips).p.dot(up) - this.restFloor;
    this.torsoLen = shC.distanceTo(hipC);

    const rb = {}; // rest basis inverses
    const inv = (prim, hint) => {
      const q = basisQuat(prim, hint, new THREE.Quaternion());
      return q ? q.invert() : new THREE.Quaternion();
    };
    const torsoUp = v().subVectors(shC, hipC);
    rb.hips = inv(v().subVectors(P('LeftUpLeg'), P('RightUpLeg')), torsoUp);
    rb.chest = inv(v().subVectors(P('LeftArm'), P('RightArm')), torsoUp);
    // Nose sits slightly below the ear line: rest "face forward" tilts down ~17deg.
    const faceFwd = v().copy(fwd).multiplyScalar(Math.cos(0.3)).addScaledVector(up, -Math.sin(0.3));
    rb.head = inv(left, faceFwd);
    rb.neutralFace = faceFwd;

    for (const s of ['Left', 'Right']) {
      const palm = this.restPalm(s);
      const handTip = this.bones[s + 'HandMiddle1'] || this.bones[s + 'HandIndex1'];
      const handDir = handTip ? v().subVectors(this.restWorld.get(handTip).p, P(s + 'Hand'))
        : v().subVectors(P(s + 'Hand'), P(s + 'ForeArm'));
      rb[s] = {
        palm,
        armDir: v().subVectors(P(s + 'ForeArm'), P(s + 'Arm')),
        armHint: fwd.clone(),
        foreDir: v().subVectors(P(s + 'Hand'), P(s + 'ForeArm')),
        handDir,
        upLegDir: v().subVectors(P(s + 'Leg'), P(s + 'UpLeg')),
        legDir: v().subVectors(P(s + 'Foot'), P(s + 'Leg')),
        toeDir: this.bones[s + 'ToeBase'] ? v().subVectors(P(s + 'ToeBase'), P(s + 'Foot')) : fwd.clone(),
      };
      const r = rb[s];
      r.armInv = inv(r.armDir, r.armHint);
      r.foreInv = inv(r.foreDir, palm);
      r.handInv = inv(handDir, palm);
      r.upLegInv = inv(r.upLegDir, fwd);
      r.legInv = inv(r.legDir, r.toeDir);
      const footFlat = perp(r.toeDir, up, v());
      if (footFlat.lengthSq() < 1e-8) footFlat.copy(fwd);
      r.footInv = inv(footFlat, up);
    }
    this.rb = rb;
  }

  footBones() {
    return ['LeftToeBase', 'RightToeBase', 'LeftFoot', 'RightFoot'].map((n) => this.bones[n]).filter(Boolean);
  }

  // Palm normal: same formula is used on the rig and on landmarks, so sign conventions cancel out.
  restPalm(side) {
    const P = (n) => this.restWorld.get(this.bones[n]).p;
    const w = P(side + 'Hand');
    const idx = this.bones[side + 'HandIndex1'] ? P(side + 'HandIndex1') : null;
    const pin = this.bones[side + 'HandPinky1'] ? P(side + 'HandPinky1') : (this.bones[side + 'HandRing1'] ? P(side + 'HandRing1') : null);
    if (idx && pin) return palmNormal(side, w, idx, pin, v());
    // No fingers: assume palm faces down in T-pose / toward body in A-pose.
    return this.up.clone().negate();
  }

  // ---------- core helpers ----------

  deltaOf(bone, out) {
    bone.getWorldQuaternion(out);
    return out.multiply(_qa.copy(this.restWorld.get(bone).q).invert());
  }

  applyDelta(bone, delta) {
    if (!bone) return;
    const target = _qb.multiplyQuaternions(delta, this.restWorld.get(bone).q);
    bone.parent.getWorldQuaternion(_qc);
    bone.quaternion.copy(_qc.invert().multiply(target));
    bone.updateMatrixWorld(true);
  }

  // Minimal rotation that carries the bone's rest direction (as moved by its parent) onto target.
  swingDelta(bone, restDir, target, out) {
    const parentDelta = this.deltaOf(bone.parent, new THREE.Quaternion());
    const carried = _va.copy(restDir).applyQuaternion(parentDelta).normalize();
    const t = _vb.copy(target).normalize();
    out.setFromUnitVectors(carried, t);
    return out.multiply(parentDelta);
  }

  basisDelta(prim, hint, restInv, out) {
    if (!basisQuat(prim, hint, out)) return null;
    return out.multiply(restInv);
  }

  // ---------- proportions ----------

  // scales: { upperArm, foreArm, thigh, shin, shoulders, hips } as ratios (1 = model default).
  setProportions(scales) {
    this.lengthScale = new Map();
    const set = (name, s) => { const b = this.bones[name]; if (b) this.lengthScale.set(b, s); };
    for (const s of ['Left', 'Right']) {
      if (scales) {
        set(s + 'ForeArm', scales.upperArm);
        set(s + 'Hand', scales.foreArm);
        set(s + 'Leg', scales.thigh);
        set(s + 'Foot', scales.shin);
        set(s + 'Arm', scales.shoulders);
        set(s + 'UpLeg', scales.hips);
      }
    }
    for (const [b, r] of this.restLocal) {
      if (b === this.bones.Hips) continue;
      b.position.copy(r.p).multiplyScalar(this.lengthScale.get(b) ?? 1);
    }
  }

  modelSegments() {
    const P = (n) => this.restWorld.get(this.bones[n]).p;
    const d = (a, b) => P(a).distanceTo(P(b));
    return {
      torso: this.torsoLen,
      upperArm: (d('LeftArm', 'LeftForeArm') + d('RightArm', 'RightForeArm')) / 2,
      foreArm: (d('LeftForeArm', 'LeftHand') + d('RightForeArm', 'RightHand')) / 2,
      thigh: (d('LeftUpLeg', 'LeftLeg') + d('RightUpLeg', 'RightLeg')) / 2,
      shin: (d('LeftLeg', 'LeftFoot') + d('RightLeg', 'RightFoot')) / 2,
      shoulders: d('LeftArm', 'RightArm'),
      hips: d('LeftUpLeg', 'RightUpLeg'),
    };
  }

  // ---------- per-frame update ----------
  //
  // frame = {
  //   pose: Vector3[33] (canonical, meters), vis: number[33],
  //   hands: { Left: Vector3[21] | null, Right: Vector3[21] | null } (canonical),
  //   root: { x, z } | null (canonical meters, relative to calibration),
  //   opts: { legs: bool, ground: bool, fingers: bool }
  // }
  update(frame) {
    const { pose, vis, hands = {}, root, opts = {} } = frame;
    const F = this.frameQ;
    const W = pose.map((p) => p.clone().applyQuaternion(F)); // canonical -> model world directions
    const seen = (...ids) => ids.every((i) => (vis[i] ?? 1) > (opts.visThreshold ?? 0.5));
    const sub = (a, b) => v().subVectors(W[a], W[b]);
    const rb = this.rb;
    const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();

    // Start from a clean hierarchy with the hips at rest location (re-placed at the end).
    const hips = this.bones.Hips;
    hips.position.copy(this.restLocal.get(hips).p);
    this.root.updateMatrixWorld(true);

    // ----- torso -----
    const hipC = v().addVectors(W[LM.lHip], W[LM.rHip]).multiplyScalar(0.5);
    const shC = v().addVectors(W[LM.lShoulder], W[LM.rShoulder]).multiplyScalar(0.5);
    const torsoUp = v().subVectors(shC, hipC);
    const dHips = this.basisDelta(sub(LM.lHip, LM.rHip), torsoUp, rb.hips, new THREE.Quaternion()) || new THREE.Quaternion();
    const dChest = this.basisDelta(sub(LM.lShoulder, LM.rShoulder), torsoUp, rb.chest, new THREE.Quaternion()) || dHips.clone();
    this.applyDelta(hips, dHips);
    const n = this.spineChain.length;
    this.spineChain.forEach((bone, k) => {
      this.applyDelta(bone, q1.slerpQuaternions(dHips, dChest, (k + 1) / n));
    });

    // ----- neck / head -----
    if (seen(LM.lEar, LM.rEar) || seen(LM.nose)) {
      const earMid = v().addVectors(W[LM.lEar], W[LM.rEar]).multiplyScalar(0.5);
      const face = v().subVectors(W[LM.nose], earMid);
      const dHead = this.basisDelta(sub(LM.lEar, LM.rEar), face, rb.head, new THREE.Quaternion());
      if (dHead) {
        if (this.bones.Neck) this.applyDelta(this.bones.Neck, q1.slerpQuaternions(dChest, dHead, 0.5));
        this.applyDelta(this.bones.Head, dHead);
      }
    }

    // ----- arms -----
    for (const s of ['Left', 'Right']) {
      const L = s === 'Left';
      const iS = L ? LM.lShoulder : LM.rShoulder, iE = L ? LM.lElbow : LM.rElbow, iW = L ? LM.lWrist : LM.rWrist;
      const iI = L ? LM.lIndex : LM.rIndex, iP = L ? LM.lPinky : LM.rPinky;
      if (!seen(iE)) continue;
      const r = rb[s];
      const arm = this.bones[s + 'Arm'], fore = this.bones[s + 'ForeArm'], hand = this.bones[s + 'Hand'];
      const upper = sub(iE, iS);
      const lower = sub(iW, iE);

      // Upper arm: aim at elbow; roll from the elbow-bend plane, fading to a pure swing when straight.
      const bend = v().crossVectors(upper.clone().normalize(), lower.clone().normalize()).length();
      const swing = this.swingDelta(arm, r.armDir, upper, q1);
      const swingHint = r.armHint.clone().applyQuaternion(swing);
      const bendHint = perp(lower, upper, v());
      if (bendHint.lengthSq() > 1e-10) bendHint.normalize();
      const w = smooth01(bend, 0.08, 0.4);
      const hint = swingHint.multiplyScalar(1 - w).addScaledVector(bendHint, w);
      const dArm = this.basisDelta(upper, hint, r.armInv, q2) || swing;
      this.applyDelta(arm, dArm);

      if (!seen(iW)) continue;
      // Palm / hand direction: prefer the dedicated hand model if available.
      const H = hands[s];
      let palm, handDir;
      if (H) {
        const Hw = H.map((p) => p.clone().applyQuaternion(F));
        palm = palmNormal(s, Hw[0], Hw[5], Hw[17], v());
        handDir = v().subVectors(Hw[9], Hw[0]);
        hands[s + 'World'] = Hw;
      } else {
        palm = palmNormal(s, W[iW], W[iI], W[iP], v());
        handDir = v().subVectors(v().addVectors(W[iI], W[iP]).multiplyScalar(0.5), W[iW]);
      }

      // Forearm takes ~60% of the wrist roll (Mixamo rigs have no twist bones), hand takes the rest.
      const foreSwing = this.swingDelta(fore, r.foreDir, lower, new THREE.Quaternion());
      const foreFull = this.basisDelta(lower, palm, r.foreInv, new THREE.Quaternion());
      this.applyDelta(fore, foreFull ? foreSwing.slerp(foreFull, 0.6) : foreSwing);

      const dHand = this.basisDelta(handDir, palm, r.handInv, q1);
      if (dHand) this.applyDelta(hand, dHand);

      if (H && opts.fingers !== false) this.updateFingers(s, hands[s + 'World']);
    }

    // ----- legs -----
    if (opts.legs !== false) {
      for (const s of ['Left', 'Right']) {
        const L = s === 'Left';
        const iH = L ? LM.lHip : LM.rHip, iK = L ? LM.lKnee : LM.rKnee, iA = L ? LM.lAnkle : LM.rAnkle;
        const iHe = L ? LM.lHeel : LM.rHeel, iT = L ? LM.lFoot : LM.rFoot;
        if (!seen(iK)) continue;
        const r = rb[s];
        const thigh = sub(iK, iH);
        const shin = sub(iA, iK);
        const footFwd = seen(iHe, iT) ? sub(iT, iHe) : this.fwd.clone().applyQuaternion(dHips);
        const bend = v().crossVectors(thigh.clone().normalize(), shin.clone().normalize()).length();
        const kneeFwd = perp(shin, thigh, v()).negate();
        if (kneeFwd.lengthSq() > 1e-10) kneeFwd.normalize();
        const fallback = perp(footFwd, thigh, v());
        if (fallback.lengthSq() > 1e-10) fallback.normalize();
        const w = smooth01(bend, 0.1, 0.45);
        const hint = fallback.multiplyScalar(1 - w).addScaledVector(kneeFwd, w);
        const dUp = this.basisDelta(thigh, hint, r.upLegInv, q1);
        if (dUp) this.applyDelta(this.bones[s + 'UpLeg'], dUp);

        if (!seen(iA)) continue;
        const dLeg = this.basisDelta(shin, footFwd, r.legInv, q1);
        if (dLeg) this.applyDelta(this.bones[s + 'Leg'], dLeg);

        if (seen(iHe, iT)) {
          const dFoot = this.basisDelta(sub(iT, iHe), sub(iA, iHe), r.footInv, q1);
          if (dFoot) this.applyDelta(this.bones[s + 'Foot'], dFoot);
        }
      }
    }

    // ----- root position + grounding -----
    const scale = this.restHipHeight / 0.92; // model units per (average) human meter of hip height
    const desired = this.restWorld.get(hips).p.clone();
    if (root) desired.add(v().set(root.x, 0, root.z).applyQuaternion(F).multiplyScalar(scale));
    this.setHipsWorld(desired);
    if (opts.ground !== false && opts.legs !== false) {
      const feet = this.footBones();
      const lowest = Math.min(...feet.map((b) => b.getWorldPosition(_va).dot(this.up)));
      desired.addScaledVector(this.up, this.restFloor - lowest);
      this.setHipsWorld(desired);
    }
  }

  setHipsWorld(worldPos) {
    const hips = this.bones.Hips;
    hips.position.copy(hips.parent.worldToLocal(worldPos.clone()));
    hips.updateMatrixWorld(true);
  }

  updateFingers(side, Hw) {
    const q = new THREE.Quaternion();
    for (const [f, ids] of Object.entries(FINGER_LM)) {
      const chain = [1, 2, 3, 4].map((i) => this.bones[side + 'Hand' + f + i]);
      for (let k = 0; k < 3; k++) {
        const bone = chain[k];
        if (!bone) break;
        const P = (b) => this.restWorld.get(b).p;
        let restDir;
        if (chain[k + 1]) restDir = v().subVectors(P(chain[k + 1]), P(bone));
        else if (k > 0) restDir = v().subVectors(P(bone), P(chain[k - 1]));
        else continue;
        const target = v().subVectors(Hw[ids[k + 1]], Hw[ids[k]]);
        this.applyDelta(bone, this.swingDelta(bone, restDir, target, q));
      }
    }
  }
}

export function palmNormal(side, wrist, index, pinky, out) {
  const a = _va.subVectors(index, wrist), b = _vb.subVectors(pinky, wrist);
  return side === 'Left' ? out.crossVectors(b, a).normalize() : out.crossVectors(a, b).normalize();
}
