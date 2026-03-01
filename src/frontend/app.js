import { FilesetResolver, PoseLandmarker } from "./tasks-vision-bundle.js";

console.log("✅ app.js loaded");

let poseLandmarker = null;

async function initPose() {
  console.log("initPose() starting...");
  const vision = await FilesetResolver.forVisionTasks("/wasm");
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "/models/pose_landmarker_lite.task" },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  console.log("✅ PoseLandmarker ready");
}

window.initPose = initPose; // temporary: lets you call initPose() from DevTools console

// ---------- Blob -> offscreen video helpers ----------
async function blobToVideo(blob) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.src = url;
  v.muted = true;
  v.playsInline = true;

  await new Promise((resolve, reject) => {
    v.onloadedmetadata = resolve;
    v.onerror = () => reject(new Error("Failed to load recorded video"));
  });

  return { video: v, url };
}

async function seek(video, t) {
  return new Promise((resolve) => {
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
    video.currentTime = t;
  });
}

// ---------- Extract pose landmarks time series ----------
async function extractPoseSeriesFromBlob(blob, fps = 12) {
  if (!poseLandmarker) await initPose();

  const { video, url } = await blobToVideo(blob);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const dt = 1 / fps;
  const series = [];

  for (let t = 0; t < video.duration; t += dt) {
    await seek(video, t);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const tsMs = Math.round(t * 1000);
    const result = poseLandmarker.detectForVideo(canvas, tsMs);
    const lm = result?.landmarks?.[0] ?? null;

    series.push({ t, landmarks: lm });
  }

  URL.revokeObjectURL(url);
  return { duration: video.duration, fps, series };
}

// ---------- Squat metrics (V1) ----------
const L_SHOULDER = 11, R_SHOULDER = 12;
const L_HIP = 23, R_HIP = 24;
const L_KNEE = 25, R_KNEE = 26;
const L_ANKLE = 27, R_ANKLE = 28;
const avg = (a, b) => (a + b) / 2;

function computeSquatMetrics(poseData) {
  const samples = poseData.series
    .filter(s => s.landmarks)
    .map(s => {
      const lm = s.landmarks;

      const hipY = avg(lm[L_HIP].y, lm[R_HIP].y); // y increases downward
      const hipX = avg(lm[L_HIP].x, lm[R_HIP].x);
      const shX  = avg(lm[L_SHOULDER].x, lm[R_SHOULDER].x);
      const shY  = avg(lm[L_SHOULDER].y, lm[R_SHOULDER].y);

      // trunk lean = shoulder->hip vs vertical
      const dx = hipX - shX;
      const dy = hipY - shY;
      const trunkLeanDeg = Math.abs(Math.atan2(dx, dy) * (180 / Math.PI));

      // valgus proxy (front view heuristic)
      const lValgus = lm[L_KNEE].x < lm[L_ANKLE].x;
      const rValgus = lm[R_KNEE].x > lm[R_ANKLE].x;

      const kneeY = avg(lm[L_KNEE].y, lm[R_KNEE].y);
      const depthDelta = hipY - kneeY;

      return { t: s.t, hipY, trunkLeanDeg, lValgus, rValgus, depthDelta };
    });

  if (samples.length < 10) return { error: "Not enough pose detections" };

  // bottoms of squat = local maxima of hipY (since y increases downward)
  const bottoms = [];
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i].hipY > samples[i-1].hipY && samples[i].hipY > samples[i+1].hipY) {
      bottoms.push(i);
    }
  }

  const peakLean = Math.max(...samples.map(s => s.trunkLeanDeg));
  const valgusPct = Math.round(
    (samples.filter(s => s.lValgus || s.rValgus).length / samples.length) * 100
  );
  const bestDepth = Math.max(...samples.map(s => s.depthDelta));

  return {
    exercise: (window.appState?.exercise || "squat"),
    duration_s: Number(poseData.duration.toFixed(2)),
    fps_processed: poseData.fps,
    frames_with_pose: samples.length,
    rep_count_est: bottoms.length,
    trunk_lean_peak_deg: Math.round(peakLean),
    valgus_pct_frames: valgusPct,
    best_depth_delta: Number(bestDepth.toFixed(3))
  };
}

// ---------- Public entry: analyze last recording ----------
async function analyzeLastRecording() {
  if (!window.lastRecordingBlob) {
    console.warn("No lastRecordingBlob found.");
    return null;
  }
  const poseData = await extractPoseSeriesFromBlob(window.lastRecordingBlob, 12);
  const metrics = computeSquatMetrics(poseData);
  console.log("✅ SQUAT METRICS:", metrics);
  return metrics;
}

window.analyzeLastRecording = analyzeLastRecording;