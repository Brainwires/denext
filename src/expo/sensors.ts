/**
 * `expo-sensors` for denext: the motion sensors from the page's `devicemotion` /
 * `deviceorientation` events (the Capacitor shell's WebView and mobile browsers), and the
 * Generic Sensor API where the browser has it.
 *
 * Each reading is in Expo's units, which its web build does not convert:
 *
 * - `Accelerometer`: `accelerationIncludingGravity` in g (÷ 9.80665), signed as Expo reports it
 *   on iOS and Android (`z` ≈ -1 lying face up).
 * - `Gyroscope`: `rotationRate` in rad/s around x (`beta`), y (`gamma`) and z (`alpha`).
 * - `DeviceMotion`: acceleration with and without gravity (m/s²), `rotation` from
 *   `deviceorientation` in radians, `rotationRate` in deg/s, `interval` (ms) and the screen
 *   `orientation`.
 * - `Magnetometer` / `MagnetometerUncalibrated` (µT) and `LightSensor` (lux): the Generic Sensor
 *   API's `Magnetometer` / `UncalibratedMagnetometer` / `AmbientLightSensor` where the browser
 *   exposes them (Chromium behind a flag); otherwise unavailable, as in the WebView shells.
 * - `Barometer` and `Pedometer`: no web API; unavailable (`isAvailableAsync()` is `false`).
 *
 * Updates arrive at most once per `setUpdateInterval` (default 100 ms). iOS asks for motion
 * access once: call `requestPermissionsAsync()` from a tap (WebKit refuses it otherwise).
 *
 * @example
 * ```ts
 * import { Accelerometer } from "denext/expo/sensors";
 *
 * Accelerometer.setUpdateInterval(50);
 * const sub = Accelerometer.addListener(({ x, y, z }) => console.log(x, y, z));
 * ```
 *
 * @module
 */

import {
  type PermissionExpiration,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
  type Subscription,
  subscription,
  unavailable,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionResponse, Subscription };

/** A sensor listener. */
export type Listener<E> = (event: E) => void;

/** Standard gravity, m/s². */
const G = 9.80665;

/** Degrees → radians. */
const RAD = Math.PI / 180;

/** The default time between updates (ms). */
const DEFAULT_INTERVAL = 100;

/** The page's event target and the motion events' constructors. */
type Win = {
  addEventListener?: (type: string, fn: (event: never) => void) => void;
  removeEventListener?: (type: string, fn: (event: never) => void) => void;
  DeviceMotionEvent?: { requestPermission?: () => Promise<string> };
  DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
  orientation?: number;
  screen?: { orientation?: { angle?: number } };
  navigator?: { userAgent?: string };
};

/** globalThis as the page. */
function win(): Win {
  return globalThis as unknown as Win;
}

/** The motion permission once asked (iOS remembers it for the page's lifetime). */
let motionPermission: PermissionStatus | undefined;

/** WebKit's permission request, when this platform needs one. */
function permissionRequest(): (() => Promise<string>) | undefined {
  const w = win();
  return w.DeviceMotionEvent?.requestPermission ?? w.DeviceOrientationEvent?.requestPermission;
}

/** The motion permission, without asking. */
function motionPermissionAsync(): Promise<PermissionResponse> {
  const status = motionPermission ??
    (permissionRequest() ? PermissionStatus.UNDETERMINED : PermissionStatus.GRANTED);
  return Promise.resolve(permissionResponse(status));
}

/** Ask for motion access (WebKit: must run in a tap's handler). */
async function requestMotionPermissionAsync(): Promise<PermissionResponse> {
  const w = win();
  const asks = [w.DeviceMotionEvent?.requestPermission, w.DeviceOrientationEvent?.requestPermission]
    .filter((f): f is () => Promise<string> => typeof f === "function");
  if (asks.length === 0) return permissionResponse(PermissionStatus.GRANTED);
  let status = PermissionStatus.GRANTED;
  for (const ask of asks) {
    try {
      const answer = await ask();
      if (answer !== "granted") status = PermissionStatus.DENIED;
    } catch {
      status = PermissionStatus.DENIED;
    }
  }
  motionPermission = status;
  return { ...permissionResponse(status), canAskAgain: false };
}

/**
 * A source of readings: whether it exists, and how to start it. `start` returns the stop.
 * Expo's sensor classes take their native module first; here it is this.
 */
export interface SensorSource<M> {
  /** Whether readings can arrive here. */
  isAvailableAsync(): Promise<boolean>;
  /** Start delivering readings to `emit`; returns the stop. */
  start(emit: (reading: M) => void): () => void;
  /** The permission, without asking. */
  getPermissionsAsync(): Promise<PermissionResponse>;
  /** Ask for the permission. */
  requestPermissionsAsync(): Promise<PermissionResponse>;
}

/** Whether a motion event of `type` arrives within `ms` (a desktop browser never sends one). */
function eventArrives(type: string, ms = 250): Promise<boolean> {
  const w = win();
  if (typeof w.addEventListener !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(id);
      w.removeEventListener?.(type, heard);
      resolve(value);
    };
    const heard = () => done(true);
    const id = setTimeout(() => done(false), ms);
    w.addEventListener!(type, heard);
  });
}

/** A source over a window event (`devicemotion` / `deviceorientation`). */
function eventSource<E, M>(
  type: "devicemotion" | "deviceorientation",
  ctor: "DeviceMotionEvent" | "DeviceOrientationEvent",
  read: (event: E) => M | null,
): SensorSource<M> {
  return {
    async isAvailableAsync() {
      if (!(ctor in (globalThis as object))) return false;
      // Behind WebKit's permission the sensor exists; ask before listening.
      if (permissionRequest() && motionPermission !== PermissionStatus.GRANTED) return true;
      return await eventArrives(type);
    },
    start(emit) {
      const w = win();
      const listener = (event: E) => {
        const reading = read(event);
        if (reading) emit(reading);
      };
      w.addEventListener?.(type, listener as (event: never) => void);
      return () => w.removeEventListener?.(type, listener as (event: never) => void);
    },
    getPermissionsAsync: motionPermissionAsync,
    requestPermissionsAsync: requestMotionPermissionAsync,
  };
}

/** A Generic Sensor API sensor instance. */
interface GenericSensor {
  start(): void;
  stop(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  [field: string]: unknown;
}

/** A source over a Generic Sensor API class (`Magnetometer`, `AmbientLightSensor`, …). */
function genericSource<M>(name: string, read: (s: GenericSensor) => M): SensorSource<M> {
  const Ctor = () =>
    (globalThis as Record<string, unknown>)[name] as
      | (new (o?: { frequency?: number }) => GenericSensor)
      | undefined;
  return {
    isAvailableAsync: () => Promise.resolve(typeof Ctor() === "function"),
    start(emit) {
      const C = Ctor();
      if (typeof C !== "function") return () => {};
      let sensor: GenericSensor;
      try {
        sensor = new C({ frequency: 60 });
      } catch {
        return () => {};
      }
      const onReading = () => emit(read(sensor));
      sensor.addEventListener("reading", onReading);
      sensor.start();
      return () => {
        sensor.removeEventListener("reading", onReading);
        sensor.stop();
      };
    },
    getPermissionsAsync: () => Promise.resolve(permissionResponse(PermissionStatus.GRANTED)),
    requestPermissionsAsync: () => Promise.resolve(permissionResponse(PermissionStatus.GRANTED)),
  };
}

/** A sensor with no web API. */
function noSource<M>(): SensorSource<M> {
  return {
    isAvailableAsync: () => Promise.resolve(false),
    start: () => () => {},
    getPermissionsAsync: () => Promise.resolve(permissionResponse(PermissionStatus.GRANTED)),
    requestPermissionsAsync: () => Promise.resolve(permissionResponse(PermissionStatus.GRANTED)),
  };
}

/**
 * The base of every sensor: listeners, the update interval and the permission calls. Its
 * first argument is the reading source (Expo's: the native module).
 */
export class DeviceSensor<Measurement> {
  /** The reading source. */
  _nativeModule: SensorSource<Measurement>;
  /** The event name (kept for Expo's shape). */
  _nativeEventName: string;
  /** The listeners. */
  #listeners = new Set<Listener<Measurement>>();
  /** The source's stop, while listening. */
  #stop: (() => void) | undefined;
  /** The minimum time between updates (ms). */
  #interval = DEFAULT_INTERVAL;
  /** When the last update went out. */
  #last = -Infinity;

  /**
   * Create a sensor over a source.
   *
   * @param nativeSensorModule The reading source.
   * @param nativeEventName The event name.
   */
  constructor(nativeSensorModule: SensorSource<Measurement>, nativeEventName: string) {
    this._nativeModule = nativeSensorModule;
    this._nativeEventName = nativeEventName;
  }

  /**
   * Call `listener` with each reading, at most once per update interval.
   *
   * @param listener Called with each reading.
   * @returns A subscription to remove.
   */
  addListener(listener: Listener<Measurement>): Subscription {
    const own = (reading: Measurement) => listener(reading);
    this.#listeners.add(own);
    if (this.#listeners.size === 1) {
      this.#stop = this._nativeModule.start((reading) => this.#emit(reading));
    }
    return subscription(() => this.#remove(own));
  }

  /** Deliver a reading if the interval has passed. */
  #emit(reading: Measurement): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - this.#last < this.#interval) return;
    this.#last = now;
    for (const listener of [...this.#listeners]) listener(reading);
  }

  /** Drop one listener; the last stops the source. */
  #remove(listener: Listener<Measurement>): void {
    if (!this.#listeners.delete(listener) || this.#listeners.size > 0) return;
    this.#stop?.();
    this.#stop = undefined;
    this.#last = -Infinity;
  }

  /**
   * Whether it has listeners.
   *
   * @returns Whether any are subscribed.
   */
  hasListeners(): boolean {
    return this.#listeners.size > 0;
  }

  /**
   * How many listeners it has.
   *
   * @returns The count.
   */
  getListenerCount(): number {
    return this.#listeners.size;
  }

  /** Remove every listener. */
  removeAllListeners(): void {
    for (const listener of [...this.#listeners]) this.#remove(listener);
  }

  /**
   * Remove a subscription (deprecated in Expo: call `subscription.remove()`).
   *
   * @param subscription The subscription.
   */
  removeSubscription(subscription: Subscription): void {
    subscription.remove();
  }

  /**
   * Set the minimum time between updates.
   *
   * @param intervalMs Milliseconds (the page's events arrive at about 60 Hz at most).
   */
  setUpdateInterval(intervalMs: number): void {
    this.#interval = Math.max(0, Number(intervalMs) || 0);
  }

  /**
   * Whether the sensor exists here.
   *
   * @returns Whether readings can arrive.
   */
  isAvailableAsync(): Promise<boolean> {
    return this._nativeModule.isAvailableAsync();
  }

  /**
   * The sensor permission, without asking.
   *
   * @returns The permission.
   */
  getPermissionsAsync(): Promise<PermissionResponse> {
    return this._nativeModule.getPermissionsAsync();
  }

  /**
   * Ask for the sensor permission (iOS: motion access, from a tap).
   *
   * @returns The answer.
   */
  requestPermissionsAsync(): Promise<PermissionResponse> {
    return this._nativeModule.requestPermissionsAsync();
  }
}

/** A three-axis reading (and its time in seconds). */
export interface Vector3Measurement {
  /** The x axis. */
  x: number;
  /** The y axis. */
  y: number;
  /** The z axis. */
  z: number;
  /** When it was read (seconds). */
  timestamp: number;
}

/** The web motion event's fields read here. */
interface MotionEventLike {
  acceleration?: { x: number | null; y: number | null; z: number | null } | null;
  accelerationIncludingGravity?: { x: number | null; y: number | null; z: number | null } | null;
  rotationRate?: { alpha: number | null; beta: number | null; gamma: number | null } | null;
  interval?: number;
  timeStamp?: number;
}

/** The web orientation event's fields read here. */
interface OrientationEventLike {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  timeStamp?: number;
}

/** An event's time in seconds, as Expo reports it. */
function seconds(event: { timeStamp?: number }): number {
  return (event.timeStamp ?? Date.now()) / 1000;
}

/** An accelerometer reading. */
export type AccelerometerMeasurement = Vector3Measurement;

/** The accelerometer: `accelerationIncludingGravity` in g. */
export const Accelerometer: DeviceSensor<AccelerometerMeasurement> = new DeviceSensor(
  eventSource<MotionEventLike, AccelerometerMeasurement>(
    "devicemotion",
    "DeviceMotionEvent",
    (event) => {
      const a = event.accelerationIncludingGravity;
      if (!a || a.x === null || a.y === null || a.z === null) return null;
      return { x: -a.x / G, y: -a.y / G, z: -a.z / G, timestamp: seconds(event) };
    },
  ),
  "accelerometerDidUpdate",
);

/** A gyroscope reading (rad/s). */
export type GyroscopeMeasurement = Vector3Measurement;

/** The gyroscope: `rotationRate` in rad/s. */
export const Gyroscope: DeviceSensor<GyroscopeMeasurement> = new DeviceSensor(
  eventSource<MotionEventLike, GyroscopeMeasurement>(
    "devicemotion",
    "DeviceMotionEvent",
    (event) => {
      const r = event.rotationRate;
      if (!r || r.alpha === null || r.beta === null || r.gamma === null) return null;
      return { x: r.beta * RAD, y: r.gamma * RAD, z: r.alpha * RAD, timestamp: seconds(event) };
    },
  ),
  "gyroscopeDidUpdate",
);

/** The screen's orientation, as `DeviceMotion` reports it. */
export enum DeviceMotionOrientation {
  /** Portrait. */
  Portrait = 0,
  /** Landscape, rotated right. */
  RightLandscape = 90,
  /** Upside down. */
  UpsideDown = 180,
  /** Landscape, rotated left. */
  LeftLandscape = -90,
}

/** A device-motion reading. */
export interface DeviceMotionMeasurement {
  /** Acceleration without gravity (m/s²), when the device reports it. */
  acceleration: null | { x: number; y: number; z: number; timestamp: number };
  /** Acceleration with gravity (m/s²). */
  accelerationIncludingGravity: { x: number; y: number; z: number; timestamp: number };
  /** The device's rotation (radians), from `deviceorientation`. */
  rotation: { alpha: number; beta: number; gamma: number; timestamp: number };
  /** The rate of rotation (deg/s), when the device reports it. */
  rotationRate: null | { alpha: number; beta: number; gamma: number; timestamp: number };
  /** The time between motion events (ms). */
  interval: number;
  /** The screen's orientation. */
  orientation: DeviceMotionOrientation;
}

/** The screen's orientation now. */
function screenOrientation(): DeviceMotionOrientation {
  const w = win();
  const angle = typeof w.orientation === "number" ? w.orientation : w.screen?.orientation?.angle;
  switch (angle) {
    case 90:
      return DeviceMotionOrientation.RightLandscape;
    case 180:
      return DeviceMotionOrientation.UpsideDown;
    case -90:
    case 270:
      return DeviceMotionOrientation.LeftLandscape;
    default:
      return DeviceMotionOrientation.Portrait;
  }
}

/** The last `deviceorientation` reading (radians), merged into device-motion readings. */
const lastRotation = { alpha: 0, beta: 0, gamma: 0, timestamp: 0 };

/** Device motion: `devicemotion` with the latest `deviceorientation` merged in. */
const motionSource: SensorSource<DeviceMotionMeasurement> = (() => {
  const motion = eventSource<MotionEventLike, DeviceMotionMeasurement>(
    "devicemotion",
    "DeviceMotionEvent",
    (event) => {
      const t = seconds(event);
      const g = event.accelerationIncludingGravity;
      const a = event.acceleration;
      const r = event.rotationRate;
      return {
        acceleration: a && a.x !== null
          ? { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0, timestamp: t }
          : null,
        accelerationIncludingGravity: { x: g?.x ?? 0, y: g?.y ?? 0, z: g?.z ?? 0, timestamp: t },
        rotation: { ...lastRotation },
        rotationRate: r && r.alpha !== null
          ? { alpha: r.alpha ?? 0, beta: r.beta ?? 0, gamma: r.gamma ?? 0, timestamp: t }
          : null,
        interval: event.interval ?? 0,
        orientation: screenOrientation(),
      };
    },
  );
  const orientation = eventSource<OrientationEventLike, null>(
    "deviceorientation",
    "DeviceOrientationEvent",
    (event) => {
      if (event.alpha === null || event.beta === null || event.gamma === null) return null;
      Object.assign(lastRotation, {
        alpha: event.alpha * RAD,
        beta: event.beta * RAD,
        gamma: event.gamma * RAD,
        timestamp: seconds(event),
      });
      return null;
    },
  );
  return {
    ...motion,
    start(emit) {
      const stopOrientation = orientation.start(() => {});
      const stopMotion = motion.start(emit);
      return () => {
        stopMotion();
        stopOrientation();
      };
    },
  };
})();

/** Device motion. */
export class DeviceMotionSensor extends DeviceSensor<DeviceMotionMeasurement> {
  /** Standard gravity (m/s²). */
  Gravity: number = G;
}

/** Device motion: acceleration, rotation and rotation rate together. */
export const DeviceMotion: DeviceMotionSensor = new DeviceMotionSensor(
  motionSource,
  "deviceMotionDidUpdate",
);

/** A magnetometer reading (µT). */
export type MagnetometerMeasurement = Vector3Measurement;

/** A three-axis Generic Sensor reading. */
function vector(s: GenericSensor): Vector3Measurement {
  return {
    x: Number(s.x ?? 0),
    y: Number(s.y ?? 0),
    z: Number(s.z ?? 0),
    timestamp: Number(s.timestamp ?? Date.now()) / 1000,
  };
}

/** The magnetometer: the Generic Sensor API's `Magnetometer`, where the browser has it. */
export const Magnetometer: DeviceSensor<MagnetometerMeasurement> = new DeviceSensor(
  genericSource("Magnetometer", vector),
  "magnetometerDidUpdate",
);

/** An uncalibrated magnetometer reading (µT). */
export type MagnetometerUncalibratedMeasurement = Vector3Measurement;

/** The uncalibrated magnetometer: the Generic Sensor API's `UncalibratedMagnetometer`. */
export const MagnetometerUncalibrated: DeviceSensor<MagnetometerUncalibratedMeasurement> =
  new DeviceSensor(
    genericSource("UncalibratedMagnetometer", vector),
    "magnetometerUncalibratedDidUpdate",
  );

/** A barometer reading. */
export interface BarometerMeasurement {
  /** Pressure (hPa). */
  pressure: number;
  /** Altitude change since listening began (m, iOS). */
  relativeAltitude?: number;
  /** Seconds. */
  timestamp: number;
}

/** The barometer: no web API, so unavailable. */
export const Barometer: DeviceSensor<BarometerMeasurement> = new DeviceSensor(
  noSource<BarometerMeasurement>(),
  "barometerDidUpdate",
);

/** A light sensor reading. */
export interface LightSensorMeasurement {
  /** Illuminance (lux). */
  illuminance: number;
  /** Seconds. */
  timestamp: number;
}

/** The ambient light sensor: the Generic Sensor API's `AmbientLightSensor`, where present. */
export const LightSensor: DeviceSensor<LightSensorMeasurement> = new DeviceSensor(
  genericSource("AmbientLightSensor", (s) => ({
    illuminance: Number(s.illuminance ?? 0),
    timestamp: Number(s.timestamp ?? Date.now()) / 1000,
  })),
  "lightSensorDidUpdate",
);

/** A step count. */
export interface PedometerResult {
  /** Steps. */
  steps: number;
}

/** Called with step counts. */
export type PedometerUpdateCallback = (result: PedometerResult) => void;

/**
 * The pedometer: no web API, so unavailable (`isAvailableAsync()` is `false`, a watch never
 * fires, a count rejects with `ERR_UNAVAILABLE`).
 */
export const Pedometer: {
  watchStepCount: (callback: PedometerUpdateCallback) => Subscription;
  getStepCountAsync: (start: Date, end: Date) => Promise<PedometerResult>;
  isAvailableAsync: () => Promise<boolean>;
  getPermissionsAsync: () => Promise<PermissionResponse>;
  requestPermissionsAsync: () => Promise<PermissionResponse>;
  PermissionStatus: typeof PermissionStatus;
} = {
  watchStepCount: (_callback) => subscription(() => {}),
  getStepCountAsync: () =>
    Promise.reject(
      unavailable("expo-sensors", "Pedometer.getStepCountAsync", "No web API counts steps."),
    ),
  isAvailableAsync: () => Promise.resolve(false),
  getPermissionsAsync: () => Promise.resolve(permissionResponse(PermissionStatus.GRANTED)),
  requestPermissionsAsync: () => Promise.resolve(permissionResponse(PermissionStatus.GRANTED)),
  PermissionStatus,
};
