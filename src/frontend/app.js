/*
 * FormCheck Analyzer
 *
 * This module implements the pose analysis logic for the FormCheck web app.
 * It leverages TensorFlow.js and the MoveNet pose detection model to
 * extract keypoints from a recorded video and compute simple squat metrics
 * such as repetition count, peak trunk lean angle, knee valgus percentage
 * and squat depth. The module exposes a single asynchronous function on
 * the global window object, `formcheckAnalyze()`, which is called by the
 * UI after a recording finishes. Because MoveNet is loaded via script tags
 * in `index.html`, the detector is created at runtime using the global
 * `poseDetection` namespace. All functions below are defined in the module
 * scope and do not pollute the global namespace except for the exported
 * entry points.
 */

console.log('✅ FormCheck analyzer loaded');

// Detector instance (lazy loaded on first use)
let detector = null;

/**
 * Initialize the TensorFlow.js backend and create a MoveNet detector.
 * The detector is cached in the `detector` variable to avoid repeated
 * initialization. MoveNet has two variants: Lightning (faster) and Thunder
 * (more accurate). Lightning is chosen for real-time performance, which
 * makes it ideal for a form coaching app that needs to run in the browser
 * without blocking the UI. According to the TensorFlow MoveNet
 * documentation, both variants detect 17 body keypoints and run faster
 * than real time on most modern devices:contentReference[oaicite:0]{index=0}.
 */
async function initDetector() {
  if (detector) return detector;
  // Ensure TensorFlow.js backend is ready (use WebGL for speed)
  if (typeof tf !== 'undefined') {
    try {
      await tf.setBackend('webgl');
      await tf.ready();
    } catch (e) {
      console.warn('Could not set TF backend to WebGL', e);
    }
  }
  if (typeof poseDetection === 'undefined') {
    throw new Error('poseDetection library not loaded');
  }
  // Create the MoveNet detector (Lightning variant).  We enable
  // smoothing to reduce jitter across frames.
  detector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    {
      modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
      enableSmoothing: true
    }
  );
  console.log('✅ MoveNet detector ready');
  return detector;
}

/**
 * Convert a Blob into a video element. This helper awaits metadata loading
 * before returning the element, ensuring correct duration and dimensions.
 *
 * @param {Blob} blob
 * @returns {Promise<{ video: HTMLVideoElement, url: string }>}
 */
async function blobToVideo(blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  // Wait for the metadata to be loaded to access duration/size
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('Failed to load recorded video'));
  });
  return { video, url };
}

/**
 * Seek a video element to a specific time (in seconds). Returns when the
 * seeked event fires.
 *
 * @param {HTMLVideoElement} video
 * @param {number} t
 */
function seek(video, t) {
  return new Promise((resolve) => {
    const handler = () => {
      video.removeEventListener('seeked', handler);
      resolve();
    };
    video.addEventListener('seeked', handler);
    video.currentTime = t;
  });
}

/**
 * Extract a time series of pose keypoints from a recorded video blob.
 * The video is sampled at a specified frames-per-second rate, and the
 * MoveNet detector is run on each sampled frame. Each entry in the
 * returned array contains the timestamp `t` (in seconds) and an array of
 * keypoints or `null` if detection failed. Sampling at 12 FPS provides a
 * good balance between computational cost and temporal resolution for
 * exercise analysis.
 *
 * @param {Blob} blob
 * @param {number} fps
 * @returns {Promise<{ duration: number, fps: number, series: Array<{ t: number, keypoints: any[] | null }> }>}
 */
async function extractPoseSeriesFromBlob(blob, fps = 12) {
  // Ensure the detector is ready
  const det = await initDetector();
  // Create offscreen video
  const { video, url } = await blobToVideo(blob);
  // Create canvas for drawing frames
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const dt = 1 / fps;
  const series = [];
  for (let t = 0; t < video.duration; t += dt) {
    await seek(video, t);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    let keypoints = null;
    try {
      // Estimate poses. MoveNet returns an array of poses; we only care
      // about the first (most confident) pose. We do not flip horizontally
      // because the camera preview is already mirrored in the UI.
      const poses = await det.estimatePoses(canvas, {
        maxPoses: 1,
        flipHorizontal: false
      });
      if (poses && poses[0] && poses[0].keypoints) {
        keypoints = poses[0].keypoints;
      }
    } catch (e) {
      console.error('Pose estimation error at t=', t, e);
    }
    series.push({ t, keypoints });
  }
  URL.revokeObjectURL(url);
  return { duration: video.duration, fps, series };
}

// Utility to average two numbers
const avg = (a, b) => (a + b) / 2;

/**
 * Compute basic squat metrics from a time series of pose keypoints.
 * The heuristics mirror those used previously with the MediaPipe Pose
 * Landmarker: we average left/right keypoints to derive center hips and
 * shoulders, calculate trunk lean, knee valgus and squat depth. We then
 * estimate repetition count by counting local maxima of hip height.
 *
 * @param {{ duration: number, fps: number, series: Array<{ t: number, keypoints: any[] | null }> }} poseData
 * @returns {object} metrics object or an error
 */
function computeSquatMetrics(poseData) {
  // Helper to get a keypoint by name; returns null if missing or low score
  function getKP(name, kps) {
    const kp = kps.find(k => k.name === name);
    if (!kp || kp.score == null || kp.score < 0.3) return null;
    return kp;
  }
  const samples = [];
  for (const s of poseData.series) {
    const kps = s.keypoints;
    if (!kps) continue;
    const lHip = getKP('left_hip', kps);
    const rHip = getKP('right_hip', kps);
    const lShoulder = getKP('left_shoulder', kps);
    const rShoulder = getKP('right_shoulder', kps);
    const lKnee = getKP('left_knee', kps);
    const rKnee = getKP('right_knee', kps);
    const lAnkle = getKP('left_ankle', kps);
    const rAnkle = getKP('right_ankle', kps);
    // Skip frame if any of the required keypoints is missing
    if (!(lHip && rHip && lShoulder && rShoulder && lKnee && rKnee && lAnkle && rAnkle)) continue;
    const hipY = avg(lHip.y, rHip.y);
    const hipX = avg(lHip.x, rHip.x);
    const shY = avg(lShoulder.y, rShoulder.y);
    const shX = avg(lShoulder.x, rShoulder.x);
    // trunk lean angle: difference between hip→shoulder vector and vertical
    const dx = hipX - shX;
    const dy = hipY - shY;
    const trunkLeanDeg = Math.abs(Math.atan2(dx, dy) * 180 / Math.PI);
    // knee valgus: knee inside ankle in x-axis (heuristic)
    const lValgus = lKnee.x < lAnkle.x;
    const rValgus = rKnee.x > rAnkle.x;
    // squat depth: vertical difference between hip and knee
    const kneeY = avg(lKnee.y, rKnee.y);
    const depthDelta = hipY - kneeY;
    samples.push({ t: s.t, hipY, trunkLeanDeg, lValgus, rValgus, depthDelta });
  }
  if (samples.length < 10) {
    return { error: 'Not enough pose detections' };
  }
  // Identify local maxima of hipY (since y increases downward) as bottoms of squat
  const bottoms = [];
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i].hipY > samples[i - 1].hipY && samples[i].hipY > samples[i + 1].hipY) {
      bottoms.push(i);
    }
  }
  const peakLean = Math.max(...samples.map(s => s.trunkLeanDeg));
  const valgusCount = samples.filter(s => s.lValgus || s.rValgus).length;
  const valgusPct = Math.round((valgusCount / samples.length) * 100);
  const bestDepth = Math.max(...samples.map(s => s.depthDelta));
  return {
    exercise: (window.appState?.exercise || 'squat'),
    duration_s: Number(poseData.duration.toFixed(2)),
    fps_processed: poseData.fps,
    frames_with_pose: samples.length,
    rep_count_est: bottoms.length,
    trunk_lean_peak_deg: Math.round(peakLean),
    valgus_pct_frames: valgusPct,
    best_depth_delta: Number(bestDepth.toFixed(3))
  };
}

/**
 * Analyze the last recording stored in `window.lastRecordingBlob` and return
 * squat metrics. This function is exposed on the global window to be
 * called by index.html. It ensures that the MoveNet model is initialized
 * before analysis and gracefully handles errors.
 *
 * @returns {Promise<object>}
 */
window.formcheckAnalyze = async function formcheckAnalyze() {
  if (!window.lastRecordingBlob) {
    return { error: 'No video recorded.' };
  }
  try {
    const poseData = await extractPoseSeriesFromBlob(window.lastRecordingBlob, 12);
    const metrics = computeSquatMetrics(poseData);
    return metrics;
  } catch (e) {
    console.error('Analysis failed:', e);
    return { error: String(e) };
  }
};

// Optional: expose function to analyze raw blob from console for debugging
window.analyzeLastRecording = window.formcheckAnalyze;