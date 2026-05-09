// Frames are a discriminated union so the UI can tell the difference
// between an exact Wayback timestamp (fresh capture or cache-hit with
// preserved metadata) and a best-guess year interpolation (legacy cache
// entries + preview flows where the server only sent us image URLs).
//
// The rail, cards, and source links all narrow on `kind` instead of
// checking a nullable `timestamp` field in ten places.

export type Frame =
  | {
      kind: "exact";
      index: number;
      url: string;
      /** Wayback timestamp: 14-char YYYYMMDDhhmmss. */
      timestamp: string;
      year: number;
    }
  | {
      kind: "approx";
      index: number;
      url: string;
      year: number;
    };

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Human label for a card header. Exact timestamps get "March 2023";
 * approximations get "~2023" so the user can tell they're interpolated.
 */
export function formatLabel(frame: Frame): string {
  if (frame.kind === "exact") {
    const month = Number(frame.timestamp.slice(4, 6));
    if (month >= 1 && month <= 12) {
      return `${MONTHS[month - 1]} ${frame.year}`;
    }
    return String(frame.year);
  }
  return `~${frame.year}`;
}

/**
 * Wayback snapshot link. Only meaningful for exact frames — approximate
 * frames don't know which capture they came from.
 */
export function waybackSourceUrl(
  frame: Frame,
  originalUrl: string
): string | null {
  if (frame.kind !== "exact") return null;
  return `https://web.archive.org/web/${frame.timestamp}/${originalUrl}`;
}

/**
 * Fallback builder used when we only have image URLs (legacy cache hits,
 * preview mode pre-server-schema-bump). Years are linearly interpolated.
 */
export function buildFrames(
  images: string[],
  startYear: number,
  endYear: number
): Frame[] {
  const span = Math.max(1, endYear - startYear);
  const divisor = Math.max(1, images.length - 1);
  return images.map((url, i) => ({
    kind: "approx" as const,
    url,
    index: i,
    year: Math.round(startYear + (i / divisor) * span),
  }));
}

/**
 * Preferred builder when the server (or live SSE stream) has given us
 * timestamps aligned 1:1 with images. Any slot missing a timestamp
 * degrades to an `approx` entry so a partially-populated response still
 * renders cleanly.
 */
export function buildFramesFromManifest(
  images: string[],
  timestamps: (string | undefined | null)[],
  startYear: number,
  endYear: number
): Frame[] {
  const span = Math.max(1, endYear - startYear);
  const divisor = Math.max(1, images.length - 1);
  return images.map((url, i) => {
    const ts = timestamps[i];
    if (ts && /^\d{14}$/.test(ts)) {
      return {
        kind: "exact" as const,
        index: i,
        url,
        timestamp: ts,
        year: Number(ts.slice(0, 4)),
      };
    }
    return {
      kind: "approx" as const,
      index: i,
      url,
      year: Math.round(startYear + (i / divisor) * span),
    };
  });
}
