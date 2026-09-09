/**
 * Generates original sample Reels locally with ffmpeg (gradients + shapes + tone).
 * Output: packages/core/samples/*.mp4 plus one intentionally invalid file.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ffmpegPath } from "../services/media";

const execFileP = promisify(execFile);
export const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../samples");

const PALETTES = [
  ["#e8552a", "#2a4be8"], ["#1f8a70", "#f6d55c"], ["#3d1e6d", "#ed5565"], ["#0b3d91", "#48c9b0"], ["#ff8c42", "#6a0572"],
  ["#2b2d42", "#ef233c"], ["#006d77", "#ffddd2"], ["#7b2cbf", "#c77dff"], ["#264653", "#e9c46a"], ["#8d99ae", "#d90429"],
  ["#00a896", "#f0f3bd"], ["#ff006e", "#8338ec"], ["#3a86ff", "#ffbe0b"], ["#fb5607", "#023047"], ["#5f0f40", "#fb8b24"],
  ["#0f4c5c", "#e36414"], ["#9a031e", "#5f0f40"], ["#4361ee", "#4cc9f0"], ["#f72585", "#3a0ca3"], ["#2d6a4f", "#95d5b2"],
];

export type SampleSpec = { name: string; seconds: number; width: number; height: number; palette: [string, string]; boxes: number; tone: number };

export function sampleSpecs(count = 36): SampleSpec[] {
  const out: SampleSpec[] = [];
  for (let i = 0; i < count; i++) {
    const p = PALETTES[i % PALETTES.length]!;
    const portrait = i % 7 !== 6;
    out.push({ name: `sample-${String(i + 1).padStart(2, "0")}.mp4`, seconds: 3 + (i % 4), width: portrait ? 540 : 960, height: portrait ? 960 : 540, palette: [p[0]!, p[1]!], boxes: 1 + (i % 3), tone: 220 + (i * 37) % 400 });
  }
  return out;
}

export async function generateSample(spec: SampleSpec, dir = SAMPLES_DIR): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, spec.name);
  const boxes: string[] = [];
  for (let b = 0; b < spec.boxes; b++) {
    const w = Math.round(spec.width * (0.25 + b * 0.15));
    const h = Math.round(spec.height * (0.12 + b * 0.05));
    boxes.push(`drawbox=x=(iw-${w})/2:y=(ih-${h})/2+${b * 60 - 60}:w=${w}:h=${h}:color=white@${(0.7 - b * 0.2).toFixed(2)}:t=fill`);
  }
  await execFileP(ffmpegPath(), [
    "-y", "-v", "error", "-threads", "1",
    "-f", "lavfi", "-i", `gradients=s=${spec.width}x${spec.height}:d=${spec.seconds}:c0=${spec.palette[0]}:c1=${spec.palette[1]}:speed=0.05:nb_colors=2`,
    "-f", "lavfi", "-i", `sine=frequency=${spec.tone}:duration=${spec.seconds}`,
    "-vf", boxes.join(","),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", target,
  ], { timeout: 60_000 });
  return target;
}

export async function generateAllSamples(dir = SAMPLES_DIR, count = 36): Promise<string[]> {
  const files: string[] = [];
  for (const spec of sampleSpecs(count)) {
    const target = path.join(dir, spec.name);
    const exists = await fs.stat(target).then((s) => s.size > 0).catch(() => false);
    if (!exists) await generateSample(spec, dir);
    files.push(target);
  }
  // Intentionally invalid files: a text file with a video extension, and a truncated video.
  const bogus = path.join(dir, "not-a-video.mp4");
  await fs.writeFile(bogus, "This is not a video. It only has the .mp4 extension.\n");
  const truncated = path.join(dir, "truncated-upload.mp4");
  const src = await fs.readFile(files[0]!);
  await fs.writeFile(truncated, src.subarray(0, 4096));
  return files;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  generateAllSamples()
    .then((f) => {
      console.log(`Generated ${f.length} sample videos in ${SAMPLES_DIR}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
