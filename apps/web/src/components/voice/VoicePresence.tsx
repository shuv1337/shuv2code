import { useEffect, useRef, type RefObject } from "react";

import { VOICE_PHASE_RENDER_STATES, type VoicePresencePhase } from "./voicePresenceTheme";
import {
  INITIAL_VOICE_PRESENCE_PERFORMANCE_STATE,
  isConstrainedWebGlRenderer,
  nextVoicePresencePerformanceState,
  voicePresenceFrameInterval,
  voicePresenceRenderPolicy,
  type VoicePresencePerformanceState,
  type VoicePresenceRenderPolicy,
} from "./voicePresenceRenderPolicy";

interface VoicePresenceProps {
  readonly phase: VoicePresencePhase;
  readonly presented?: boolean;
  readonly className?: string | undefined;
  /** Continuously sampled 0..1 audio energy. Kept outside React's render loop. */
  readonly activityLevel?: RefObject<number>;
}

const VERTEX_SHADER = `
  attribute vec2 a_position;

  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  #extension GL_OES_standard_derivatives : enable
  precision highp float;

  uniform vec2 u_resolution;
  uniform float u_displayAspect;
  uniform float u_time;
  uniform vec3 u_accent;
  uniform float u_energy;
  uniform float u_voice;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 rotation = mat2(0.80, 0.60, -0.60, 0.80);

    for (int octave = 0; octave < 4; octave++) {
      value += amplitude * noise(p);
      p = rotation * p * 2.03 + 17.17;
      amplitude *= 0.5;
    }

    return value;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    vec2 p = vec2((uv.x - 0.5) * u_displayAspect, uv.y - 0.5);
    float time = u_time * 0.14;
    float breath = u_voice * 0.026;

    // Low-frequency advection moves the material continuously without ever resetting its identity.
    float driftA = fbm(p * 1.34 + vec2(time * 0.11, -time * 0.075));
    float driftB = fbm(p * 1.91 + vec2(driftA * 1.42, -driftA * 1.16) - time * 0.065);
    vec2 flow = vec2(driftA - 0.5, driftB - 0.5);
    vec2 materialUv = p + flow * 0.24;
    float mass = fbm(materialUv * 2.6 + vec2(-time * 0.043, time * 0.031));
    float marble = fbm(materialUv * 5.7 + vec2(mass * 1.36, -driftB * 0.92));
    float mineralGrain = fbm(materialUv * 11.8 + vec2(marble * 1.08, -mass * 0.72));

    // Three soft currents cross the field on independent curved paths. Their entry and exit
    // points migrate slowly, preventing one persistent seam or bilateral silhouette.
    float entryA = 0.08 + sin(time * 0.42 + 0.4) * 0.29;
    float exitA = 0.88 + sin(time * 0.31 + 2.1) * 0.31;
    float centerA = mix(entryA, exitA, uv.y);
    centerA += sin(uv.y * 3.15 + time * 0.38) * 0.13;
    centerA += sin(uv.y * 6.4 - time * 0.21) * 0.035 + flow.x * 0.13;
    centerA += sin(time * 0.24 + 1.7) * sin(uv.y * 3.14159) * 0.19;

    float entryB = 1.09 + sin(time * 0.27 + 1.8) * 0.22;
    float exitB = 0.28 + sin(time * 0.37 + 3.4) * 0.28;
    float centerB = mix(entryB, exitB, uv.y);
    centerB += sin(uv.y * 4.3 - time * 0.29 + 1.1) * 0.105;
    centerB += flow.y * 0.12;
    centerB += cos(time * 0.2 + 0.5) * sin(uv.y * 3.14159) * 0.13;

    float centerC = -0.08 + uv.y * 0.38;
    centerC += sin(uv.y * 2.7 + time * 0.24 + 4.2) * 0.16;
    centerC += (mass - 0.5) * 0.14;

    float widthA = 0.19 + (mass - 0.5) * 0.085 + breath;
    float widthB = 0.24 + (driftB - 0.5) * 0.075 + breath * 0.7;
    float widthC = 0.31 + (driftA - 0.5) * 0.1;
    float plumeA = exp(-pow(abs(uv.x - centerA) / widthA, 1.72));
    float plumeB = exp(-pow(abs(uv.x - centerB) / widthB, 1.58));
    float plumeC = exp(-pow(abs(uv.x - centerC) / widthC, 1.48));
    float wispCenterA = centerA + sin(uv.y * 7.2 - time * 0.33 + 0.8) * 0.095;
    float wispCenterB = centerB + sin(uv.y * 5.8 + time * 0.28 + 3.1) * 0.12;
    float wispA = exp(-pow(abs(uv.x - wispCenterA) / 0.075, 1.48));
    float wispB = exp(-pow(abs(uv.x - wispCenterB) / 0.105, 1.42));

    float arcRadius = 0.39 + sin(time * 0.19 + 0.7) * 0.08;
    vec2 arcCenter = vec2(
      0.16 + sin(time * 0.23 + 2.6) * 0.18,
      0.43 + cos(time * 0.17) * 0.11
    );
    vec2 arcPoint = vec2(uv.x, uv.y * 0.82);
    float arcDistance = abs(length(arcPoint - arcCenter) - arcRadius);
    float plumeArc = exp(-pow(arcDistance / (0.13 + breath * 0.55), 1.62));

    float cloudTexture = fbm(materialUv * 4.15 + vec2(time * 0.018, -time * 0.026));
    float density = plumeA * (0.45 + cloudTexture * 0.54);
    density += plumeB * (0.09 + marble * 0.14);
    density += plumeC * (0.16 + driftA * 0.23);
    density += plumeArc * (0.14 + cloudTexture * 0.16);
    density += wispA * (0.045 + marble * 0.055);
    density += wispB * (0.028 + cloudTexture * 0.04);
    density *= 0.83 + mass * 0.24;

    float atmosphere = smoothstep(0.08, 0.72, density);
    float body = smoothstep(0.31, 0.98, density);
    float heart = smoothstep(0.64, 1.28, density);
    float vaporGradient = length(vec2(dFdx(density), dFdy(density)));
    float silverLining = smoothstep(0.012, 0.095, vaporGradient) * atmosphere;

    // Mineral relief survives as a quiet substrate inside the moving volume.
    float heightField = mass * 0.64 + marble * 0.27 + mineralGrain * 0.09;
    vec3 normal = normalize(vec3(-dFdx(heightField) * 45.0, -dFdy(heightField) * 31.0, 1.0));
    vec3 grazingDirection = normalize(vec3(-0.48, 0.23, 0.84));
    float grazing = 0.18 + pow(max(dot(normal, grazingDirection), 0.0), 1.65) * 0.82;
    float mineralVein = pow(1.0 - abs(mineralGrain * 2.0 - 1.0), 5.2);

    vec3 background = vec3(0.021, 0.025, 0.031);
    vec3 graphite = vec3(0.145, 0.156, 0.17);
    vec3 mineral = mix(graphite, u_accent, 0.17);
    vec3 pearl = mix(vec3(0.78, 0.8, 0.79), u_accent, 0.2);
    vec3 color = background;

    color += mineral * (0.07 + mass * 0.19) * grazing;
    color += mineral * atmosphere * (0.11 + marble * 0.14 + u_energy * 0.04);
    color += u_accent * atmosphere * (0.065 + u_energy * 0.08 + u_voice * 0.055);
    color += mix(u_accent, pearl, 0.42) * body *
      (0.1 + cloudTexture * 0.12 + u_energy * 0.09 + u_voice * 0.12);
    color += pearl * heart * (0.075 + cloudTexture * 0.1 + u_voice * 0.14);
    color += pearl * silverLining * (0.018 + u_energy * 0.022);
    color += pearl * mineralVein * body * 0.015;

    float shadowPocket = smoothstep(0.62, 0.92, marble) * atmosphere * (1.0 - heart);
    color *= 1.0 - shadowPocket * 0.07;

    float verticalFade = smoothstep(0.025, 0.16, uv.y) *
      (1.0 - smoothstep(0.83, 0.995, uv.y));
    color = mix(background, color, 0.48 + verticalFade * 0.52);

    vec2 vignetteUv = uv * (1.0 - uv.yx);
    float vignette = pow(clamp(vignetteUv.x * vignetteUv.y * 18.0, 0.0, 1.0), 0.2);
    color *= 0.72 + vignette * 0.28;

    float grain = hash(floor(gl_FragCoord.xy * 0.61)) - 0.5;
    color += grain * 0.0055;

    gl_FragColor = vec4(color, 1.0);
  }
`;

const PHASE_EASE_SECONDS = 4.2;
// Keep one backing store for the life of the presence. Assigning canvas.width or
// canvas.height clears WebGL immediately, which becomes a visible flash while a
// native split panel is being dragged. CSS scales the last complete frame during
// relayout; the next draw adapts the material through u_displayAspect.
const BACKING_WIDTH = 640;
const BACKING_HEIGHT = 1024;

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function createProgram(gl: WebGLRenderingContext) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  gl.deleteProgram(program);
  return null;
}

/** A dependency-free, continuously evolving material field rendered in one GPU draw call. */
export function VoicePresence({
  phase,
  presented = true,
  activityLevel,
  className,
}: VoicePresenceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const targetRef = useRef(VOICE_PHASE_RENDER_STATES[phase]);
  const phaseRef = useRef(phase);
  const presentedRef = useRef(presented);
  const invalidateRef = useRef<(() => void) | null>(null);
  targetRef.current = VOICE_PHASE_RENDER_STATES[phase];
  phaseRef.current = phase;
  presentedRef.current = presented;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
    });
    if (!gl) return;
    if (!gl.getExtension("OES_standard_derivatives")) return;

    const program = createProgram(gl);
    if (!program) return;
    const buffer = gl.createBuffer();
    if (!buffer) return;

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const displayAspectLocation = gl.getUniformLocation(program, "u_displayAspect");
    const timeLocation = gl.getUniformLocation(program, "u_time");
    const accentLocation = gl.getUniformLocation(program, "u_accent");
    const energyLocation = gl.getUniformLocation(program, "u_energy");
    const voiceLocation = gl.getUniformLocation(program, "u_voice");
    const initial = targetRef.current;
    const current = {
      accent: [...initial.accent] as [number, number, number],
      energy: initial.energy,
      voice: 0,
    };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationTimer = 0;
    let lastAnimationTick = 0;
    let previousTime = performance.now();
    let elapsedSeconds = 0;
    let displayAspect = 1;
    let documentVisible = document.visibilityState === "visible";
    let frameDirty = true;
    let performanceState: VoicePresencePerformanceState = INITIAL_VOICE_PRESENCE_PERFORMANCE_STATE;

    const debugRendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debugRendererInfo
      ? String(gl.getParameter(debugRendererInfo.UNMASKED_RENDERER_WEBGL))
      : null;
    const softwareRenderer = isConstrainedWebGlRenderer(renderer);

    canvas.width = BACKING_WIDTH;
    canvas.height = BACKING_HEIGHT;
    gl.viewport(0, 0, BACKING_WIDTH, BACKING_HEIGHT);

    const currentPolicy = (): VoicePresenceRenderPolicy =>
      voicePresenceRenderPolicy({
        phase: phaseRef.current,
        documentVisible,
        presented: presentedRef.current,
        reducedMotion: reducedMotion.matches,
        softwareRenderer,
        performanceMode: performanceState.mode,
      });

    const publishPolicy = (policy: VoicePresenceRenderPolicy) => {
      canvas.dataset.renderPolicy = policy;
      canvas.dataset.renderer = softwareRenderer ? "software" : "accelerated";
      canvas.dataset.performance = performanceState.mode;
    };

    const cancelScheduledFrame = () => {
      if (animationTimer) window.clearTimeout(animationTimer);
      animationTimer = 0;
    };

    const drawMaterial = (now: number, policy: VoicePresenceRenderPolicy) => {
      const deltaSeconds = Math.min(Math.max((now - previousTime) / 1_000, 0), 0.1);
      previousTime = now;
      if (policy !== "static") elapsedSeconds += deltaSeconds;

      const target = targetRef.current;
      const blend = policy === "static" ? 1 : 1 - Math.exp(-deltaSeconds / PHASE_EASE_SECONDS);
      current.energy += (target.energy - current.energy) * blend;
      current.accent[0] += (target.accent[0] - current.accent[0]) * blend;
      current.accent[1] += (target.accent[1] - current.accent[1]) * blend;
      current.accent[2] += (target.accent[2] - current.accent[2]) * blend;
      const voiceTarget = Math.min(1, Math.max(0, activityLevel?.current ?? 0));
      const voiceEaseSeconds = voiceTarget > current.voice ? 0.09 : 0.52;
      const voiceBlend = policy === "static" ? 1 : 1 - Math.exp(-deltaSeconds / voiceEaseSeconds);
      current.voice += (voiceTarget - current.voice) * voiceBlend;

      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(displayAspectLocation, displayAspect);
      gl.uniform1f(timeLocation, elapsedSeconds);
      gl.uniform3fv(accentLocation, current.accent);
      gl.uniform1f(energyLocation, current.energy);
      gl.uniform1f(voiceLocation, current.voice);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frameDirty = false;
    };

    const requestDraw = (delayMs = 0) => {
      if (animationTimer) return;
      animationTimer = window.setTimeout(draw, delayMs);
    };

    const scheduleFollowingFrame = (policy: VoicePresenceRenderPolicy) => {
      const interval = voicePresenceFrameInterval(policy);
      if (interval === null) return;
      requestDraw(interval);
    };

    const draw = () => {
      animationTimer = 0;
      const now = performance.now();
      const policy = currentPolicy();
      publishPolicy(policy);
      if (policy === "paused" || (policy === "static" && !frameDirty)) return;

      if (policy === "active" || policy === "degraded") {
        if (lastAnimationTick > 0) {
          performanceState = nextVoicePresencePerformanceState(
            performanceState,
            now - lastAnimationTick,
            voicePresenceFrameInterval(policy) ?? 0,
          );
        }
        lastAnimationTick = now;
      } else {
        lastAnimationTick = 0;
        performanceState = INITIAL_VOICE_PRESENCE_PERFORMANCE_STATE;
      }

      const latestPolicy = currentPolicy();
      drawMaterial(now, latestPolicy);
      publishPolicy(latestPolicy);
      scheduleFollowingFrame(latestPolicy);
    };

    const invalidate = () => {
      frameDirty = true;
      cancelScheduledFrame();
      requestDraw();
    };

    const handleVisibilityChange = () => {
      documentVisible = document.visibilityState === "visible";
      previousTime = performance.now();
      lastAnimationTick = 0;
      performanceState = INITIAL_VOICE_PRESENCE_PERFORMANCE_STATE;
      if (documentVisible) invalidate();
      else {
        cancelScheduledFrame();
        publishPolicy("paused");
      }
    };

    const measureLayout = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      displayAspect = width / height;
      invalidate();
    };

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) measureLayout(entry.contentRect.width, entry.contentRect.height);
    });
    resizeObserver.observe(canvas);
    measureLayout(canvas.clientWidth, canvas.clientHeight);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    reducedMotion.addEventListener("change", invalidate);
    invalidateRef.current = invalidate;
    invalidate();

    return () => {
      invalidateRef.current = null;
      cancelScheduledFrame();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      reducedMotion.removeEventListener("change", invalidate);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  useEffect(() => {
    invalidateRef.current?.();
  }, [phase, presented]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute inset-0 size-full bg-background transition-opacity duration-500 ${className ?? ""}`}
      aria-hidden="true"
    />
  );
}
