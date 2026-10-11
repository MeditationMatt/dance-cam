# Mocap Mirror

Webcam → full-body 3D motion capture in the browser. A rigged 3D character mirrors your
body (and fingers) in real time, and you can record takes and export them for animation.

**Live (once merged to `main`):** https://meditationmatt.github.io/dance-cam/mocap/

## Run locally

The camera needs `https://` or `localhost`:

```sh
cd dance-cam
python3 -m http.server 8000
# open http://localhost:8000/mocap/
```

Use Chrome or Edge on a machine with a GPU. Stand 2–3 m back so your whole body is in frame.

## Features

- **Tracking:** MediaPipe Pose Landmarker (33 3D landmarks; Lite/Full/Heavy models) plus the
  Hand Landmarker (21 points per hand) for fingers. One-Euro filtering with a smoothing slider.
- **Retargeting:** each bone is aimed at the landmark directions as a world-space rotation from
  the rig's own rest pose. This handles T-pose or A-pose rigs, any bone roll and any orientation:
  torso twist across the spine chain, elbow/knee bend planes, forearm/wrist roll from the palm,
  feet, head and every finger joint.
- **Mirror mode:** move your right hand and the character moves on the same side of the screen.
  Turn it off for a "camera view" where your right drives the character's right.
- **Root motion:** walk left/right or toward/away from the camera and the character follows.
  **Keep feet on floor** pins the lowest foot to the ground, so squats and crouches work.
  Use **Recenter** to set your home spot.
- **Match my proportions:** stretches the character's limb lengths toward yours.
- **Characters:** a built-in mannequin, X Bot / Michelle / Soldier (Mixamo rigs from the three.js
  examples), or **load your own** Mixamo FBX/GLB/GLTF (button or drag & drop). Mixamo bone names
  (with or without the `mixamorig:` prefix) work, along with common VRM / Unity / Unreal-style
  humanoid names.
- **Capture:** Record (or press `R`; optional 3-second countdown), then:
  - **BVH**: skeleton + motion in centimeters with ZXY rotations. Import into Blender
    (File → Import → Motion Capture), MotionBuilder, Maya, Cascadeur and similar tools.
  - **GLB**: your current character with the take baked in as an animation clip.
  - **JSON**: raw MediaPipe world landmarks per frame, for custom processing.
  - **Play take** previews the recording on the character.

Takes are recorded as shown on screen. For animation, you usually want **Mirror mode off**
while recording, so the character's left really is your left.

## Mixamo characters

On mixamo.com pick a character, click Download, and choose **FBX Binary, T-Pose, With Skin**.
Then load it here. To retarget a BVH onto a Mixamo character in Blender, use an add-on such as
Rokoko Studio Live or Auto-Rig Pro, or load the GLB export directly.

## Files

- `js/tracker.js`: MediaPipe pose + hand landmarkers (GPU with CPU fallback)
- `js/retarget.js`: landmark → bone retargeting, grounding, proportions
- `js/recorder.js`: take recording, BVH / GLB / JSON export
- `js/mannequin.js`: built-in procedural character with a Mixamo skeleton
- `js/filters.js`: One-Euro filter
- `js/main.js`: scene, UI, camera and the main loop
