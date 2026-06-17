const PROD_RELAY_URL = "wss://pin-heads-relay.onrender.com";
const RELAY_URL = getRelayUrl();

const FULL_SPIN_TILT = 80;
const PHOTO_KEY = "player_photo";

let token = localStorage.getItem("player_token");
if (!token) {
  token = createPlayerToken();
  localStorage.setItem("player_token", token);
}

let savedName = localStorage.getItem("player_name") || "";
let savedCode = "";
let savedPhoto = localStorage.getItem(PHOTO_KEY) || "";
let selfieStream = null;

document.getElementById("name").value = savedName;

const sensors = new SensorManager();
const statusEl = document.getElementById("status");
const sensorDebugEl = document.getElementById("sensor-debug");
const profileChip = document.getElementById("profile-chip");
const profileThumb = document.getElementById("profile-thumb");
const profileInitials = document.getElementById("profile-initials");

statusEl.textContent = `boot ${RELAY_URL}`;
renderSensorDebug("boot");
renderProfileChip();

window.addEventListener("error", (event) => {
  console.log("[window.error]", event.message, event.error);
  statusEl.textContent = `error ${event.message}`;
});

window.addEventListener("unhandledrejection", (event) => {
  console.log("[window.rejection]", event.reason);
  statusEl.textContent = `rejection ${String(event.reason)}`;
});

const connection = new ConnectionManager(RELAY_URL, {
  onStatusChange: (text) => {
    statusEl.textContent = text;
  },

  onMessage: (msg) => {
    if (msg.type === "joined") {
      connection.joined = true;
      document.body.classList.add("joined");
      connection.send({ type: "hello", token, name: savedName });
      sendProfile();
      game.show("wait");
      if (!savedPhoto) {
        statusEl.textContent = "joined - tap the profile circle to add a photo";
      }
    }
    if (msg.type === "error") {
      statusEl.textContent = "room not found";
      document.getElementById("name").disabled = false;
      document.getElementById("code").disabled = false;
    }
    if (msg.type === "data") game.handleGameMessage(msg.data);
  },

  onReset: () => {
    game.myTurn = false;
    game.gripped = false;
    sensors.gripped = false;
    game.holdMode = null;
    game._setMoveLocked(false);
    document.body.classList.remove("joined");
    stopSelfieStream();
  },
});

const game = new GameController(connection, sensors, { fullSpinTilt: FULL_SPIN_TILT });

connection.connect();

console.log("[relay]", RELAY_URL);

document.getElementById("btn-join").onclick = async () => {
  savedName = document.getElementById("name").value.trim() || "Player";
  savedCode = document.getElementById("code").value.trim().toUpperCase();
  localStorage.setItem("player_name", savedName);
  renderProfileChip();
  if (!savedCode) return;

  connection.savedCode = savedCode;
  statusEl.textContent = "joining...";

  document.activeElement?.blur();
  document.getElementById("name").disabled = true;
  document.getElementById("code").disabled = true;

  if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
    connection.joinRoom();
  }

  try {
    await initializePhoneCapabilities();
  } catch (error) {
    console.log("[join.init]", error);
  }
};

async function initializePhoneCapabilities() {
  // Joining the room should not depend on these optional capabilities.
  // They improve the controller once the player is already in.

  let motionPermission = "unavailable";
  if (typeof window.DeviceMotionEvent !== "undefined" &&
      typeof window.DeviceMotionEvent.requestPermission === "function") {
    try {
      motionPermission = await window.DeviceMotionEvent.requestPermission();
    } catch (error) {
      motionPermission = `error:${error?.message || error}`;
    }
  }
  let orientationPermission = "unavailable";
  if (typeof window.DeviceOrientationEvent !== "undefined" &&
      typeof window.DeviceOrientationEvent.requestPermission === "function") {
    try {
      orientationPermission = await window.DeviceOrientationEvent.requestPermission();
    } catch (error) {
      orientationPermission = `error:${error?.message || error}`;
    }
  }
  console.log("[sensor_permissions]", { motionPermission, orientationPermission });
  if (motionPermission === "denied" || orientationPermission === "denied") {
    statusEl.textContent = "sensor permission denied";
  }
  renderSensorDebug(`perm m=${motionPermission} o=${orientationPermission}`);

  sensors.start();
  sensors.recenterPose();
  try { await navigator.wakeLock?.request("screen"); } catch {}

  try {
    await document.documentElement.requestFullscreen();
    await screen.orientation.lock("portrait");
  } catch {}
}

profileChip.addEventListener("click", async () => {
  if (!connection.joined) return;
  await openSelfieScreen();
});

document.getElementById("btn-selfie-capture").addEventListener("click", () => {
  captureSelfie();
  stopSelfieStream();
  sendProfile();
  game.show("wait");
});

document.getElementById("btn-selfie-skip").addEventListener("click", () => {
  stopSelfieStream();
  game.show(connection.joined && game.myTurn ? "turn" : "wait");
});

async function openSelfieScreen() {
  game.show("selfie");
  const video = document.getElementById("selfie-video");
  try {
    stopSelfieStream();
    selfieStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 512, height: 512 },
      audio: false,
    });
    video.srcObject = selfieStream;
    await video.play();
  } catch (error) {
    console.log("[selfie]", error);
    statusEl.textContent = "camera unavailable";
  }
}

function captureSelfie() {
  const video = document.getElementById("selfie-video");
  const canvas = document.getElementById("selfie-canvas");
  const ctx = canvas.getContext("2d");
  const size = 256;
  const sourceWidth = video.videoWidth || size;
  const sourceHeight = video.videoHeight || size;
  const side = Math.min(sourceWidth, sourceHeight);
  const sx = (sourceWidth - side) / 2;
  const sy = (sourceHeight - side) / 2;

  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
  savedPhoto = canvas.toDataURL("image/jpeg", 0.72);
  localStorage.setItem(PHOTO_KEY, savedPhoto);
  renderProfileChip();
}

function stopSelfieStream() {
  if (!selfieStream) return;
  for (const track of selfieStream.getTracks()) track.stop();
  selfieStream = null;
  document.getElementById("selfie-video").srcObject = null;
}

function sendProfile() {
  if (!connection.joined) return;
  connection.send({
    type: "profile",
    token,
    name: savedName,
    photo: savedPhoto,
  });
}

function renderProfileChip() {
  profileInitials.textContent = initials(savedName || "Player");
  if (savedPhoto) {
    profileThumb.src = savedPhoto;
    profileChip.classList.add("has-photo");
  } else {
    profileThumb.removeAttribute("src");
    profileChip.classList.remove("has-photo");
  }
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const value = parts.map(part => part[0]).join("").slice(0, 2).toUpperCase();
  return value || "P";
}

function getRelayUrl() {
  const params = new URLSearchParams(window.location.search);
  const override = params.get("relay");
  if (override) return override;
  return PROD_RELAY_URL;
}

function createPlayerToken() {
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const randomPart = Math.random().toString(36).slice(2, 10);
  const timePart = Date.now().toString(36);
  return `player-${timePart}-${randomPart}`;
}

setInterval(() => {
  renderSensorDebug();
}, 500);

function renderSensorDebug(prefix = "") {
  const state = sensors.getDebugState();
  const pieces = [
    prefix,
    `secure=${window.isSecureContext}`,
    `motionApi=${typeof window.DeviceMotionEvent !== "undefined"}`,
    `orientApi=${typeof window.DeviceOrientationEvent !== "undefined"}`,
    `motionReq=${typeof window.DeviceMotionEvent?.requestPermission === "function"}`,
    `orientReq=${typeof window.DeviceOrientationEvent?.requestPermission === "function"}`,
    `started=${state.started}`,
    `oe=${state.orientationEvents}`,
    `me=${state.motionEvents}`,
    `usable=${state.hasUsableOrientation}`,
    `p=${Math.round(state.posePitch * 10) / 10}`,
    `r=${Math.round(state.poseRoll * 10) / 10}`,
    `y=${Math.round(state.poseYaw * 10) / 10}`,
    `zy=${Math.round(state.zeroPoseYaw * 10) / 10}`,
  ].filter(Boolean);

  sensorDebugEl.textContent = pieces.join(" | ");
}
