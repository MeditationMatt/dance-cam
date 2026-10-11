// Procedural mannequin with a Mixamo-compatible skeleton (T-pose, meters, faces +Z).
// Used as the default/offline character; every bone carries rigid capsule "limbs".
import * as THREE from 'three';

const FINGERS = {
  Thumb:  { base: [0.025, -0.012, 0.030], segs: [[0.032, 0, 0.022], [0.030, 0, 0.012], [0.026, 0, 0.004]], r: 0.0105 },
  Index:  { base: [0.092, 0.002, 0.026], segs: [[0.042, 0, 0], [0.026, 0, 0], [0.022, 0, 0]], r: 0.0095 },
  Middle: { base: [0.095, 0.003, 0.007], segs: [[0.046, 0, 0], [0.029, 0, 0], [0.024, 0, 0]], r: 0.0098 },
  Ring:   { base: [0.090, 0.002, -0.012], segs: [[0.042, 0, 0], [0.027, 0, 0], [0.022, 0, 0]], r: 0.0092 },
  Pinky:  { base: [0.082, 0.000, -0.030], segs: [[0.034, 0, 0], [0.021, 0, 0], [0.019, 0, 0]], r: 0.0082 },
};

export function createMannequin() {
  const root = new THREE.Group();
  root.name = 'Mannequin';

  const skin = new THREE.MeshStandardMaterial({ color: 0x8fa6c9, roughness: 0.45, metalness: 0.1 });
  const joint = new THREE.MeshStandardMaterial({ color: 0x2c3a52, roughness: 0.6, metalness: 0.2 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff7a59, roughness: 0.5, metalness: 0.1 });

  const bones = {};
  function bone(name, parent, pos) {
    const b = new THREE.Bone();
    b.name = 'mixamorig' + name;
    b.position.set(pos[0], pos[1], pos[2]);
    (parent ? bones[parent] : root).add(b);
    bones[name] = b;
    return b;
  }

  bone('Hips', null, [0, 0.98, 0]);
  bone('Spine', 'Hips', [0, 0.10, 0.005]);
  bone('Spine1', 'Spine', [0, 0.12, 0]);
  bone('Spine2', 'Spine1', [0, 0.12, -0.005]);
  bone('Neck', 'Spine2', [0, 0.17, 0]);
  bone('Head', 'Neck', [0, 0.09, 0.01]);
  bone('HeadTop_End', 'Head', [0, 0.20, 0]);

  for (const side of ['Left', 'Right']) {
    const sx = side === 'Left' ? 1 : -1;
    bone(side + 'Shoulder', 'Spine2', [0.045 * sx, 0.11, 0]);
    bone(side + 'Arm', side + 'Shoulder', [0.13 * sx, 0, 0]);
    bone(side + 'ForeArm', side + 'Arm', [0.28 * sx, 0, 0]);
    bone(side + 'Hand', side + 'ForeArm', [0.25 * sx, 0, 0]);
    for (const [f, d] of Object.entries(FINGERS)) {
      let parent = side + 'Hand';
      const b1 = bone(side + 'Hand' + f + '1', parent, [d.base[0] * sx, d.base[1], d.base[2]]);
      parent = b1.name.replace('mixamorig', '');
      d.segs.forEach((s, i) => {
        const nb = bone(side + 'Hand' + f + (i + 2), parent, [s[0] * sx, s[1], s[2]]);
        parent = nb.name.replace('mixamorig', '');
      });
    }
    bone(side + 'UpLeg', 'Hips', [0.09 * sx, -0.06, 0]);
    bone(side + 'Leg', side + 'UpLeg', [0, -0.42, 0]);
    bone(side + 'Foot', side + 'Leg', [0, -0.42, -0.01]);
    bone(side + 'ToeBase', side + 'Foot', [0, -0.065, 0.12]);
    bone(side + 'Toe_End', side + 'ToeBase', [0, 0, 0.06]);
  }

  // Rigid limb segment from bone a to its child b, attached to a.
  function limb(a, b, r0, r1 = r0, mat = skin) {
    const A = bones[a], B = bones[b];
    const dir = B.position.clone();
    const len = dir.length();
    const g = new THREE.CylinderGeometry(r1, r0, len, 14, 1);
    g.translate(0, len / 2, 0);
    const m = new THREE.Mesh(g, mat);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    m.castShadow = true;
    A.add(m);
    return m;
  }
  function ball(name, r, mat = joint, offset = [0, 0, 0], scale = [1, 1, 1]) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat);
    m.position.set(...offset);
    m.scale.set(...scale);
    m.castShadow = true;
    bones[name].add(m);
    return m;
  }

  // Torso and head
  ball('Hips', 0.13, skin, [0, -0.01, 0], [1.15, 0.75, 0.8]);
  ball('Spine1', 0.13, skin, [0, 0.02, 0], [1.05, 0.9, 0.75]);
  ball('Spine2', 0.15, skin, [0, 0.07, 0], [1.2, 0.85, 0.72]);
  limb('Neck', 'Head', 0.045, 0.04);
  ball('Head', 0.105, skin, [0, 0.1, 0.015], [0.88, 1.08, 1]);
  // Nose / visor so facing is obvious
  ball('Head', 0.03, accent, [0, 0.09, 0.105], [1.6, 0.6, 0.5]);

  for (const side of ['Left', 'Right']) {
    ball(side + 'Arm', 0.05);
    limb(side + 'Arm', side + 'ForeArm', 0.045, 0.04);
    ball(side + 'ForeArm', 0.04);
    limb(side + 'ForeArm', side + 'Hand', 0.038, 0.03);
    ball(side + 'Hand', 0.032, skin, [0.05 * (side === 'Left' ? 1 : -1), 0, 0], [1.6, 0.55, 1.35]);
    for (const [f, d] of Object.entries(FINGERS)) {
      for (let i = 1; i <= 3; i++) {
        limb(side + 'Hand' + f + i, side + 'Hand' + f + (i + 1), d.r, d.r * 0.85);
        ball(side + 'Hand' + f + i, d.r * 1.05);
      }
    }
    ball(side + 'UpLeg', 0.07);
    limb(side + 'UpLeg', side + 'Leg', 0.075, 0.055);
    ball(side + 'Leg', 0.055);
    limb(side + 'Leg', side + 'Foot', 0.05, 0.038);
    ball(side + 'Foot', 0.04);
    limb(side + 'Foot', side + 'ToeBase', 0.04, 0.035, accent);
    limb(side + 'ToeBase', side + 'Toe_End', 0.035, 0.03, accent);
  }

  return root;
}
