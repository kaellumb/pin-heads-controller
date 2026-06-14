class SensorManager {
  constructor() {
    // sensor readings
    this.tilt = 0;       // raw phone tilt (deviceorientation gamma)
    this.swing = 0;      // accumulated swing angle (deg) — zeroed at grip
    this.velocity = 0;   // angular velocity (deg/s) about the swing axis
    this.velHistory = []; // recent { t, v } samples used for release maths
    this.gravY = 0;      // gravity along the long axis (grip-pose check)
    this.gripped = false; // set externally by GameController

    // low-passed gravity vector
    this._gx = 0; this._gy = 0; this._gz = 9.8;
    // previous gravity unit vector (for swing delta)
    this._px = 0; this._py = 0; this._pz = 1;
    this._lastTime = 0;
  }

  start() {
    // raw tilt — no processing
    window.addEventListener("deviceorientation", (e) => {
      this.tilt = e.gamma ?? 0;
    });

    window.addEventListener("devicemotion", (e) => {
      const g = e.accelerationIncludingGravity;
      if (!g) return;

      const k = 0.3;
      this._gx += k * ((g.x ?? 0) - this._gx);
      this._gy += k * ((g.y ?? 0) - this._gy);
      this._gz += k * ((g.z ?? 0) - this._gz);

      const len = Math.hypot(this._gx, this._gy, this._gz) || 1;
      const nx = this._gx / len, ny = this._gy / len, nz = this._gz / len;
      this.gravY = ny;

      if (this.gripped) {
        // swing angle: signed gravity rotation about the x axis since last frame
        const crossX = this._py * nz - this._pz * ny;
        const dot = this._px * nx + this._py * ny + this._pz * nz;
        const delta = Math.atan2(crossX, dot) * 180 / Math.PI;
        this.swing += delta;

        const now = performance.now();
        const dt = (now - this._lastTime) / 1000;
        this._lastTime = now;

        // speed: straight off the gyro, fallback to gravity diff
        const gyro = e.rotationRate;
        if (gyro && gyro.beta != null) {
          this.velocity = gyro.beta;
        } else if (dt > 0) {
          this.velocity = this.velocity * 0.7 + (delta / dt) * 0.3;
        }

        this.velHistory.push({ t: now, v: this.velocity });
        while (this.velHistory.length && now - this.velHistory[0].t > 200) {
          this.velHistory.shift();
        }
      }

      this._px = nx; this._py = ny; this._pz = nz;
    });
  }

  // call at grip — zeros swing and velocity for this throw
  zero() {
    this.swing = 0;
    this.velocity = 0;
    this.velHistory = [];
    this._lastTime = performance.now();
  }
}
