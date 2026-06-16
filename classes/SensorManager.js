class SensorManager {
  constructor() {
    this.tilt = 0;
    this.swing = 0;
    this.velocity = 0;
    this.velHistory = [];
    this.gravY = 0;
    this.posePitch = 0;
    this.poseRoll = 0;
    this.poseYaw = 0;
    this.gripped = false;

    this._gravity = { x: 0, y: 0, z: 9.8 };
    this._gyroBias = { alpha: 0, beta: 0, gamma: 0 };
    this._gyroSamples = [];
    this._rawPosePitch = 0;
    this._rawPoseRoll = 0;
    this._rawPoseYaw = 0;
    this._poseZeroPitch = 0;
    this._poseZeroRoll = 0;
    this._poseZeroYaw = 0;
    this._swingAxis = "beta";
    this._tiltSign = -1;
    this._lastMotionTime = 0;
    this._lastOrientationLogTime = 0;
    this._lastSensorLogTime = 0;
    this._hasGravity = false;
    this._hasUsableOrientation = false;
    this._lastOrientationSample = null;
    this._orientationEvents = 0;
    this._motionEvents = 0;
    this._lastRawOrientation = null;
    this._lastRawRotationRate = null;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;

    window.addEventListener("devicemotion", (e) => this._handleDeviceMotion(e), { passive: true });
    window.addEventListener("deviceorientation", (e) => this._handleDeviceOrientation(e), { passive: true });
  }

  zero() {
    this.swing = 0;
    this.velocity = 0;
    this.velHistory = [];
    this._lastMotionTime = performance.now();
    this._gyroSamples = [];
    this._gyroBias = { alpha: 0, beta: 0, gamma: 0 };
    this._swingAxis = "beta";
  }

  recenterPose() {
    this._poseZeroPitch = this._rawPosePitch;
    this._poseZeroRoll = this._rawPoseRoll;
    this._poseZeroYaw = this._rawPoseYaw;
    this._applyPoseOffsets();
  }

  _handleDeviceOrientation(e) {
    this._orientationEvents += 1;
    const hasAlpha = Number.isFinite(e.alpha);
    const hasBeta = Number.isFinite(e.beta);
    const hasGamma = Number.isFinite(e.gamma);
    const nextPitch = hasBeta ? this._normalizeAngle(e.beta) : null;
    const nextRoll = hasGamma ? this._normalizeAngle(e.gamma) : null;
    const nextYaw = hasAlpha ? this._normalizeAngle(e.alpha) : null;
    this._lastRawOrientation = {
      alpha: hasAlpha ? e.alpha : null,
      beta: hasBeta ? e.beta : null,
      gamma: hasGamma ? e.gamma : null,
      absolute: e.absolute ?? null,
    };

    if (!this._hasGravity && hasGamma) {
      this.tilt = this._normalizeAngle(e.gamma);
    }

    if (hasAlpha || hasBeta || hasGamma) {
      const changed = this._orientationSampleChanged(nextPitch, nextRoll, nextYaw);
      const magnitude = Math.abs(nextPitch ?? 0) + Math.abs(nextRoll ?? 0) + Math.abs(nextYaw ?? 0);
      if (changed || magnitude > 0.5) {
        this._hasUsableOrientation = true;
        this._rawPosePitch = nextPitch ?? this._rawPosePitch;
        this._rawPoseRoll = nextRoll ?? this._rawPoseRoll;
        this._rawPoseYaw = nextYaw ?? this._rawPoseYaw;
        this._applyPoseOffsets();
      }
      this._lastOrientationSample = { pitch: nextPitch, roll: nextRoll, yaw: nextYaw };
    }

    this._logOrientationDebug(e);
  }

  _handleDeviceMotion(e) {
    this._motionEvents += 1;
    this._updateGravity(e.accelerationIncludingGravity);
    this._updateTiltFromGravity();

    const now = performance.now();
    const dt = this._lastMotionTime ? (now - this._lastMotionTime) / 1000 : 0;
    this._lastMotionTime = now;

    const rate = this._normalizeRotationRate(e.rotationRate);
    this._lastRawRotationRate = rate;
    this._updatePoseFromGyro(rate, dt);
    this._logSensorDebug(rate);
    if (!rate) return;

    if (this.gripped) {
      this._sampleGyroBias(rate);
      const corrected = this._getCorrectedRate(rate);
      const axisRate = corrected[this._swingAxis];
      const filteredRate = this.velocity * 0.35 + axisRate * 0.65;

      this.velocity = filteredRate;
      if (dt > 0 && dt < 0.2) {
        this.swing += filteredRate * dt;
      }

      this.velHistory.push({ t: now, v: filteredRate });
      while (this.velHistory.length && now - this.velHistory[0].t > 220) {
        this.velHistory.shift();
      }
    }
  }

  _updateGravity(g) {
    if (!g) return;
    this._hasGravity = true;

    const k = 0.18;
    this._gravity.x += k * ((g.x ?? 0) - this._gravity.x);
    this._gravity.y += k * ((g.y ?? 0) - this._gravity.y);
    this._gravity.z += k * ((g.z ?? 0) - this._gravity.z);

    const len = Math.hypot(this._gravity.x, this._gravity.y, this._gravity.z) || 1;
    this.gravY = this._gravity.y / len;
  }

  _updateTiltFromGravity() {
    const { x, y, z } = this._gravity;
    const orientation = this._getScreenAngle();
    let lateral = x;
    let vertical = z;

    if (orientation === 90) {
      lateral = y;
      vertical = z;
      this._tiltSign = 1;
    } else if (orientation === -90 || orientation === 270) {
      lateral = -y;
      vertical = z;
      this._tiltSign = -1;
    } else if (orientation === 180 || orientation === -180) {
      lateral = -x;
      vertical = z;
      this._tiltSign = 1;
    } else {
      this._tiltSign = -1;
    }

    this.tilt = this._tiltSign * (Math.atan2(lateral, Math.abs(vertical) + 0.001) * 180 / Math.PI);
  }

  _updatePoseFromGyro(rate, dt) {
    if (this._hasUsableOrientation || !rate || dt <= 0 || dt >= 0.2) return;

    this._rawPoseYaw = this._normalizeAngle(this._rawPoseYaw + rate.alpha * dt);
    this._rawPosePitch = this._normalizeAngle(this._rawPosePitch + rate.beta * dt);
    this._rawPoseRoll = this._normalizeAngle(this._rawPoseRoll + rate.gamma * dt);

    if (this._hasGravity) {
      const gravityPose = this._getGravityPose();
      this._rawPosePitch = this._blendAngle(this._rawPosePitch, gravityPose.pitch, 0.08);
      this._rawPoseRoll = this._blendAngle(this._rawPoseRoll, gravityPose.roll, 0.08);
    }

    this._applyPoseOffsets();
  }

  _normalizeRotationRate(rate) {
    if (!rate) return null;

    const alpha = Number.isFinite(rate.alpha) ? rate.alpha : 0;
    const beta = Number.isFinite(rate.beta) ? rate.beta : 0;
    const gamma = Number.isFinite(rate.gamma) ? rate.gamma : 0;
    return { alpha, beta, gamma };
  }

  _sampleGyroBias(rate) {
    if (this._gyroSamples.length < 8) {
      this._gyroSamples.push(rate);
      if (this._gyroSamples.length === 8) {
        this._gyroBias = this._averageRates(this._gyroSamples);
        this._swingAxis = this._chooseSwingAxis(this._gyroSamples);
      }
    }
  }

  _getCorrectedRate(rate) {
    return {
      alpha: rate.alpha - this._gyroBias.alpha,
      beta: rate.beta - this._gyroBias.beta,
      gamma: rate.gamma - this._gyroBias.gamma,
    };
  }

  _averageRates(samples) {
    const total = { alpha: 0, beta: 0, gamma: 0 };
    for (const sample of samples) {
      total.alpha += sample.alpha;
      total.beta += sample.beta;
      total.gamma += sample.gamma;
    }

    const count = samples.length || 1;
    return {
      alpha: total.alpha / count,
      beta: total.beta / count,
      gamma: total.gamma / count,
    };
  }

  _chooseSwingAxis(samples) {
    const sums = { alpha: 0, beta: 0, gamma: 0 };
    for (const sample of samples) {
      sums.alpha += Math.abs(sample.alpha);
      sums.beta += Math.abs(sample.beta);
      sums.gamma += Math.abs(sample.gamma);
    }

    if (sums.gamma > sums.beta && sums.gamma > sums.alpha) return "gamma";
    if (sums.alpha > sums.beta) return "alpha";
    return "beta";
  }

  _getScreenAngle() {
    if (typeof screen.orientation?.angle === "number") return screen.orientation.angle;
    if (typeof window.orientation === "number") return window.orientation;
    return 0;
  }

  _normalizeAngle(angle) {
    let value = angle;
    while (value > 180) value -= 360;
    while (value < -180) value += 360;
    return value;
  }

  _orientationSampleChanged(pitch, roll, yaw) {
    if (!this._lastOrientationSample) return true;
    return (
      this._angleDelta(pitch, this._lastOrientationSample.pitch) > 0.1 ||
      this._angleDelta(roll, this._lastOrientationSample.roll) > 0.1 ||
      this._angleDelta(yaw, this._lastOrientationSample.yaw) > 0.1
    );
  }

  _getGravityPose() {
    const { x, y, z } = this._gravity;
    return {
      pitch: Math.atan2(-x, Math.hypot(y, z) + 0.001) * 180 / Math.PI,
      roll: Math.atan2(y, Math.abs(z) + 0.001) * 180 / Math.PI,
    };
  }

  _blendAngle(current, target, factor) {
    const delta = this._normalizeAngle(target - current);
    return this._normalizeAngle(current + delta * factor);
  }

  _angleDelta(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
    return Math.abs(this._normalizeAngle(a - b));
  }

  _applyPoseOffsets() {
    this.posePitch = this._normalizeAngle(this._rawPosePitch - this._poseZeroPitch);
    this.poseRoll = this._normalizeAngle(this._rawPoseRoll - this._poseZeroRoll);
    this.poseYaw = this._normalizeAngle(this._rawPoseYaw - this._poseZeroYaw);
  }

  getDebugState() {
    return {
      started: this._started,
      hasGravity: this._hasGravity,
      hasUsableOrientation: this._hasUsableOrientation,
      orientationEvents: this._orientationEvents,
      motionEvents: this._motionEvents,
      rawOrientation: this._lastRawOrientation,
      rawRotationRate: this._lastRawRotationRate,
      posePitch: this.posePitch,
      poseRoll: this.poseRoll,
      poseYaw: this.poseYaw,
      rawPosePitch: this._rawPosePitch,
      rawPoseRoll: this._rawPoseRoll,
      rawPoseYaw: this._rawPoseYaw,
      zeroPosePitch: this._poseZeroPitch,
      zeroPoseRoll: this._poseZeroRoll,
      zeroPoseYaw: this._poseZeroYaw,
      tilt: this.tilt,
      gravY: this.gravY,
    };
  }

  _logOrientationDebug(e) {
    const now = performance.now();
    if (now - this._lastOrientationLogTime < 1000) return;
    this._lastOrientationLogTime = now;

    console.log("[deviceorientation]", {
      alpha: Number.isFinite(e.alpha) ? Math.round(e.alpha * 10) / 10 : null,
      beta: Number.isFinite(e.beta) ? Math.round(e.beta * 10) / 10 : null,
      gamma: Number.isFinite(e.gamma) ? Math.round(e.gamma * 10) / 10 : null,
      absolute: e.absolute ?? null,
      posePitch: Math.round(this.posePitch * 10) / 10,
      poseRoll: Math.round(this.poseRoll * 10) / 10,
      poseYaw: Math.round(this.poseYaw * 10) / 10,
    });
  }

  _logSensorDebug(rate) {
    const now = performance.now();
    if (now - this._lastSensorLogTime < 1000) return;
    this._lastSensorLogTime = now;

    console.log("[sensor_state]", {
      usableOrientation: this._hasUsableOrientation,
      gravity: this._hasGravity,
      rotationRate: rate
        ? {
            alpha: Math.round(rate.alpha * 10) / 10,
            beta: Math.round(rate.beta * 10) / 10,
            gamma: Math.round(rate.gamma * 10) / 10,
          }
        : null,
      posePitch: Math.round(this.posePitch * 10) / 10,
      poseRoll: Math.round(this.poseRoll * 10) / 10,
      poseYaw: Math.round(this.poseYaw * 10) / 10,
    });
  }
}
