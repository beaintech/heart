import * as THREE from "three";
import { Hands } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";

const video = document.getElementById("video");
const canvas = document.getElementById("c");

// ---------- three.js scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0); // 透明背景

const scene = new THREE.Scene();
const cam3d = new THREE.PerspectiveCamera(55, 1, 0.01, 50);
cam3d.position.set(0, 0, 3.2);

const resize = () => {
  renderer.setSize(innerWidth, innerHeight, false);
  cam3d.aspect = innerWidth / innerHeight;
  cam3d.updateProjectionMatrix();
};
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
  const N = 240;

  // 经典心形曲线（数学公式），再缩放到 three.js 里好用的尺寸
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;

    const x = 16 * Math.pow(Math.sin(t), 3);
    const y =
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      1 * Math.cos(4 * t);

    // 缩放 + 轻微拉高，让顶部凹口更像你要的那种
    const sx = 0.045;      // 宽度缩放
    const sy = 0.045;      // 高度缩放
    pts.push(new THREE.Vector2(x * sx, y * sy));
  }

  const shape = new THREE.Shape(pts);
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
  depth: 0.35,
  bevelEnabled: true,
  bevelThickness: 0.08,
  bevelSize: 0.06,
  bevelSegments: 6,
  curveSegments: 40
});
heartGeo.center();
heartGeo.rotateZ(Math.PI); 

const heartMat = new THREE.MeshStandardMaterial({
  color: 0xff2f6d,
  metalness: 0.25,
  roughness: 0.22,
  emissive: 0x240010,
  emissiveIntensity: 0.35,
  transparent: true // 给 brush hearts 做淡出
});

// main heart
const heart = new THREE.Mesh(heartGeo, heartMat.clone());
scene.add(heart);

// ---------- Brush hearts ----------
const brushGroup = new THREE.Group();
scene.add(brushGroup);

const MAX_BRUSH = 1400;
const brush = []; // {mesh, vel:Vector3, life, ttl, baseScale}

function addBrushHeart(pos, velOverride = null) {
  if (brush.length >= MAX_BRUSH) return;

  const m = new THREE.Mesh(heartGeo, heartMat.clone());
  m.position.copy(pos);

  const s = 0.07 + Math.random() * 0.06;
  m.scale.setScalar(s);

  m.rotation.set(
    (Math.random() - 0.5) * 0.6,
    (Math.random() - 0.5) * 0.9,
    (Math.random() - 0.5) * 0.9
  );
  m.rotation.z += Math.PI;

  const vel = velOverride
  ? velOverride.clone()
  : new THREE.Vector3(
      (Math.random() - 0.5) * 0.02,
      0.03 + Math.random() * 0.05,
      (Math.random() - 0.5) * 0.015
    );

  // 生命周期
    const ttl = 1.5 + Math.random() * 2.5;
  const item = { mesh: m, vel, life: 0, ttl, baseScale: s };

  brushGroup.add(m);
  brush.push(item);
}

function updateBrush(dt) {
  // 从后往前删，省事
  for (let i = brush.length - 1; i >= 0; i--) {
    const b = brush[i];
    b.life += dt;

    const t = Math.min(1, b.life / b.ttl);

    // 漂浮
    b.mesh.position.addScaledVector(b.vel, dt);

    // 轻微自转
    b.mesh.rotation.x += dt * 0.8;
    b.mesh.rotation.y += dt * 1.1;

    // 缩小 + 淡出
    const s = b.baseScale * (1 - 0.55 * t);
    b.mesh.scale.setScalar(Math.max(0.001, s));

    b.mesh.material.opacity = 1 - (t * t);

    // 到期清理
    if (t >= 1) {
      brushGroup.remove(b.mesh);
      b.mesh.geometry.dispose(); // geometry 共享也可以不 dispose，这里用同一个 heartGeo，会重复 dispose
      // 所以上面这一行要删掉，避免把共享 geometry 释放掉
      // 正确做法：只 dispose material
      b.mesh.material.dispose();
      brush.splice(i, 1);
    }
  }
}

// 注意：heartGeo 是共享的，不要在每个 brush heart 删除时 dispose geometry
// 所以上面 updateBrush 里那行 b.mesh.geometry.dispose() 必须确保没执行
// 我在下面直接覆盖 updateBrush 中的那行逻辑：不 dispose geometry（已在上面注释）
function safeUpdateBrush(dt) {
  for (let i = brush.length - 1; i >= 0; i--) {
    const b = brush[i];
    b.life += dt;
    const t = Math.min(1, b.life / b.ttl);

    b.mesh.position.addScaledVector(b.vel, dt);
    b.mesh.rotation.x += dt * 0.8;
    b.mesh.rotation.y += dt * 1.1;

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

// ---------- 2D -> 3D projection ----------
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z=0 plane
const tmpV3 = new THREE.Vector3();

function screenToWorld(xNorm, yNorm) {
  const x = 1 - xNorm; // 修正镜像：右边->右边
  const ndc = new THREE.Vector2(x * 2 - 1, -(yNorm * 2 - 1));
  raycaster.setFromCamera(ndc, cam3d);
  raycaster.ray.intersectPlane(plane, tmpV3);
  return tmpV3.clone();
}

// ---------- gesture helpers ----------
const dist2D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- state ----------
let pinch = false;
const HEART_MEDIUM = 0.35;
let lastDrawPos = null;
let smoothedDrawPos = null;
let drawCooldown = 0; // seconds
let targetPos = new THREE.Vector3(0, 0, 0);
let smoothPos = new THREE.Vector3(0, 0, 0);

let prevHeartPos = new THREE.Vector3(0, 0, 0);
let trailAccumulator = 0;
let burstCooldown = 0;
let heartHideTimer = 0;
let targetScale = HEART_MEDIUM;
let smoothScale = HEART_MEDIUM;


// ---------- MediaPipe Hands ----------
const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});
hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6
});

hands.onResults((results) => {
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    pinch = false;
    lastDrawPos = null;
    return;
  }

  const lm = results.multiHandLandmarks[0];
  const thumbTip = lm[4];
  const indexTip = lm[8];

  const p0 = lm[0];
    const p5 = lm[5];
    const p9 = lm[9];
    const p13 = lm[13];
    const p17 = lm[17];

    const cx = (p0.x + p5.x + p9.x + p13.x + p17.x) / 5;
    const cy = (p0.y + p5.y + p9.y + p13.y + p17.y) / 5;

    targetPos = screenToWorld(cx, cy);

  const d = dist2D(thumbTip, indexTip);
  pinch = d < 0.045;

  // pinch distance -> main heart scale
  const dNorm = clamp((d - 0.02) / (0.12 - 0.02), 0, 1);
  targetScale = lerp(0.1, 0.5, dNorm);

  // draw brush hearts when not pinching
  if (!pinch) {
    const p = screenToWorld(indexTip.x, indexTip.y);
    if (!smoothedDrawPos) smoothedDrawPos = p.clone();
    smoothedDrawPos.lerp(p, 0.22); // 越小越慢：0.15 更钝，0.3 更跟手

    if (lastDrawPos) {
      const step = 0.075; // 越小越密
      const delta = p.clone().sub(lastDrawPos);
      const len = delta.length();
      const n = Math.min(45, Math.floor(len / step));

    //   for (let i = 0; i < n; i++) {
    //     const t = (i + 1) / (n + 1);
    //     const q = lastDrawPos.clone().add(delta.clone().multiplyScalar(t));
    //     addBrushHeart(q);
    //   }
    } else {
      addBrushHeart(p);
    }

    lastDrawPos = p;
    drawCooldown = 0.05; // 50ms 一次，想更慢就 0.08 / 0.12
  } else {
    lastDrawPos = null;
    smoothedDrawPos = null;
  }
});

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
    // RMS 音量
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    audioLevel = rms; // 典型 0.01~0.08，吹气会更高
    requestAnimationFrame(loop);
  }
  loop();
}
initMic();


// webcam init
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

// ---------- render loop ----------
let lastT = performance.now();

function tick(t) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.033, (t - lastT) / 1000);
  lastT = t;

  smoothScale = lerp(smoothScale, targetScale, 0.18);
  heart.scale.setScalar(smoothScale);

  heart.rotation.x = 0.25;  
  heart.rotation.z = Math.PI;
  heart.rotation.y += 0.9 * dt;

  drawCooldown = Math.max(0, drawCooldown - dt);
smoothPos.lerp(targetPos, 0.18); // 越小越“顿”，0.12 更慢，0.25 更跟手
heart.position.copy(smoothPos);

// 尾迹：跟着大心形走（按位移距离生成，避免太敏感）
const move = heart.position.clone().sub(prevHeartPos);
const speed = move.length() / Math.max(dt, 1e-6);

// 每移动一定距离生成一个小心形
const spacing = 0.09; // 越大越稀疏
trailAccumulator += move.length();

heartHideTimer = Math.max(0, heartHideTimer - dt);
heart.visible = heartHideTimer <= 0;


while (trailAccumulator > spacing) {
  trailAccumulator -= spacing;

  // 在大心形后方一点点生成（沿着运动反方向）
  const dir = move.length() > 1e-6 ? move.clone().normalize() : new THREE.Vector3(0, 1, 0);
  const spawnPos = heart.position.clone().add(dir.multiplyScalar(-0.12));

  // 尾迹速度：轻微向后 + 轻微上飘
  const vel = new THREE.Vector3(
    (Math.random() - 0.5) * 0.02,
    0.02 + Math.random() * 0.04,
    (Math.random() - 0.5) * 0.015
  ).add(dir.multiplyScalar(-0.06 - Math.min(0.12, speed * 0.01)));

  addBrushHeart(spawnPos, vel);

  burstCooldown = Math.max(0, burstCooldown - dt);

// 吹气阈值：你可以调 0.055 / 0.07
const blowThreshold = 0.06;

if (audioLevel > blowThreshold && burstCooldown <= 0) {
  burstCooldown = 0.7; // 防连发

  // 吹散时：主心形短暂消失 + 回来变小
  heartHideTimer = 2;        // 消失 180ms，你想更久就 0.25/0.35
  targetScale = HEART_MEDIUM * 0.45; // 回来小一点（0.65 可调 0.5~0.8）

  // 在大心形当前位置爆炸出很多小心形
  const count = 140; // 越大越炸
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const up = (Math.random() - 0.2) * 0.6;

    const vel = new THREE.Vector3(
      Math.cos(angle) * (0.25 + Math.random() * 0.55),
      up + (0.15 + Math.random() * 0.45),
      Math.sin(angle) * (0.25 + Math.random() * 0.55)
    );

    // 让爆炸更“散”：速度乘一个系数
    vel.multiplyScalar(0.9);

    addBrushHeart(heart.position.clone(), vel);
  }
}

}

prevHeartPos.copy(heart.position);

  safeUpdateBrush(dt);

  renderer.render(scene, cam3d);
}

requestAnimationFrame(tick);
