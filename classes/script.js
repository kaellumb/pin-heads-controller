const PROD_RELAY_URL = "wss://pin-heads-relay.onrender.com";
const RELAY_URL = getRelayUrl();

const FULL_SPIN_TILT = 80; // degrees of tilt at release = maximum spin (±1)

let token = localStorage.getItem("player_token");
if (!token) {
  token = createPlayerToken();
  localStorage.setItem("player_token", token);
}

let savedName = localStorage.getItem("player_name") || "";
let savedCode = "";
document.getElementById("name").value = savedName;

const sensors = new SensorManager();
const statusEl = document.getElementById("status");
const sensorDebugEl = document.getElementById("sensor-debug");

statusEl.textContent = `boot ${RELAY_URL}`;
renderSensorDebug("boot");

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
      connection.send({ type: "hello", token, name: savedName });
      game.show("wait");
    }
    if (msg.type === "error") {
      document.getElementById("status").textContent = "room not found";
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
  },
});

const game = new GameController(connection, sensors, { fullSpinTilt: FULL_SPIN_TILT });

connection.connect();

console.log("[relay]", RELAY_URL);

document.getElementById("btn-join").onclick = async () => {
  savedName = document.getElementById("name").value.trim() || "Player";
  savedCode = document.getElementById("code").value.trim().toUpperCase();
  localStorage.setItem("player_name", savedName);
  if (!savedCode) return;

  connection.savedCode = savedCode;

  // no active/editable inputs = no iOS shake-to-undo popup mid-swing
  document.activeElement?.blur();
  document.getElementById("name").disabled = true;
  document.getElementById("code").disabled = true;

  // iOS sensor permission must be requested inside a user gesture
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

  // Android: fullscreen + portrait lock (no-ops on iOS)
  try {
    await document.documentElement.requestFullscreen();
    await screen.orientation.lock("portrait");
  } catch {}

  connection.joinRoom();
};

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
