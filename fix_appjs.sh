#!/bin/bash
# Run this from your project root: bash fix_appjs.sh

cat > src/frontend/app.js << 'APPJS'
import { FilesetResolver, PoseLandmarker } from "./wasm/vision_bundle.js";

console.log("✅ app.js loaded");

let poseLandmarker = null;

const VISION_WASM = "/wasm";
const MODEL_URL   = "/models/pose_landmarker_lite.task";

async function initPose() {
  console.log("initPose() starting...");
  const vision = await FilesetResolver.forVisionTasks(VISION_WASM);
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  console.log("✅ PoseLandmarker ready");
}

window.initPose = initPose;

async function blobToVideo(blob) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.crossOrigin = "anonymous";

  await new Promise((resolve, reject) => {
    v.onloadedmetadata = resolve;
    v.onerror = () => reject(new Error("Failed to load recorded video"));
    if (v.readyState >= 1) resolve();
  });

  return { video: v, url };
}

async function seek(video, t) {
  if (Math.abs(video.currentTime - t) < 0.001) return;
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    const handler = () => {
      clearTimeout(timeout);
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
    video.currentTime = t;
  });
}

async function extractPoseSeriesFromBlob(blob, fps = 10) {
  if (!poseLandmarker) await initPose();

  const { video, url } = await blobToVideo(blob);

  await new Promise((resolve) => {
    if (video.readyState >= 2) { resolve(); return; }
    video.oncanplay = resolve;
    video.load();
  });

  const duration = video.duration;
  console.log(`📹 Video duration: ${duration}s`);

  if (!duration || !isFinite(duration) || duration <= 0) {
    URL.revokeObjectURL(url);
    return { duration: 0, fps, series: [] };
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;
  console.log(`📐 Canvas: ${canvas.width}x${canvas.height}`);

  const dt = 1 / fps;
  const series = [];
  let timestampMs = 1;

  for (let t = dt; t < duration; t += dt) {
    await seek(video, t);

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, 10, 10);
    const isBlank = imageData.data.every((v, i) => i % 4 === 3 || v < 5);
    if (isBlank) {
      console.warn(`⚠️ Blank frame at t=${t.toFixed(2)}s, skipping`);
      timestampMs += Math.round(dt * 1000);
      continue;
    }

    let result = null;
    try {
      result = poseLandmarker.detectForVideo(canvas, timestampMs);
    } catch (e) {
      console.warn(`⚠️ detectForVideo failed at t=${t.toFixed(2)}s ts=${timestampMs}ms:`, e);
    }

    const lm = result?.landmarks?.[0] ?? null;
    console.log(lm ? `✅ Pose at t=${t.toFixed(2)}s` : `❌ No pose at t=${t.toFixed(2)}s`);

    series.push({ t, landmarks: lm, timestampMs });
    timestampMs += Math.round(dt * 1000);
  }

  URL.revokeObjectURL(url);

  const detected = series.filter(s => s.landmarks).length;
  console.log(`📊 Pose detection: ${detected}/${series.length} frames`);

  return { duration, fps, series };
}

const L_SHOULDER = 11, R_SHOULDER = 12;
const L_HIP = 23,      R_HIP = 24;
const L_KNEE = 25,     R_KNEE = 26;
const L_ANKLE = 27,    R_ANKLE = 28;
const avg = (a, b) => (a + b) / 2;

function computeSquatMetrics(poseData) {
  const samples = poseData.series
    .filter(s => s.landmarks)
    .map(s => {
      const lm = s.landmarks;
      const hipY = avg(lm[L_HIP].y, lm[R_HIP].y);
      const hipX = avg(lm[L_HIP].x, lm[R_HIP].x);
      const shX  = avg(lm[L_SHOULDER].x, lm[R_SHOULDER].x);
      const shY  = avg(lm[L_SHOULDER].y, lm[R_SHOULDER].y);
      const trunkLeanDeg = Math.abs(Math.atan2(hipX - shX, hipY - shY) * (180 / Math.PI));
      const lValgus = lm[L_KNEE].x < lm[L_ANKLE].x;
      const rValgus = lm[R_KNEE].x > lm[R_ANKLE].x;
      const kneeY = avg(lm[L_KNEE].y, lm[R_KNEE].y);
      const depthDelta = hipY - kneeY;
      return { t: s.t, hipY, trunkLeanDeg, lValgus, rValgus, depthDelta };
    });

  console.log(`📊 Samples with pose: ${samples.length}`);

  if (samples.length < 3) {
    return {
      error: `Not enough pose detections (got ${samples.length}). Try: stand further back so full body is visible, improve lighting, or record a longer clip.`
    };
  }

  const bottoms = [];
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i].hipY > samples[i-1].hipY && samples[i].hipY > samples[i+1].hipY)
      bottoms.push(i);
  }

  return {
    exercise: (window.appState?.exercise || "squat"),
    duration_s: Number(poseData.duration.toFixed(2)),
    fps_processed: poseData.fps,
    frames_with_pose: samples.length,
    rep_count_est: bottoms.length,
    trunk_lean_peak_deg: Math.round(Math.max(...samples.map(s => s.trunkLeanDeg))),
    valgus_pct_frames: Math.round(
      (samples.filter(s => s.lValgus || s.rValgus).length / samples.length) * 100
    ),
    best_depth_delta: Number(Math.max(...samples.map(s => s.depthDelta)).toFixed(3))
  };
}

async function analyzeLastRecording() {
  if (!window.lastRecordingBlob) { console.warn("No lastRecordingBlob found."); return null; }
  const poseData = await extractPoseSeriesFromBlob(window.lastRecordingBlob, 10);
  const metrics = computeSquatMetrics(poseData);
  console.log("✅ SQUAT METRICS:", metrics);
  return metrics;
}

window.formcheckAnalyze = async function () {
  if (!window.lastRecordingBlob) return { error: "No video recorded." };
  if (!poseLandmarker) await initPose();
  const poseData = await extractPoseSeriesFromBlob(window.lastRecordingBlob, 10);
  const metrics = computeSquatMetrics(poseData);
  console.log("✅ formcheckAnalyze metrics:", metrics);
  return metrics;
};

window.analyzeLastRecording = analyzeLastRecording;
console.log("✅ app.js: window.formcheckAnalyze is ready");
window.__appJsReady = true;
APPJS

echo "✅ src/frontend/app.js written successfully"
echo ""
echo "First line of file:"
head -1 src/frontend/app.js