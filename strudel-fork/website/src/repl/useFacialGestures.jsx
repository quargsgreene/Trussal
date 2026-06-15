/*
useFacialGestures.jsx - MediaPipe-based facial gesture detection for REPL control
Copyright (C) 2025 Strudel contributors
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
*/

import { useEffect, useRef, useState } from 'react';

// MediaPipe WASM assets and model loaded from CDN to avoid bundling large binaries.
// Keep this version in sync with @mediapipe/tasks-vision in website/package.json.
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Blendshape thresholds — tuned for clear intentional gestures.
// Blink: 0.8 avoids normal involuntary blinks (typically 0.3–0.6) while still catching a firm deliberate blink.
const BLINK_THRESHOLD = 0.8;
const BROW_INNER_THRESHOLD = 0.6;
const BROW_OUTER_THRESHOLD = 0.45;
const JAW_OPEN_THRESHOLD = 0.5;
// Head tilt threshold: ratio of vertical eye-corner offset to horizontal eye distance.
// tan(~17°) ≈ 0.3 — requires a clear, deliberate head tilt.
const HEAD_TILT_THRESHOLD = 0.3;
// Minimum ms between two gesture triggers of the same type.
const COOLDOWN_MS = 1500;
// EMA smoothing factor — lower values produce more smoothing (slower response).
const EMA_ALPHA = 0.15;
// Latch reset: gesture value must drop below threshold * this factor to re-arm after firing.
const LATCH_RESET = 0.4;

// Initialize faceCtx at module load so pattern code can safely read it before the camera starts.
if (typeof window !== 'undefined') {
  window.faceCtx = window.faceCtx || {
    jawOpen: 0,
    browInnerUp: 0,
    headTilt: 0,
    mouthSmileLeft: 0,
    mouthSmileRight: 0,
    eyeBlinkLeft: 0,
    eyeBlinkRight: 0,
    // Head cursor position in viewport pixels, derived from the forehead landmark.
    // Updated each animation frame; safe to read from pattern callbacks.
    cursorX: typeof window !== 'undefined' ? window.innerWidth / 2 : 0,
    cursorY: typeof window !== 'undefined' ? window.innerHeight / 2 : 0,
  };
}

/**
 * Detects facial gestures via the device camera and MediaPipe FaceLandmarker.
 *
 * Continuous values are EMA-smoothed and published to window.faceCtx each frame,
 * so pattern code like `.gain(() => window.faceCtx.jawOpen)` reads them safely
 * without touching the audio clock thread.
 *
 * Discrete gestures:
 *   - Blink both eyes firmly (eyeBlinkLeft & eyeBlinkRight > 0.8)  → calls onPlay
 *   - Raise both eyebrows (browInnerUp > 0.6 + browOuterUp)        → calls onStop
 *   - Open mouth wide (jawOpen > 0.5), rising-edge latch            → calls onMouthOpen
 *   - Tilt head left (normalized eye-corner Δy < -0.3), latch       → calls onHeadTiltLeft
 *   - Tilt head right (normalized eye-corner Δy > 0.3), latch       → calls onHeadTiltRight
 *
 * @param {object} opts
 * @param {boolean}  opts.enabled          - start/stop the webcam and detection loop
 * @param {Function} opts.onPlay           - called when the play gesture is detected
 * @param {Function} opts.onStop           - called when the stop gesture is detected
 * @param {Function} [opts.onMouthOpen]    - called on rising edge of jaw-open latch
 * @param {Function} [opts.onHeadTiltLeft] - called on rising edge of left-tilt latch
 * @param {Function} [opts.onHeadTiltRight]- called on rising edge of right-tilt latch
 * @returns {{ videoRef, canvasRef, status, detectedGesture }}
 */
export function useFacialGestures({ enabled, onPlay, onStop, onMouthOpen, onHeadTiltLeft, onHeadTiltRight }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const landmarkerRef = useRef(null);
  const mpClassesRef = useRef(null);
  const drawingUtilsRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const lastFiredRef = useRef({ play: 0, stop: 0 });
  // EMA state for all continuous face metrics published to window.faceCtx.
  const emaRef = useRef({
    jawOpen: 0,
    browInnerUp: 0,
    headTilt: 0,
    mouthSmileLeft: 0,
    mouthSmileRight: 0,
    eyeBlinkLeft: 0,
    eyeBlinkRight: 0,
    cursorX: typeof window !== 'undefined' ? window.innerWidth / 2 : 0,
    cursorY: typeof window !== 'undefined' ? window.innerHeight / 2 : 0,
  });
  // Rising-edge latch state: prevents repeated firing while gesture is held.
  const latchRef = useRef({ mouthOpen: false, headLeft: false, headRight: false });

  // Keep all callback refs fresh so the RAF loop never holds a stale closure.
  const onPlayRef = useRef(onPlay);
  const onStopRef = useRef(onStop);
  const onMouthOpenRef = useRef(onMouthOpen);
  const onHeadTiltLeftRef = useRef(onHeadTiltLeft);
  const onHeadTiltRightRef = useRef(onHeadTiltRight);
  const [status, setStatus] = useState('idle');
  const [detectedGesture, setDetectedGesture] = useState(null);

  useEffect(() => { onPlayRef.current = onPlay; }, [onPlay]);
  useEffect(() => { onStopRef.current = onStop; }, [onStop]);
  useEffect(() => { onMouthOpenRef.current = onMouthOpen; }, [onMouthOpen]);
  useEffect(() => { onHeadTiltLeftRef.current = onHeadTiltLeft; }, [onHeadTiltLeft]);
  useEffect(() => { onHeadTiltRightRef.current = onHeadTiltRight; }, [onHeadTiltRight]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function init() {
      setStatus('loading');
      try {
        // Dynamic import keeps MediaPipe out of the initial bundle.
        const { FaceLandmarker, FilesetResolver, DrawingUtils } = await import('@mediapipe/tasks-vision');
        if (cancelled) return;
        mpClassesRef.current = { FaceLandmarker, DrawingUtils };

        const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
        if (cancelled) return;

        const landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          outputFaceBlendshapes: true,
          runningMode: 'VIDEO',
          numFaces: 1,
        });
        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;

        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();

        setStatus('ready');
        startLoop();
      } catch (err) {
        if (!cancelled) {
          console.error('[useFacialGestures]', err);
          setStatus('error');
        }
      }
    }

    function startLoop() {
      function loop() {
        const video = videoRef.current;
        const landmarker = landmarkerRef.current;
        // Wait until the video has enough data for a valid frame.
        if (!video || !landmarker || video.readyState < 2) {
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
        const result = landmarker.detectForVideo(video, performance.now());
        processResult(result);
        drawLandmarks(result);
        rafRef.current = requestAnimationFrame(loop);
      }
      rafRef.current = requestAnimationFrame(loop);
    }

    function processResult(result) {
      const blendshapes = result.faceBlendshapes?.[0]?.categories;
      const landmarks = result.faceLandmarks?.[0];
      if (!blendshapes) return;

      const score = (name) => blendshapes.find((c) => c.categoryName === name)?.score ?? 0;
      const ema = emaRef.current;
      const lerp = (a, b) => a + EMA_ALPHA * (b - a);

      // Update EMA-smoothed continuous values each frame.
      ema.jawOpen = lerp(ema.jawOpen, score('jawOpen'));
      ema.browInnerUp = lerp(ema.browInnerUp, score('browInnerUp'));
      ema.mouthSmileLeft = lerp(ema.mouthSmileLeft, score('mouthSmileLeft'));
      ema.mouthSmileRight = lerp(ema.mouthSmileRight, score('mouthSmileRight'));
      ema.eyeBlinkLeft = lerp(ema.eyeBlinkLeft, score('eyeBlinkLeft'));
      ema.eyeBlinkRight = lerp(ema.eyeBlinkRight, score('eyeBlinkRight'));

      // Head tilt derived from outer eye-corner landmarks (33 = left outer corner,
      // 263 = right outer corner in MediaPipe space). Normalized by inter-eye x-distance
      // so the value is stable regardless of how close the performer is to the camera.
      // Positive = tilted in one direction, negative = the other.
      if (landmarks && landmarks.length > 263) {
        const eyeDistX = Math.abs(landmarks[263].x - landmarks[33].x) || 0.1;
        const tiltRaw = (landmarks[33].y - landmarks[263].y) / eyeDistX;
        ema.headTilt = lerp(ema.headTilt, Math.max(-1, Math.min(1, tiltRaw)));
      }

      // Head cursor from forehead landmark 10 (top-center of the head).
      // x is flipped to match the scaleX(-1) mirrored video display.
      if (landmarks && landmarks.length > 10) {
        const lm = landmarks[10];
        ema.cursorX = lerp(ema.cursorX, (1 - lm.x) * window.innerWidth);
        ema.cursorY = lerp(ema.cursorY, lm.y * window.innerHeight);
      }

      // Publish to global scope — safe to read inside Strudel pattern callbacks
      // because this runs in the animation frame, not the audio clock thread.
      Object.assign(window.faceCtx, ema);

      processGestures(blendshapes, ema);
    }

    function processGestures(blendshapes, ema) {
      const score = (name) => blendshapes.find((c) => c.categoryName === name)?.score ?? 0;
      const eyeBlinkL = score('eyeBlinkLeft');
      const eyeBlinkR = score('eyeBlinkRight');
      const browInnerUp = score('browInnerUp');
      const browOuterUpL = score('browOuterUpLeft');
      const browOuterUpR = score('browOuterUpRight');
      const jawOpen = score('jawOpen');
      const now = Date.now();
      const latch = latchRef.current;

      // Play / Stop use cooldown-based detection (not latch) — they're toggle actions.
      const isBlink = eyeBlinkL > BLINK_THRESHOLD && eyeBlinkR > BLINK_THRESHOLD;
      // Require eyes clearly open so brow-raise can't fire while eyes are closing into a blink.
      const isBrowRaise =
        browInnerUp > BROW_INNER_THRESHOLD &&
        (browOuterUpL > BROW_OUTER_THRESHOLD || browOuterUpR > BROW_OUTER_THRESHOLD) &&
        eyeBlinkL < 0.3 &&
        eyeBlinkR < 0.3;

      if (isBlink && now - lastFiredRef.current.play > COOLDOWN_MS) {
        lastFiredRef.current.play = now;
        flash('play');
        onPlayRef.current?.();
      } else if (isBrowRaise && now - lastFiredRef.current.stop > COOLDOWN_MS) {
        lastFiredRef.current.stop = now;
        flash('stop');
        onStopRef.current?.();
      }

      // Mouth open — rising-edge latch: fires once when threshold is crossed,
      // then waits for value to fall below LATCH_RESET * threshold before re-arming.
      if (!latch.mouthOpen && jawOpen > JAW_OPEN_THRESHOLD) {
        latch.mouthOpen = true;
        flash('mouthOpen');
        onMouthOpenRef.current?.();
      } else if (latch.mouthOpen && jawOpen < JAW_OPEN_THRESHOLD * LATCH_RESET) {
        latch.mouthOpen = false;
      }

      // Head tilt left — rising-edge latch.
      const headTilt = ema.headTilt;
      if (!latch.headLeft && headTilt < -HEAD_TILT_THRESHOLD) {
        latch.headLeft = true;
        flash('headTiltLeft');
        onHeadTiltLeftRef.current?.();
      } else if (latch.headLeft && headTilt > -HEAD_TILT_THRESHOLD * LATCH_RESET) {
        latch.headLeft = false;
      }

      // Head tilt right — rising-edge latch.
      if (!latch.headRight && headTilt > HEAD_TILT_THRESHOLD) {
        latch.headRight = true;
        flash('headTiltRight');
        onHeadTiltRightRef.current?.();
      } else if (latch.headRight && headTilt < HEAD_TILT_THRESHOLD * LATCH_RESET) {
        latch.headRight = false;
      }
    }

    function flash(gesture) {
      setDetectedGesture(gesture);
      setTimeout(() => setDetectedGesture(null), 800);
    }

    function drawLandmarks(result) {
      const canvas = canvasRef.current;
      const mp = mpClassesRef.current;
      const video = videoRef.current;
      if (!canvas || !mp || !video) return;

      if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth || 320;
      if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight || 240;

      const ctx = canvas.getContext('2d');
      if (!drawingUtilsRef.current) {
        drawingUtilsRef.current = new mp.DrawingUtils(ctx);
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!result.faceLandmarks?.length) return;

      const du = drawingUtilsRef.current;
      const FL = mp.FaceLandmarker;
      for (const landmarks of result.faceLandmarks) {
        du.drawConnectors(landmarks, FL.FACE_LANDMARKS_TESSELATION, { color: '#C0C0C040', lineWidth: 0.5 });
        du.drawConnectors(landmarks, FL.FACE_LANDMARKS_RIGHT_EYE, { color: '#FF3030', lineWidth: 1 });
        du.drawConnectors(landmarks, FL.FACE_LANDMARKS_RIGHT_EYEBROW, { color: '#FF3030', lineWidth: 1 });
        du.drawConnectors(landmarks, FL.FACE_LANDMARKS_LEFT_EYE, { color: '#30FF30', lineWidth: 1 });
        du.drawConnectors(landmarks, FL.FACE_LANDMARKS_LEFT_EYEBROW, { color: '#30FF30', lineWidth: 1 });
        du.drawConnectors(landmarks, FL.FACE_LANDMARKS_FACE_OVAL, { color: '#E0E0E0', lineWidth: 1 });
        du.drawConnectors(landmarks, FL.FACE_LANDMARKS_LIPS, { color: '#E0E060', lineWidth: 1 });
      }
    }

    init();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
      mpClassesRef.current = null;
      drawingUtilsRef.current = null;
      // Reset EMA and latch state so re-enabling starts fresh.
      emaRef.current = { jawOpen: 0, browInnerUp: 0, headTilt: 0, mouthSmileLeft: 0, mouthSmileRight: 0, eyeBlinkLeft: 0, eyeBlinkRight: 0, cursorX: window.innerWidth / 2, cursorY: window.innerHeight / 2 };
      latchRef.current = { mouthOpen: false, headLeft: false, headRight: false };
      setStatus('idle');
      setDetectedGesture(null);
    };
  }, [enabled]);

  return { videoRef, canvasRef, status, detectedGesture };
}
