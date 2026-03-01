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