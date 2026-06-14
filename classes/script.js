const RELAY_URL = "wss://pin-heads-relay.onrender.com";
// LAN testing from a desktop browser: "ws://localhost:8080"

const FULL_SPIN_TILT = 80; // degrees of tilt at release = maximum spin (±1)

let token = localStorage.getItem("player_token");
if (!token) {
  token = crypto.randomUUID();
  localStorage.setItem("player_token", token);
}

let savedName = localStorage.getItem("player_name") || "";
let savedCode = "";
document.getElementById("name").value = savedName;

const sensors = new SensorManager();

const connection = new ConnectionManager(RELAY_URL, {
  onStatusChange: (text) => {
    document.getElementById("status").textContent = text;
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
  },
});

const game = new GameController(connection, sensors, { fullSpinTilt: FULL_SPIN_TILT });

connection.connect();

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
  if (typeof DeviceMotionEvent?.requestPermission === "function") {
    try { await DeviceMotionEvent.requestPermission(); } catch {}
  }
  try { await navigator.wakeLock?.request("screen"); } catch {}

  // Android: fullscreen + portrait lock (no-ops on iOS)
  try {
    await document.documentElement.requestFullscreen();
    await screen.orientation.lock("portrait");
  } catch {}

  sensors.start();
  connection.joinRoom();
};
