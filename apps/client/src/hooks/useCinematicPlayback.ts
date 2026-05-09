import { useCallback, useEffect, useRef, useState } from "react";

export type PlaybackState = "idle" | "playing" | "paused" | "finished";
export type PlaybackSpeed = 0.5 | 1 | 1.5 | 2;

interface Options {
  defaultFrameMs?: number;
  onFinish?: () => void;
}

export interface PlaybackApi {
  state: PlaybackState;
  currentIndex: number;
  speed: PlaybackSpeed;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (i: number) => void;
  restart: () => void;
  setSpeed: (s: PlaybackSpeed) => void;
}

/**
 * Playback state machine for the cinematic reel.
 * Uses a chained setTimeout so speed changes take effect on the next tick.
 */
export function useCinematicPlayback(
  frameCount: number,
  { defaultFrameMs = 2800, onFinish }: Options = {}
): PlaybackApi {
  const [state, setState] = useState<PlaybackState>("idle");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  const timerRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  const indexRef = useRef(currentIndex);
  const speedRef = useRef(speed);
  const onFinishRef = useRef(onFinish);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { indexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { onFinishRef.current = onFinish; }, [onFinish]);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const scheduleNext = useCallback(() => {
    clearTimer();
    const effectiveMs = defaultFrameMs / speedRef.current;
    timerRef.current = window.setTimeout(() => {
      if (stateRef.current !== "playing") return;
      const nextIndex = indexRef.current + 1;
      if (nextIndex >= frameCount) {
        setState("finished");
        onFinishRef.current?.();
        return;
      }
      setCurrentIndex(nextIndex);
      scheduleNext();
    }, effectiveMs);
  }, [defaultFrameMs, frameCount]);

  const play = useCallback(() => {
    if (frameCount === 0) return;
    // if finished, restart from 0
    if (stateRef.current === "finished") {
      setCurrentIndex(0);
    }
    setState("playing");
  }, [frameCount]);

  const pause = useCallback(() => {
    clearTimer();
    setState("paused");
  }, []);

  const toggle = useCallback(() => {
    if (stateRef.current === "playing") pause();
    else play();
  }, [pause, play]);

  const next = useCallback(() => {
    clearTimer();
    setCurrentIndex((i) => Math.min(frameCount - 1, i + 1));
    if (stateRef.current === "playing") {
      // re-arm timer at new position
      setTimeout(scheduleNext, 0);
    }
  }, [frameCount, scheduleNext]);

  const prev = useCallback(() => {
    clearTimer();
    setCurrentIndex((i) => Math.max(0, i - 1));
    if (stateRef.current === "playing") {
      setTimeout(scheduleNext, 0);
    }
  }, [scheduleNext]);

  const seek = useCallback((i: number) => {
    clearTimer();
    const clamped = Math.max(0, Math.min(frameCount - 1, i));
    setCurrentIndex(clamped);
    if (stateRef.current === "playing") {
      setTimeout(scheduleNext, 0);
    } else if (stateRef.current === "finished") {
      setState("paused");
    }
  }, [frameCount, scheduleNext]);

  const restart = useCallback(() => {
    clearTimer();
    setCurrentIndex(0);
    setState("playing");
  }, []);

  // drive the timer whenever state/speed changes
  useEffect(() => {
    if (state === "playing") {
      scheduleNext();
    } else {
      clearTimer();
    }
    return clearTimer;
  }, [state, speed, scheduleNext]);

  // keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle, next, prev]);

  return {
    state,
    currentIndex,
    speed,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    restart,
    setSpeed,
  };
}
