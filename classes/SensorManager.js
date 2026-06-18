class SensorManager {
  constructor() {
    this.tilt = 0;
    this.swing = 0;
    this.spinAngle = 0;
    this.velocity = 0;
    this.velHistory = [];
    this.gravY = 0;
    this.swingAcceleration = 0;
    this.posePitch = 0;
    this.poseRoll = 0;
    this.poseYaw = 0;
    this.gripped = false;

    this._gravity = { x: 0, y: 0, z: 9.8 };
    this._linearAcceleration = { x: 0, y: 0, z: 0 };
    this._accelBias = { x: 0, y: 0, z: 0 };
    this._gyroBias = { alpha: 0, beta: 0, gamma: 0 };
    this._gyroSamples = [];
    this._accelSamples = [];
    this._rawPosePitch = 0;
    this._rawPoseRoll = 0;
    this._rawPoseYaw = 0;
    this._poseZeroPitch = 0;
    this._poseZeroRoll = 0;
    this._poseZeroYaw = 0;
    this._swingAxis = "beta";
    this._tiltSign = -1;
    this._rawTilt = 0;
    this._tiltZero = 0;
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
    this._lastRawAcceleration = null;
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
    this.spinAngle = 0;
    this.velocity = 0;
    this.velHistory = [];
    this._lastMotionTime = performance.now();
    this._gyroSamples = [];
    this._accelSamples = [];
    this._gyroBias = { alpha: 0, beta: 0, gamma: 0 };
    this._accelBias = { x: 0, y: 0, z: 0 };
    this.swingAcceleration = 0;
    this._swingAxis = "beta";
    // Capture resting tilt so the streamed tilt value is grip-relative.
    this._tiltZero = this._rawTilt;
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

    // Tilt comes from OS-fused gamma (used for the streamed/aim value only;
    // spin is the gyro-integrated spinAngle now).
    if (hasGamma) {
      this._rawTilt = nextRoll;
      this.tilt = this._normalizeAngle(this._rawTilt - this._tiltZero);
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
    this._updateLinearAcceleration(e.acceleration, e.accelerationIncludingGravity);

    const now = performance.now();
    const dt = this._lastMotionTime ? (now - this._lastMotionTime) / 1000 : 0;
    this._lastMotionTime = now;

    const rate = this._normalizeRotationRate(e.rotationRate);
    this._lastRawRotationRate = rate;
    this._updatePoseFromGyro(rate, dt);
    this._logSensorDebug(rate);
    if (!rate) return;

    if (this.gripped) {
      this._sampleSensorBias(rate, this._linearAcceleration);
      const corrected = this._getCorrectedRate(rate);
      const correctedAcceleration = this._getCorrectedAcceleration(this._linearAcceleration);
      const axisRate = corrected[this._swingAxis];
      const accelerationMagnitude = Math.hypot(
        correctedAcceleration.x,
        correctedAcceleration.y,
        correctedAcceleration.z,
      );
      const accelerationGate = this._clamp((accelerationMagnitude - 1.0) / 5.0, 0, 1);
      const signedAccelerationSpeed = this._getSwingDirection(axisRate, correctedAcceleration) * accelerationMagnitude * 12.0;
      const armRate = (axisRate * accelerationGate) + (signedAccelerationSpeed * 0.35);
      const filteredRate = this.velocity * 0.35 + armRate * 0.65;

      this.velocity = filteredRate;
      this.swingAcceleration = this.swingAcceleration * 0.65 + accelerationMagnitude * 0.35;
      if (dt > 0 && dt < 0.2) {
        this.swing += filteredRate * dt;
        this.spinAngle += corrected.gamma * dt;   // gyro-integrated wrist twist → spin
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

  _updateLinearAcceleration(acceleration, accelerationIncludingGravity) {
    let next = null;

    if (acceleration && (
      Number.isFinite(acceleration.x) ||
      Number.isFinite(acceleration.y) ||
      Number.isFinite(acceleration.z)
    )) {
      next = {
        x: Number.isFinite(acceleration.x) ? acceleration.x : 0,
        y: Number.isFinite(acceleration.y) ? acceleration.y : 0,
        z: Number.isFinite(acceleration.z) ? acceleration.z : 0,
      };
    } else if (accelerationIncludingGravity) {
      next = {
        x: (accelerationIncludingGravity.x ?? 0) - this._gravity.x,
        y: (accelerationIncludingGravity.y ?? 0) - this._gravity.y,
        z: (accelerationIncludingGravity.z ?? 0) - this._gravity.z,
      };
    }

    if (!next) return;

    const k = 0.45;
    this._linearAcceleration.x += k * (next.x - this._linearAcceleration.x);
    this._linearAcceleration.y += k * (next.y - this._linearAcceleration.y);
    this._linearAcceleration.z += k * (next.z - this._linearAcceleration.z);
    this._lastRawAcceleration = next;
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

  _sampleSensorBias(rate, acceleration) {
    if (this._gyroSamples.length < 8) {
      this._gyroSamples.push(rate);
      this._accelSamples.push(acceleration);
      if (this._gyroSamples.length === 8) {
        this._gyroBias = this._averageRates(this._gyroSamples);
        this._accelBias = this._averageAccelerations(this._accelSamples);
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

  _averageAccelerations(samples) {
    const total = { x: 0, y: 0, z: 0 };
    for (const sample of samples) {
      total.x += sample.x;
      total.y += sample.y;
      total.z += sample.z;
    }

    const count = samples.length || 1;
    return {
      x: total.x / count,
      y: total.y / count,
      z: total.z / count,
    };
  }

  _getCorrectedAcceleration(acceleration) {
    return {
      x: acceleration.x - this._accelBias.x,
      y: acceleration.y - this._accelBias.y,
      z: acceleration.z - this._accelBias.z,
    };
  }

  _getSwingDirection(axisRate, acceleration) {
    if (Math.abs(axisRate) > 0.5) return Math.sign(axisRate);

    const orientation = this._getScreenAngle();
    let forwardAcceleration = acceleration.y;
    if (orientation === 90) {
      forwardAcceleration = -acceleration.x;
    } else if (orientation === -90 || orientation === 270) {
      forwardAcceleration = acceleration.x;
    } else if (orientation === 180 || orientation === -180) {
      forwardAcceleration = -acceleration.y;
    }

    if (Math.abs(forwardAcceleration) > 0.1) return Math.sign(forwardAcceleration);
    return 0;
  }

  _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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
      rawAcceleration: this._lastRawAcceleration,
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
      spinAngle: this.spinAngle,
      gravY: this.gravY,
      swingAcceleration: this.swingAcceleration,
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
      swingAcceleration: Math.round(this.swingAcceleration * 10) / 10,
      tilt: Math.round(this.tilt * 10) / 10,
      spinAngle: Math.round(this.spinAngle * 10) / 10,
      posePitch: Math.round(this.posePitch * 10) / 10,
      poseRoll: Math.round(this.poseRoll * 10) / 10,
      poseYaw: Math.round(this.poseYaw * 10) / 10,
    });
  }
}