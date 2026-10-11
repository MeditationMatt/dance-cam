// MediaPipe Tasks Vision wrapper: body pose (33 3D landmarks) + optional hands (21 each).
import { FilesetResolver, PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODELS = 'https://storage.googleapis.com/mediapipe-models';
const POSE_MODELS = {
  lite: `${MODELS}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`,
  full: `${MODELS}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`,
  heavy: `${MODELS}/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task`,
};
const HAND_MODEL = `${MODELS}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`;

export class Tracker {
  constructor() {
    this.vision = null;
    this.pose = null;
    this.hands = null;
    this.poseQuality = null;
    this.delegate = 'GPU';
  }

  async ensureVision() {
    if (!this.vision) this.vision = await FilesetResolver.forVisionTasks(WASM);
    return this.vision;
  }

  async create(Task, options) {
    const vision = await this.ensureVision();
    try {
      return await Task.createFromOptions(vision, { ...options, baseOptions: { ...options.baseOptions, delegate: this.delegate } });
    } catch (err) {
      if (this.delegate !== 'GPU') throw err;
      console.warn('GPU delegate failed, falling back to CPU', err);
      this.delegate = 'CPU';
      return Task.createFromOptions(vision, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
    }
  }

  async setPoseQuality(quality) {
    if (this.poseQuality === quality && this.pose) return;
    const old = this.pose;
    this.pose = await this.create(PoseLandmarker, {
      baseOptions: { modelAssetPath: POSE_MODELS[quality] },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    this.poseQuality = quality;
    old?.close();
  }

  async setHandsEnabled(on) {
    if (on && !this.hands) {
      this.hands = await this.create(HandLandmarker, {
        baseOptions: { modelAssetPath: HAND_MODEL },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } else if (!on && this.hands) {
      this.hands.close();
      this.hands = null;
    }
  }

  // Returns { pose: {image, world} | null, hands: [{image, world}] }
  detect(video, timestampMs) {
    const out = { pose: null, hands: [] };
    if (this.pose) {
      const r = this.pose.detectForVideo(video, timestampMs);
      if (r.landmarks?.length) out.pose = { image: r.landmarks[0], world: r.worldLandmarks[0] };
    }
    if (this.hands) {
      const r = this.hands.detectForVideo(video, timestampMs);
      for (let i = 0; i < (r.landmarks?.length || 0); i++) {
        out.hands.push({ image: r.landmarks[i], world: r.worldLandmarks[i] });
      }
    }
    return out;
  }
}
