import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

// Keep the wasm version in sync with package.json.
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let filesetPromise;
const fileset = () => (filesetPromise ??= FilesetResolver.forVisionTasks(WASM));

async function make(runningMode) {
  const fs = await fileset();
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await FaceLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode,
        numFaces: 1,
      });
    } catch (err) {
      console.warn(`FaceLandmarker (${runningMode}) failed on ${delegate}`, err);
    }
  }
  throw new Error('Could not load the face model. Check your internet connection.');
}

export const createVideoTracker = () => make('VIDEO'); // live webcam
export const createImageTracker = () => make('IMAGE'); // the uploaded picture

// Ordered ring of landmark indices around the face outline.
const OVAL_FALLBACK = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
export function ovalLoop() {
  const conns = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL;
  const next = new Map(conns.map((c) => [c.start, c.end]));
  const start = conns[0].start;
  const loop = [start];
  let i = next.get(start);
  while (i !== undefined && i !== start && loop.length < 100) {
    loop.push(i);
    i = next.get(i);
  }
  return loop.length >= 30 ? loop : OVAL_FALLBACK;
}
