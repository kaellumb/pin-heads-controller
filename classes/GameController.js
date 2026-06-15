class GameController {
  constructor(connection, sensors, { fullSpinTilt = 80 } = {}) {
    this.connection = connection;
    this.sensors = sensors;
    this.fullSpinTilt = fullSpinTilt;

    this.myTurn = false;
    this.moveLocked = false;
    this.gripped = false;
    this.holdMode = null; // null, "aim", "rotate"

    this._grip = document.getElementById("grip");
    this._moveButton = document.getElementById("btn-move");
    this._rotateButton = document.getElementById("btn-rotate");

    this._bindSetupButtons();
    this._bindGrip();
    this._startStream();
  }

  show(name) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById("screen-" + name).classList.add("active");
  }

  handleGameMessage(d) {
    if (d.msg === "your_turn") {
      this.myTurn = true;
      this._setMoveLocked(false);
      this.show("turn");
      navigator.vibrate?.(200);
    }
    if (d.msg === "turn_over") {
      this.myTurn = false;
      this._setMoveLocked(false);
      this._setGripped(false);
      this.holdMode = null;
      this._resetGripUI();
      this._resetSetupUI();
      this.show("wait");
    }
    if (d.msg === "move_locked") {
      this._setMoveLocked(true);
    }
    if (d.msg === "move_unlocked") {
      this._setMoveLocked(false);
    }
  }

  _bindSetupButtons() {
    this._bindHoldButton(this._moveButton, "aim");
    this._bindHoldButton(this._rotateButton, "rotate");
  }

  _bindHoldButton(el, mode) {
    el.addEventListener("touchstart", (e) => {
      e.preventDefault();
      if (!this.myTurn || this.moveLocked || this.gripped) return;
      this.holdMode = mode;
      el.classList.add("held");
      navigator.vibrate?.(40);
    }, { passive: false });

    const end = (e) => {
      e.preventDefault();
      if (this.holdMode === mode) this.holdMode = null;
      el.classList.remove("held");
    };
    el.addEventListener("touchend", end, { passive: false });
    el.addEventListener("touchcancel", end, { passive: false });
  }

  _resetSetupUI() {
    this._moveButton.classList.remove("held");
    this._rotateButton.classList.remove("held");
  }


  _bindGrip() {
    const grip = this._grip;

    grip.addEventListener("touchstart", (e) => {
      e.preventDefault();
      if (!this.myTurn || this.moveLocked || this.gripped || this.holdMode) return;

      // grip-pose check: phone must be flat in palm, not held upright
      if (Math.abs(this.sensors.gravY) > 0.8) {
        grip.textContent = "LAY THE PHONE FLAT\nIN YOUR PALM!";
        navigator.vibrate?.([40, 40, 40]);
        setTimeout(() => this._resetGripUI(), 1200);
        return;
      }

      this._setGripped(true);
      this.sensors.zero();
      grip.classList.add("held");
      grip.textContent = "SWING!";
      navigator.vibrate?.(80);
      this.connection.send({ type: "grip" });
    }, { passive: false });

    // deliberate release = throw
    grip.addEventListener("touchend", (e) => {
      e.preventDefault();
      if (!this.gripped || this.moveLocked) return;
      this._setGripped(false);
      this._resetGripUI();

      // peak swing speed over the final 200ms
      let peak = 0;
      for (const s of this.sensors.velHistory) {
        if (Math.abs(s.v) > Math.abs(peak)) peak = s.v;
      }

      // spin: raw tilt at release, scaled to -1 … +1
      const spin = Math.max(-1, Math.min(1, this.sensors.tilt / this.fullSpinTilt));

      this.connection.send({
        type:  "throw",
        speed: Math.round(Math.abs(peak)),
        spin,
        angle: Math.round(this.sensors.swing * 10) / 10,
      });
      this.sensors.velHistory = [];
      navigator.vibrate?.([60, 40, 60]);
    }, { passive: false });

    // interrupted touch (slip / system gesture) = drop, no throw
    grip.addEventListener("touchcancel", (e) => {
      e.preventDefault();
      if (!this.gripped) return;
      this._setGripped(false);
      this._resetGripUI();
      this.sensors.velHistory = [];
      this.connection.send({ type: "grip_cancel" });
    }, { passive: false });
  }

  _resetGripUI() {
    this._grip.classList.remove("held");
    this._grip.textContent = "HOLD TO GRIP";
  }

  _setGripped(val) {
    this.gripped = val;
    this.sensors.gripped = val;
  }

  _setMoveLocked(val) {
    const wasGripped = this.gripped;

    this.moveLocked = val;
    document.body.classList.toggle("move-locked", val);

    if (val) {
      this.holdMode = null;

      // If we were mid-grip, cancel it explicitly so server/client state stays aligned.
      if (wasGripped && this.connection.joined && this.myTurn) {
        this.connection.send({ type: "grip_cancel" });
        this.sensors.velHistory = [];
      }

      this._setGripped(false);
      this._resetSetupUI();
      this._resetGripUI();
    }
  }

  // ---------- stream (25 Hz) ----------

  _startStream() {
    setInterval(() => {
      if (!this.connection.joined || !this.myTurn || this.moveLocked) return;
      if (this.holdMode) {
        this.connection.send({
          type: this.holdMode,
          tilt: Math.round(this.sensors.tilt * 10) / 10,
        });
      } else if (this.gripped) {
        this.connection.send({
          type:  "motion",
          tilt:  Math.round(this.sensors.tilt * 10) / 10,
          swing: Math.round(this.sensors.swing * 10) / 10,
        });
      }
    }, 40);
  }
}
