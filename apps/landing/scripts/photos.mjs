/* global console, process, URL */
// Grades the licensed originals in assets/photos/ to the AgentBox palette and encodes
// AVIF + WebP + JPEG at 640/1280/2048 px wide into public/img/ (generated, git-ignored).
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}public/img`;
await mkdir(out, { recursive: true });

// grade: brightness/saturation + a cool shift so every photo sits in the Night palette.
const specs = [
  {
    name: "saigon",
    src: "14-saigon-river-skyline-night-anhphan.jpg",
    brightness: 0.82,
    saturation: 0.95,
  },
  {
    name: "saigon-portrait",
    src: "15-saigon-river-skyline-portrait-pexels-onon.jpg",
    brightness: 0.72,
    saturation: 0.9,
  },
  { name: "aurora", src: "13-aurora-borealis-goerend.jpg", brightness: 0.62, saturation: 0.95 },
  {
    name: "aurora-wide",
    src: "13-aurora-borealis-goerend.jpg",
    crop: { left: 0, top: 260, width: 2000, height: 1250 },
    brightness: 0.62,
    saturation: 0.95,
  },
  { name: "smoke", src: "12-aurora-smoke-dark-alexanderx.jpg", brightness: 0.9, saturation: 1 },
];
const widths = [640, 1280, 2048];

const newer = async (a, b) => {
  try {
    return (await stat(a)).mtimeMs >= (await stat(b)).mtimeMs;
  } catch {
    return false;
  }
};

for (const s of specs) {
  const src = `${root}assets/photos/${s.src}`;
  const probe = `${out}/${s.name}-2048.avif`;
  const last = `${out}/${s.name}-${widths.at(-1)}.jpg`;
  // Up to date when the outputs are newer than the original; PHOTOS_FORCE=1 re-encodes everything.
  if (!process.env.PHOTOS_FORCE && (await newer(last, src)) && (await newer(probe, src))) continue;
  for (const w of widths) {
    let img = sharp(src, { limitInputPixels: false }).rotate();
    if (s.crop) img = img.extract(s.crop);
    img = img
      .resize({ width: w, withoutEnlargement: true })
      .modulate({ brightness: s.brightness, saturation: s.saturation })
      .linear([0.94, 0.97, 1.06], [0, 0, 4]);
    const buf = await img.toBuffer();
    await sharp(buf).avif({ quality: 42, effort: 5 }).toFile(`${out}/${s.name}-${w}.avif`);
    await sharp(buf).webp({ quality: 68 }).toFile(`${out}/${s.name}-${w}.webp`);
    await sharp(buf).jpeg({ quality: 68, mozjpeg: true }).toFile(`${out}/${s.name}-${w}.jpg`);
  }
  console.log(`photos: ${s.name}`);
}
