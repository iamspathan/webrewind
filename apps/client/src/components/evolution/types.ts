export interface Frame {
  url: string;
  year: number;
  index: number;
}

export function buildFrames(
  images: string[],
  startYear: number,
  endYear: number
): Frame[] {
  const span = Math.max(1, endYear - startYear);
  const divisor = Math.max(1, images.length - 1);
  return images.map((url, i) => ({
    url,
    index: i,
    year: Math.round(startYear + (i / divisor) * span),
  }));
}
