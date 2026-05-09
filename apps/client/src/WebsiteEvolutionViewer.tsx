"use client";

import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { motion, AnimatePresence } from "framer-motion";
import { Film, Play, AlertCircle } from "lucide-react";

import { CinematicStage } from "@/components/evolution/CinematicStage";
import { CaptureProgress } from "@/components/evolution/CaptureProgress";
import { buildFrames } from "@/components/evolution/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const formSchema = z
  .object({
    url: z.string().url({ message: "Please enter a valid URL" }),
    startYear: z.number().min(1900).max(new Date().getFullYear()),
    endYear: z.number().min(1900).max(new Date().getFullYear()),
    outputFileName: z
      .string()
      .min(1, { message: "Output file name is required" })
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/, {
        message: "Letters, numbers, dashes and underscores only",
      }),
    // On → PNG (default, lossless but large).
    // Off → JPEG q=80 (~10× smaller, slight compression artifacts).
    highQuality: z.boolean().default(true),
  })
  .refine((v) => v.endYear >= v.startYear, {
    message: "End year must be ≥ start year",
    path: ["endYear"],
  });

type FormValues = z.infer<typeof formSchema>;

const currentYear = new Date().getFullYear();
const years = Array.from(
  { length: currentYear - 1899 },
  (_, i) => currentYear - i
);

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/+$/,
    ""
  ) || "";

// Where images actually live. Server uploads to MinIO under
// <bucket>/<outputFileName>/<i>.png; preview/demo modes build the same
// URL directly so they don't need a live capture.
const IMAGES_BASE_URL = (
  (import.meta.env.VITE_IMAGES_BASE_URL as string | undefined) ||
  "http://localhost:9000/webrewind"
).replace(/\/+$/, "");

/**
 * Optional preview mode for inspecting an already-captured folder without
 * re-running the pipeline. Activated via URL params, e.g.:
 *   /?preview=apyhub7&count=6&from=2019&to=2025&url=apyhub.com
 * Images are fetched directly from MinIO at <bucket>/<name>/<n>.png.
 */
function readPreviewConfig(): {
  images: string[];
  startYear: number;
  endYear: number;
  url: string;
  outputFileName: string;
} | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const name = params.get("preview");
  if (!name) return null;

  const now = new Date().getFullYear();
  const count = clampInt(params.get("count"), 1, 200, 6);
  const startYear = clampInt(params.get("from"), 1900, now, now - 5);
  const endYear = clampInt(params.get("to"), startYear, now, now);
  const urlInput = params.get("url") ?? `https://${name}`;
  const url = /^https?:\/\//i.test(urlInput) ? urlInput : `https://${urlInput}`;

  const images = Array.from(
    { length: count },
    (_, i) => `${IMAGES_BASE_URL}/${name}/${i}.png`
  );

  return { images, startYear, endYear, url, outputFileName: name };
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number
): number {
  const n = raw == null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export default function WebsiteEvolutionViewer() {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [evolutionImages, setEvolutionImages] = useState<string[]>([]);
  const [stageOpen, setStageOpen] = useState(false);
  const [submittedValues, setSubmittedValues] = useState<FormValues | null>(
    null
  );
  // flips true the instant the response arrives — lets CaptureProgress snap to 100
  const [finalizing, setFinalizing] = useState(false);
  // Live progress from SSE stream.
  const [captured, setCaptured] = useState(0);
  const [totalCaptures, setTotalCaptures] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [phase, setPhase] = useState<string | null>(null);
  // Active job id — lets the user cancel. Cleared on any terminal SSE event.
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Sliding window of the most recently captured thumbnails, for the progress
  // strip. Bounded to THUMB_WINDOW to keep the DOM small on long captures.
  const [capturedFrames, setCapturedFrames] = useState<
    { index: number; imageUrl: string; timestamp?: string }[]
  >([]);

  // Hold the current EventSource + a mounted flag so we can:
  //  • close a leftover stream when the user resubmits mid-capture
  //  • cancel pending setTimeouts on unmount
  //  • ignore late events after the component unmounts
  const eventSourceRef = useRef<EventSource | null>(null);
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (finalizeTimerRef.current) {
        clearTimeout(finalizeTimerRef.current);
        finalizeTimerRef.current = null;
      }
    };
  }, []);

  // Preview mode: /?preview=<name>&count=<N>&from=<Y>&to=<Y>&url=<host>
  useEffect(() => {
    const cfg = readPreviewConfig();
    if (!cfg) return;
    setEvolutionImages(cfg.images);
    setSubmittedValues({
      url: cfg.url,
      startYear: cfg.startYear,
      endYear: cfg.endYear,
      outputFileName: cfg.outputFileName,
      highQuality: true,
    });
    setStageOpen(true);
  }, []);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      url: "",
      startYear: currentYear - 5,
      endYear: currentYear,
      outputFileName: "website_evolution",
      highQuality: true,
    },
  });

  const watchedValues = form.watch();

  const openApyhubPreview = () => {
    const now = new Date().getFullYear();
    const images = Array.from(
      { length: 6 },
      (_, i) => `${IMAGES_BASE_URL}/apyhub7/${i}.png`
    );
    setEvolutionImages(images);
    setSubmittedValues({
      url: "https://apyhub.com",
      startYear: now - 5,
      endYear: now,
      outputFileName: "apyhub7",
      highQuality: true,
    });
    setStageOpen(true);
  };

  const onSubmit = async (values: FormValues) => {
    // Close any leftover stream from a previous submission.
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }

    setIsLoading(true);
    setFinalizing(false);
    setErrorMessage(null);
    setSubmittedValues(values);
    setCaptured(0);
    setTotalCaptures(0);
    setSkipped(0);
    setPhase("starting");
    setCurrentJobId(null);
    setCancelling(false);
    setCapturedFrames([]);
    try {
      // Translate the form's user-facing `highQuality` boolean into the
      // server's `format` field. We omit `highQuality` itself since the
      // server doesn't accept it.
      const { highQuality, ...rest } = values;
      const payload = {
        ...rest,
        format: highQuality ? "png" : "jpeg",
      };
      const response = await fetch(`${API_BASE_URL}/screenshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      // Read the request ID the server echoes back so users can cite it when
      // asking for help. Best-effort — some proxies strip custom headers.
      const reqId = response.headers.get("X-Request-Id");
      if (!response.ok) {
        const detail = Array.isArray(data?.details)
          ? `: ${data.details.join(", ")}`
          : "";
        const ref = reqId ? ` (ref: ${reqId})` : "";
        throw new Error(
          `${data?.error || `Request failed (${response.status})`}${detail}${ref}`
        );
      }
      const jobId: string | undefined = data.jobId;
      if (!jobId) {
        throw new Error("Server did not return a jobId");
      }

      setCurrentJobId(jobId);
      await subscribeToJob(jobId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Error starting capture job:", error);
      setErrorMessage(msg);
      setEvolutionImages([]);
      setIsLoading(false);
      setFinalizing(false);
      setCurrentJobId(null);
      setCancelling(false);
    }
  };

  const onCancel = async () => {
    if (!currentJobId || cancelling) return;
    setCancelling(true);
    try {
      const res = await fetch(
        `${API_BASE_URL}/screenshots/${currentJobId}`,
        { method: "DELETE" }
      );
      if (!res.ok && res.status !== 404 && res.status !== 409) {
        setCancelling(false);
      }
      // The SSE stream will deliver the terminal `cancelled` event and reset
      // UI state. 404/409 both mean the job is already gone — also fine.
    } catch {
      // Network failure — stream will decide. Leave cancelling true so the
      // button stays disabled briefly.
    }
  };

  /** Opens an EventSource against /screenshots/events/:jobId and resolves
   *  when the stream emits `done` or `error`. Handles:
   *   • late events after unmount (guarded by mountedRef)
   *   • superseded jobs (ignore events if es is no longer current)
   *   • initial connection failures (CONNECTING → CLOSED without a message)
   */
  const subscribeToJob = (jobId: string) =>
    new Promise<void>((resolve) => {
      const streamUrl = `${API_BASE_URL}/screenshots/events/${jobId}`;
      const es = new EventSource(streamUrl);
      eventSourceRef.current = es;

      let settled = false;

      const isCurrent = () =>
        eventSourceRef.current === es && mountedRef.current;

      const finish = () => {
        if (settled) return;
        settled = true;
        es.close();
        if (eventSourceRef.current === es) eventSourceRef.current = null;
        resolve();
      };

      // Safety net: if we never get the stream open AND never a message for
      // 30s after the first error, treat it as fatal. Without this the
      // browser will reconnect forever if the server URL is wrong.
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

      es.onmessage = (ev) => {
        if (!isCurrent()) {
          es.close();
          return;
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        let msg: {
          type: string;
          total?: number;
          index?: number;
          images?: string[];
          gif?: string | null;
          count?: number;
          message?: string;
          phase?: string;
          imageUrl?: string;
          timestamp?: string;
        };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        switch (msg.type) {
          case "phase":
            if (msg.phase) setPhase(msg.phase);
            break;
          case "urls":
            if (typeof msg.total === "number") setTotalCaptures(msg.total);
            break;
          case "capture:done":
            setCaptured((c) => c + 1);
            if (msg.imageUrl && typeof msg.index === "number") {
              const frameIdx = msg.index;
              const frameUrl = msg.imageUrl;
              const frameTs = msg.timestamp;
              // Sliding window — drop the oldest once we exceed THUMB_WINDOW
              // so very long captures don't inflate the DOM.
              setCapturedFrames((prev) => {
                const next = prev.filter((f) => f.index !== frameIdx);
                next.push({
                  index: frameIdx,
                  imageUrl: frameUrl,
                  timestamp: frameTs,
                });
                next.sort((a, b) => a.index - b.index);
                const THUMB_WINDOW = 20;
                return next.length > THUMB_WINDOW
                  ? next.slice(next.length - THUMB_WINDOW)
                  : next;
              });
            }
            break;
          case "capture:skip":
            // Count skipped frames toward progress so the bar doesn't stall,
            // but also surface them separately so users see partial failures.
            setCaptured((c) => c + 1);
            setSkipped((s) => s + 1);
            break;
          case "done":
            if (Array.isArray(msg.images) && msg.images.length > 0) {
              setFinalizing(true);
              setPhase(null);
              setEvolutionImages(msg.images);
              finalizeTimerRef.current = setTimeout(() => {
                if (!mountedRef.current) return;
                setStageOpen(true);
                setIsLoading(false);
                finalizeTimerRef.current = null;
              }, 700);
            } else {
              setErrorMessage("No images returned for this range");
              setIsLoading(false);
              setFinalizing(false);
            }
            setCurrentJobId(null);
            setCancelling(false);
            finish();
            break;
          case "error":
            setErrorMessage(msg.message || "Capture failed");
            setEvolutionImages([]);
            setIsLoading(false);
            setFinalizing(false);
            setCurrentJobId(null);
            setCancelling(false);
            finish();
            break;
          case "cancelled":
            setErrorMessage(null);
            setEvolutionImages([]);
            setIsLoading(false);
            setFinalizing(false);
            setPhase(null);
            setCurrentJobId(null);
            setCancelling(false);
            finish();
            break;
          default:
            break;
        }
      };

      es.onerror = () => {
        if (!isCurrent()) {
          es.close();
          return;
        }
        // If the browser closed the connection permanently, treat it as fatal.
        if (es.readyState === EventSource.CLOSED) {
          setErrorMessage((prev) => prev || "Connection to server lost");
          setIsLoading(false);
          setFinalizing(false);
          finish();
          return;
        }
        // Still connecting/reconnecting — give it 30s, then bail.
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            if (!isCurrent()) return;
            setErrorMessage(
              (prev) => prev || "Unable to reach progress stream"
            );
            setIsLoading(false);
            setFinalizing(false);
            finish();
          }, 30000);
        }
      };
    });

  const yearSpan = Math.max(
    1,
    (watchedValues.endYear || currentYear) -
      (watchedValues.startYear || currentYear - 5) +
      1
  );

  const showLoadingScreen = isLoading && submittedValues !== null;

  return (
    <div className="w-full">
      <AnimatePresence mode="wait">
        {showLoadingScreen ? (
          <LoadingScreen
            key="loading"
            url={submittedValues!.url}
            startYear={submittedValues!.startYear}
            endYear={submittedValues!.endYear}
            finalizing={finalizing}
            captured={captured}
            total={totalCaptures}
            skipped={skipped}
            phase={phase}
            capturedFrames={capturedFrames}
            onCancel={currentJobId ? onCancel : undefined}
            cancelling={cancelling}
          />
        ) : (
          <motion.div
            key="form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="w-full grid grid-cols-1 lg:grid-cols-[1.15fr_minmax(0,1fr)] items-stretch"
          >
      {/* Hero column */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="relative flex flex-col justify-between px-8 lg:px-20 py-12 lg:py-16 gap-12 overflow-hidden"
        style={{
          borderRight: "1px solid rgba(139,106,61,0.18)",
          minHeight: "calc(100vh - 9rem)",
        }}
      >
        {/* Decorative faint year column */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-4 top-0 bottom-0 w-px"
          style={{
            background:
              "linear-gradient(to bottom, transparent, rgba(212,162,76,0.25), transparent)",
          }}
        />
        <div className="relative z-10 space-y-10 max-w-2xl">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-10 h-10 rounded-sm"
              style={{
                background: "rgba(212,162,76,0.12)",
                border: "1px solid rgba(212,162,76,0.4)",
              }}
            >
              <Film size={18} style={{ color: "var(--reel-amber)" }} />
            </div>
            <span className="text-[10px] uppercase tracking-[0.4em] opacity-60 font-serif">
              A reel of the web
            </span>
          </div>

          <h1
            className="font-serif leading-[1.02] tracking-tight"
            style={{
              fontSize: "clamp(2.8rem, 7.2vw, 6rem)",
              color: "var(--reel-paper)",
            }}
          >
            Travel through
            <br />
            <span style={{ color: "var(--reel-amber)" }}>time</span>, frame by frame.
          </h1>

          <p
            className="font-serif text-lg leading-relaxed max-w-xl"
            style={{ color: "rgba(244,234,213,0.75)" }}
          >
            Pick any URL and a range of years — we'll pull snapshots from the
            Wayback Machine and assemble a cinematic reel of how the site has
            evolved.
          </p>

          <div className="flex flex-wrap gap-8 text-[11px] uppercase tracking-[0.3em] font-serif opacity-70 pt-2">
            <Stat label="Capturing" value={`${yearSpan} year${yearSpan === 1 ? "" : "s"}`} />
            <Stat label="Source" value="Wayback Machine" />
            <Stat label="Format" value="Cinematic reel" />
          </div>
        </div>

        {/* Film-strip decoration at hero bottom */}
        <FilmStrip
          startYear={watchedValues.startYear || currentYear - 5}
          endYear={watchedValues.endYear || currentYear}
        />
      </motion.div>

      {/* Form column */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
        className="w-full flex flex-col justify-center px-8 lg:px-16 py-12 lg:py-16"
        style={{ minHeight: "calc(100vh - 9rem)" }}
      >
        <div
          className="rounded-lg p-7 space-y-6"
          style={{
            background: "var(--reel-bg-soft)",
            border: "1px solid rgba(139,106,61,0.35)",
            boxShadow:
              "0 40px 100px rgba(0,0,0,0.45), 0 0 0 1px rgba(244,234,213,0.02) inset",
          }}
        >
          <div className="flex items-baseline justify-between">
            <h2
              className="font-serif text-lg"
              style={{ color: "var(--reel-paper)" }}
            >
              Start your reel
            </h2>
            <span className="text-[10px] uppercase tracking-[0.3em] opacity-50 font-serif">
              Step 1 of 1
            </span>
          </div>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-5"
            >
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel className="text-[10px] uppercase tracking-[0.3em] opacity-70 font-serif">
                      URL
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="https://example.com"
                        className="h-11 bg-transparent border-[rgba(139,106,61,0.4)] focus-visible:ring-[var(--reel-amber)]/50 focus-visible:border-[var(--reel-amber)]/70 font-serif"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="startYear"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-[10px] uppercase tracking-[0.3em] opacity-70 font-serif">
                        From
                      </FormLabel>
                      <Select
                        onValueChange={(v) => field.onChange(parseInt(v))}
                        defaultValue={field.value.toString()}
                      >
                        <FormControl>
                          <SelectTrigger className="h-11 bg-transparent border-[rgba(139,106,61,0.4)] font-serif">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-64">
                          {years.map((y) => (
                            <SelectItem key={y} value={y.toString()}>
                              {y}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="endYear"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-[10px] uppercase tracking-[0.3em] opacity-70 font-serif">
                        To
                      </FormLabel>
                      <Select
                        onValueChange={(v) => field.onChange(parseInt(v))}
                        defaultValue={field.value.toString()}
                      >
                        <FormControl>
                          <SelectTrigger className="h-11 bg-transparent border-[rgba(139,106,61,0.4)] font-serif">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-64">
                          {years.map((y) => (
                            <SelectItem key={y} value={y.toString()}>
                              {y}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="outputFileName"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel className="text-[10px] uppercase tracking-[0.3em] opacity-70 font-serif">
                      Output name
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="website_evolution"
                        className="h-11 bg-transparent border-[rgba(139,106,61,0.4)] focus-visible:ring-[var(--reel-amber)]/50 focus-visible:border-[var(--reel-amber)]/70 font-serif"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="highQuality"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-3">
                    <FormControl>
                      <input
                        type="checkbox"
                        checked={field.value}
                        onChange={(e) => field.onChange(e.target.checked)}
                        className="h-4 w-4 accent-[var(--reel-amber)] cursor-pointer"
                      />
                    </FormControl>
                    <FormLabel className="text-[11px] uppercase tracking-[0.25em] opacity-75 font-serif cursor-pointer m-0">
                      High quality (PNG) — off uses JPEG, ~10× smaller
                    </FormLabel>
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-11 font-serif text-sm tracking-[0.2em] uppercase"
                style={{
                  background: "var(--reel-amber)",
                  color: "var(--reel-bg)",
                  border: "none",
                }}
              >
                {isLoading ? "Rewinding…" : "Start rewinding"}
              </Button>

              <button
                type="button"
                onClick={openApyhubPreview}
                className="w-full text-[10px] uppercase tracking-[0.3em] font-serif opacity-50 hover:opacity-90 transition-opacity pt-1"
                style={{ color: "var(--reel-paper)" }}
              >
                ▸ preview an existing reel (apyhub7 · 6 frames)
              </button>
            </form>
          </Form>
        </div>

        {/* Error */}
        <AnimatePresence>
          {errorMessage && !isLoading && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              role="alert"
              className="mt-4 rounded-md p-3 text-sm flex gap-2 items-start"
              style={{
                background: "rgba(194, 60, 60, 0.08)",
                border: "1px solid rgba(194, 60, 60, 0.35)",
                color: "#ffb8b0",
              }}
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span className="font-serif">{errorMessage}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Replay — shown when stage was closed but images still available */}
        {evolutionImages.length > 0 && !stageOpen && !isLoading && submittedValues && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="mt-4 flex justify-center"
          >
            <button
              onClick={() => setStageOpen(true)}
              className="flex items-center gap-2 px-5 h-10 rounded-sm font-serif text-sm tracking-[0.15em] uppercase transition-colors"
              style={{
                color: "var(--reel-paper)",
                background: "transparent",
                border: "1px solid rgba(212,162,76,0.5)",
              }}
            >
              <Play size={14} fill="currentColor" />
              Replay reel
            </button>
          </motion.div>
        )}
      </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cinematic stage portal */}
      <AnimatePresence>
        {stageOpen && evolutionImages.length > 0 && submittedValues && (
          <CinematicStage
            frames={buildFrames(
              evolutionImages,
              submittedValues.startYear,
              submittedValues.endYear
            )}
            url={submittedValues.url}
            startYear={submittedValues.startYear}
            endYear={submittedValues.endYear}
            onClose={() => setStageOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function LoadingScreen({
  url,
  startYear,
  endYear,
  finalizing,
  captured,
  total,
  skipped,
  phase,
  capturedFrames,
  onCancel,
  cancelling,
}: {
  url: string;
  startYear: number;
  endYear: number;
  finalizing: boolean;
  captured: number;
  total: number;
  skipped: number;
  phase: string | null;
  capturedFrames: { index: number; imageUrl: string; timestamp?: string }[];
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const prettyUrl = (() => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return url;
    }
  })();

  const headline = finalizing
    ? "Assembling the reel…"
    : phase === "encoding-gif"
    ? "Developing the film…"
    : phase === "fetching-urls"
    ? "Asking Wayback for snapshots…"
    : phase === "starting" || phase == null
    ? "Warming up the projector…"
    : `Rewinding ${prettyUrl}`;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="relative w-full flex flex-col items-center justify-center px-8 py-16"
      style={{ minHeight: "calc(100vh - 9rem)" }}
    >
      {/* Ambient radial glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(212,162,76,0.08), transparent 60%)",
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-3xl flex flex-col items-center gap-10"
      >
        {/* Context */}
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-sm"
            style={{
              background: "rgba(212,162,76,0.12)",
              border: "1px solid rgba(212,162,76,0.4)",
            }}
          >
            <Film size={18} style={{ color: "var(--reel-amber)" }} />
          </div>
          <span className="text-[10px] uppercase tracking-[0.4em] opacity-60 font-serif">
            {prettyUrl} · {startYear}–{endYear}
          </span>
        </div>

        {/* Phase-driven headline */}
        <motion.h1
          key={headline}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="font-serif leading-[1.05] tracking-tight text-center"
          style={{
            fontSize: "clamp(2.2rem, 5.6vw, 4.2rem)",
            color: "var(--reel-paper)",
          }}
        >
          {headline.split(/(\s)/).map((part, i) =>
            /\s/.test(part) ? (
              part
            ) : (
              <span
                key={i}
                style={{
                  color:
                    i === headline.split(/(\s)/).length - 1
                      ? "var(--reel-amber)"
                      : undefined,
                }}
              >
                {part}
              </span>
            )
          )}
        </motion.h1>

        {/* Full-width progress card */}
        <div className="w-full">
          <CaptureProgress
            startYear={startYear}
            endYear={endYear}
            url={url}
            finalizing={finalizing}
            captured={captured}
            total={total}
            skipped={skipped}
            phase={phase}
            capturedFrames={capturedFrames}
          />
        </div>

        {/* Sub-caption */}
        <p
          className="font-serif text-sm text-center max-w-xl"
          style={{ color: "rgba(244,234,213,0.55)" }}
        >
          Sit tight — we're pulling archived snapshots from the Wayback Machine
          and developing them into a cinematic reel. The stage will open the
          moment the final frame lands.
        </p>

        {/* Cancel control — hidden once finalizing (GIF encode is fast, and
            the result folder already has every frame). */}
        {onCancel && !finalizing && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="font-serif text-xs uppercase tracking-[0.35em] px-4 py-2 rounded-sm transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              color: "var(--reel-paper)",
              background: "transparent",
              border: "1px solid rgba(139,106,61,0.45)",
            }}
          >
            {cancelling ? "Cancelling…" : "Cancel capture"}
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="opacity-60">{label}</span>
      <span style={{ color: "var(--reel-paper)" }}>{value}</span>
    </div>
  );
}

function FilmStrip({
  startYear,
  endYear,
}: {
  startYear: number;
  endYear: number;
}) {
  const span = Math.max(1, endYear - startYear + 1);
  const frameCount = Math.min(12, span);
  const frames = Array.from({ length: frameCount }, (_, i) => {
    const divisor = Math.max(1, frameCount - 1);
    return Math.round(startYear + (i / divisor) * (span - 1));
  });

  return (
    <div className="relative z-10 w-full pt-6">
      <div className="flex items-center gap-3 mb-3 text-[10px] uppercase tracking-[0.4em] opacity-40 font-serif">
        <span>Reel preview</span>
        <span
          className="flex-1 h-px"
          style={{ background: "rgba(139,106,61,0.25)" }}
        />
      </div>
      <div
        className="flex gap-1.5 py-2 overflow-hidden"
        style={{
          borderTop: "1px dashed rgba(139,106,61,0.4)",
          borderBottom: "1px dashed rgba(139,106,61,0.4)",
        }}
      >
        {frames.map((year, i) => (
          <motion.div
            key={`${year}-${i}`}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3 + i * 0.04, duration: 0.4 }}
            className="relative flex-1 aspect-[16/10] min-w-0 flex items-end justify-start p-1.5"
            style={{
              background:
                "linear-gradient(135deg, rgba(212,162,76,0.08), rgba(139,106,61,0.02))",
              border: "1px solid rgba(139,106,61,0.25)",
            }}
          >
            <span
              className="font-serif text-[10px] opacity-60"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {year}
            </span>
            {/* faint bars simulating page content */}
            <div className="absolute top-2 left-2 right-2 flex flex-col gap-0.5">
              <span
                className="h-px"
                style={{ background: "rgba(244,234,213,0.2)", width: "60%" }}
              />
              <span
                className="h-px"
                style={{ background: "rgba(244,234,213,0.1)", width: "40%" }}
              />
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
