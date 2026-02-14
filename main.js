// main.js
import * as THREE from "three";
import { Hands } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";

const video = document.getElementById("video");
const canvas = document.getElementById("c");
const overlay = document.getElementById("overlay");
let score = 0;
const scoreEl = document.getElementById("score");
const updateScore = () => { if (scoreEl) scoreEl.textContent = String(score); };
updateScore();

// ---------- three.js scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);

const ctx2d = overlay.getContext("2d");

const scene = new THREE.Scene();
const cam3d = new THREE.PerspectiveCamera(55, 1, 0.01, 50);
cam3d.position.set(0, 0, 4.2);

function resize() {
  const dpr = Math.min(devicePixelRatio, 2);

  renderer.setPixelRatio(dpr);
  renderer.setSize(innerWidth, innerHeight, false);

  overlay.width = Math.floor(innerWidth * dpr);
  overlay.height = Math.floor(innerHeight * dpr);
  overlay.style.width = innerWidth + "px";
  overlay.style.height = innerHeight + "px";

  cam3d.aspect = innerWidth / innerHeight;
  cam3d.updateProjectionMatrix();
}

addEventListener("resize", resize);
resize();

// lights
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 0.95);
dir.position.set(2.2, 2.2, 2.2);
scene.add(dir);

// ---------- HeartShape Extrude ----------
function makeHeartShape() {
  const pts = [];
  const N = 260;
  const sx = 0.045;
  const sy = 0.045;

  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y =
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      1 * Math.cos(4 * t);

    // y 取反让凹口在上、尖在下（更直觉）
    pts.push(new THREE.Vector2(x * sx, -y * sy));
  }

  // 顶部凹口再压一点
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const nearTop = p.y > 0.35;
    const nearCenter = Math.abs(p.x) < 0.12;
    if (nearTop && nearCenter) p.y -= 0.03;
  }

  return new THREE.Shape(pts);
}

const heartShape = makeHeartShape();
const heartGeo = new THREE.ExtrudeGeometry(heartShape, {
  depth: 0.28,
  bevelEnabled: true,
  bevelThickness: 0.06,
  bevelSize: 0.05,
  bevelSegments: 8,
  curveSegments: 80
});
heartGeo.center();
// 这一行是“统一翻正”的开关：你现在倒的情况就需要它
heartGeo.rotateZ(Math.PI);

const baseMat = new THREE.MeshStandardMaterial({
  color: 0xff2f6d,
  metalness: 0.25,
  roughness: 0.22,
  emissive: 0x240010,
  emissiveIntensity: 0.35,
  transparent: true
});

// two main hearts (pink + red/purple)
const matL = baseMat.clone();
matL.color.setHex(0xff2f6d);
const matR = baseMat.clone();
matR.color.setHex(0xff5fd3);

const heartL = new THREE.Mesh(heartGeo, matL);
const heartR = new THREE.Mesh(heartGeo, matR);
scene.add(heartL, heartR);

// ---------- projection helpers ----------
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const tmpV3 = new THREE.Vector3();

function screenToWorld(xNorm, yNorm) {
  // video CSS 已镜像(scaleX(-1))，所以这里用 1-x 保持“右手=右边”
  const x = 1 - xNorm;
  const ndc = new THREE.Vector2(x * 2 - 1, -(yNorm * 2 - 1));
  raycaster.setFromCamera(ndc, cam3d);
  raycaster.ray.intersectPlane(plane, tmpV3);
  return tmpV3.clone();
}

const dist2D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- state (per heart) ----------
const HEART_MEDIUM_L = 0.55;
const HEART_MEDIUM_R = 0.55;

let targetScaleL = HEART_MEDIUM_L, smoothScaleL = HEART_MEDIUM_L;
let targetScaleR = HEART_MEDIUM_R, smoothScaleR = HEART_MEDIUM_R;

let targetPosL = new THREE.Vector3(-0.6, 0, 0), smoothPosL = targetPosL.clone();
let targetPosR = new THREE.Vector3(0.6, 0, 0),  smoothPosR = targetPosR.clone();

let prevHeartPosL = targetPosL.clone(), prevHeartPosR = targetPosR.clone();
let trailAccL = 0, trailAccR = 0;

let hideTimerL = 0, hideTimerR = 0;

// blow burst
let burstCooldown = 0;

// fusion burst (two hearts close)
let mergeCooldown = 0;
const MERGE_DISTANCE = 0.45;
const MERGE_HIDE_SECONDS = 1.0;

// ---------- Brush hearts (tail + burst) ----------
const brushGroup = new THREE.Group();
scene.add(brushGroup);

const MAX_BRUSH = 1400;
const brush = []; // {mesh, vel, life, ttl, baseScale}

function addBrushHeart(pos, velOverride = null, colorHex = 0xff2f6d, sizeMul = 1.0) {
  if (brush.length >= MAX_BRUSH) return;

  const m = new THREE.Mesh(heartGeo, baseMat.clone());
  m.material.color.setHex(colorHex);
  m.position.copy(pos);

const base = 0.26 + Math.random() * 0.12;
  const s = base * sizeMul;                   // 关键：乘动态倍率
  m.scale.setScalar(s);

  m.rotation.set(
    (Math.random() - 0.5) * 0.4,
    (Math.random() - 0.5) * 0.6,
    (Math.random() - 0.5) * 0.6
  );

  const vel = velOverride
    ? velOverride.clone()
    : new THREE.Vector3(
        (Math.random() - 0.5) * 0.02,
        0.03 + Math.random() * 0.05,
        (Math.random() - 0.5) * 0.015
      );

  const ttl = 0.55 + Math.random() * 0.45;
  brushGroup.add(m);
  brush.push({ mesh: m, vel, life: 0, ttl, baseScale: s });
}

function updateBrush(dt) {
  for (let i = brush.length - 1; i >= 0; i--) {
    const b = brush[i];
    b.life += dt;
    const t = Math.min(1, b.life / b.ttl);

    b.mesh.position.addScaledVector(b.vel, dt);
    b.mesh.rotation.x += dt * 0.6;
    b.mesh.rotation.y += dt * 0.8;

    const s = b.baseScale * (1 - 0.55 * t);
    b.mesh.scale.setScalar(Math.max(0.001, s));
    b.mesh.material.opacity = 1 - t;

    if (t >= 1) {
      brushGroup.remove(b.mesh);
      b.mesh.material.dispose();
      brush.splice(i, 1);
    }
  }
}

// tail generator
function spawnTrailForHeart(heartMesh, prevPos, setAcc, accValue, colorHex) {
  const move = heartMesh.position.clone().sub(prevPos);
  const moved = move.length();
  const spacing = 0.11; // bigger = less sensitive
  accValue += moved;

  if (moved > 1e-6) {
    const dir = move.clone().normalize();
    while (accValue > spacing) {
      accValue -= spacing;
      const spawnPos = heartMesh.position.clone().add(dir.clone().multiplyScalar(-0.14));
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 0.02,
        0.02 + Math.random() * 0.04,
        (Math.random() - 0.5) * 0.015
      ).add(dir.clone().multiplyScalar(-0.10));
      addBrushHeart(spawnPos, vel, colorHex);
    }
  }

  prevPos.copy(heartMesh.position);
  setAcc(accValue);
}

// ---------- Targets (optional fun background; remove if you don't want) ----------
const targetGroup = new THREE.Group();
scene.add(targetGroup);

const targets = []; // { mesh, vel }
const MAX_TARGETS = 18;

function spawnTarget() {
  if (targets.length >= MAX_TARGETS) return;

  const m = new THREE.Mesh(heartGeo, baseMat.clone());
  m.material.color.setHex(Math.random() < 0.5 ? 0xffc0d9 : 0xd6c7ff);

  const s = 0.08 + Math.random() * 0.05;
  m.scale.setScalar(s);

  const x = (Math.random() * 2 - 1) * 1.45;
  const y = (Math.random() * 2 - 1) * 0.95;
  m.position.set(x, y, 0);

  m.rotation.set(0.25, 0, 0);

  const vel = new THREE.Vector3(
    (Math.random() - 0.5) * 0.16,
    (Math.random() - 0.5) * 0.12,
    0
  );

  targetGroup.add(m);
  targets.push({ mesh: m, vel });
}

function updateTargets(dt) {
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    t.mesh.position.addScaledVector(t.vel, dt);

    if (t.mesh.position.x > 1.55 || t.mesh.position.x < -1.55) t.vel.x *= -1;
    if (t.mesh.position.y > 0.95 || t.mesh.position.y < -0.95) t.vel.y *= -1;

    t.mesh.rotation.y += dt * 0.6;
  }
}

// ---------- MediaPipe Hands ----------
const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});
hands.setOptions({
  maxNumHands: 2,
  modelComplexity: 1,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6
});

let lastHands = null;
function drawHandOverlay() {
  const dpr = Math.min(devicePixelRatio, 2);

  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.clearRect(0, 0, overlay.width, overlay.height);

  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!lastHands?.multiHandLandmarks?.length) return;

  const w = innerWidth;
  const h = innerHeight;

  ctx2d.save();
  ctx2d.globalCompositeOperation = "source-over";
  ctx2d.lineWidth = 3;
  ctx2d.strokeStyle = "rgba(0,255,180,0.95)";
  ctx2d.fillStyle = "rgba(0,255,180,0.95)";

  // 你的 video 是镜像的，所以骨架也镜像，才能和心形/画面一致
  const mx = (x) => (1 - x) * w;
  const my = (y) => y * h;

  const drawLine = (a, b) => {
    ctx2d.beginPath();
    ctx2d.moveTo(mx(a.x), my(a.y));
    ctx2d.lineTo(mx(b.x), my(b.y));
    ctx2d.stroke();
  };

  const drawDot = (p) => {
    ctx2d.beginPath();
    ctx2d.arc(mx(p.x), my(p.y), 3.2, 0, Math.PI * 2);
    ctx2d.fill();
  };

  const fingers = [
    [0, 1, 2, 3, 4],      // thumb
    [0, 5, 6, 7, 8],      // index
    [0, 9, 10, 11, 12],   // middle
    [0, 13, 14, 15, 16],  // ring
    [0, 17, 18, 19, 20]   // pinky
  ];

  for (const lm of lastHands.multiHandLandmarks) {
    // dots
    for (let i = 0; i < lm.length; i++) drawDot(lm[i]);

    // palm connections
    drawLine(lm[0], lm[5]);
    drawLine(lm[0], lm[9]);
    drawLine(lm[0], lm[13]);
    drawLine(lm[0], lm[17]);
    drawLine(lm[5], lm[9]);
    drawLine(lm[9], lm[13]);
    drawLine(lm[13], lm[17]);

    // finger bones
    for (const f of fingers) {
      for (let i = 0; i < f.length - 1; i++) drawLine(lm[f[i]], lm[f[i + 1]]);
    }
  }

  ctx2d.restore();
}

hands.onResults((results) => {
  lastHands = results;
  const lms = results.multiHandLandmarks || [];
  const handed = results.multiHandedness || [];

  if (lms.length === 0) {
    targetScaleL = HEART_MEDIUM_L;
    targetScaleR = HEART_MEDIUM_R;
    return;
  }

  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i];
    const label = handed[i]?.label || "Right"; // Left / Right

    const thumbTip = lm[4];
    const indexTip = lm[8];

    const d = dist2D(thumbTip, indexTip);
    const dNorm = clamp((d - 0.02) / (0.18 - 0.02), 0, 1);

    const p0 = lm[0], p5 = lm[5], p9 = lm[9], p13 = lm[13], p17 = lm[17];
    const cx = (p0.x + p5.x + p9.x + p13.x + p17.x) / 5;
    const cy = (p0.y + p5.y + p9.y + p13.y + p17.y) / 5;
    const worldPos = screenToWorld(cx, cy);

    const scale = lerp(0.18, 1.35, dNorm);

    if (label === "Left") {
      targetPosL.copy(worldPos);
      targetScaleL = scale;
    } else {
      targetPosR.copy(worldPos);
      targetScaleR = scale;
    }
  }
});

// ---------- Mic blow detection ----------
let audioLevel = 0;

async function initMic() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);

  function loop() {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    audioLevel = Math.sqrt(sum / data.length);
    requestAnimationFrame(loop);
  }
  loop();
}
initMic();

// ---------- webcam init ----------
async function initCam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: false
  });
  video.srcObject = stream;
  await video.play();

  const cam = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
    width: 640,
    height: 480
  });
  cam.start();
}
initCam();

// ---------- bursts ----------
function burstAt(pos, colorHex, count = 160, sizeMul = 1.0) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const up = 0.2 + Math.random() * 0.7;

    const vel = new THREE.Vector3(
      Math.cos(a) * (0.65 + Math.random() * 1.25),
      up + (Math.random() * 0.45),
      Math.sin(a) * (0.65 + Math.random() * 1.25)
    ).multiplyScalar(1.35);

    addBrushHeart(pos.clone(), vel, colorHex, sizeMul);
  }
}

// ---------- render loop ----------
let lastT = performance.now();

function tick(t) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.033, (t - lastT) / 1000);
  lastT = t;

  burstCooldown = Math.max(0, burstCooldown - dt);
  mergeCooldown = Math.max(0, mergeCooldown - dt);

  hideTimerL = Math.max(0, hideTimerL - dt);
  hideTimerR = Math.max(0, hideTimerR - dt);

  heartL.visible = hideTimerL <= 0;
  heartR.visible = hideTimerR <= 0;

  // smooth follow
  smoothPosL.lerp(targetPosL, 0.18);
  smoothPosR.lerp(targetPosR, 0.18);
  heartL.position.copy(smoothPosL);
  heartR.position.copy(smoothPosR);

  // smooth scale
  smoothScaleL = lerp(smoothScaleL, targetScaleL, 0.18);
  smoothScaleR = lerp(smoothScaleR, targetScaleR, 0.18);
  heartL.scale.setScalar(smoothScaleL);
  heartR.scale.setScalar(smoothScaleR);

  // fixed pose
  heartL.rotation.set(0.25, 0, 0);
  heartR.rotation.set(0.25, 0, 0);

  // tails (only when visible)
  if (heartL.visible) {
    spawnTrailForHeart(heartL, prevHeartPosL, (v) => (trailAccL = v), trailAccL, 0xff2f6d);
  } else {
    prevHeartPosL.copy(heartL.position);
    trailAccL = 0;
  }
  if (heartR.visible) {
    spawnTrailForHeart(heartR, prevHeartPosR, (v) => (trailAccR = v), trailAccR, 0xff5fd3);
  } else {
    prevHeartPosR.copy(heartR.position);
    trailAccR = 0;
  }

  // optional targets
  if (Math.random() < dt * 1.6) spawnTarget();
  updateTargets(dt);

  // blow -> burst (both hearts) + hide longer
  const blowThreshold = 0.06;
  if (audioLevel > blowThreshold && burstCooldown <= 0) {
    burstCooldown = 0.7;

  const sizeMulL = clamp(smoothScaleL / HEART_MEDIUM_L, 0.7, 2.6);
  const sizeMulR = clamp(smoothScaleR / HEART_MEDIUM_R, 0.7, 2.6);

  burstAt(heartL.position, 0xff2f6d, 320, sizeMulL);
  burstAt(heartR.position, 0xff5fd3, 320, sizeMulR);

    hideTimerL = 2.0;
    hideTimerR = 2.0;

    targetScaleL = HEART_MEDIUM_L * 0.65;
    targetScaleR = HEART_MEDIUM_R * 0.65;
  }

  // fusion: when two hearts close -> one big burst at mid + hide both for 2s -> respawn
  const bothVisible = (hideTimerL <= 0) && (hideTimerR <= 0);
  if (bothVisible && mergeCooldown <= 0) {
  const d = heartL.position.distanceTo(heartR.position);
  if (d < MERGE_DISTANCE) {
    const mid = heartL.position.clone().add(heartR.position).multiplyScalar(0.5);

    // 用两颗主心当前大小做合体爆炸的动态倍率
    const sizeMulFusion = clamp(
      ((smoothScaleL / HEART_MEDIUM_L) + (smoothScaleR / HEART_MEDIUM_R)) * 0.5,
      0.8,
      3.6
    );

    burstAt(mid, 0xff2f6d, 320, sizeMulFusion);
    burstAt(mid, 0xff5fd3, 320, sizeMulFusion);

    hideTimerL = MERGE_HIDE_SECONDS;
    hideTimerR = MERGE_HIDE_SECONDS;

      score += 10;
      updateScore();

    mergeCooldown = MERGE_HIDE_SECONDS + 0.35;
  }
}
  updateBrush(dt);
  renderer.render(scene, cam3d);
  drawHandOverlay();
}

requestAnimationFrame(tick);
