/* global console, URL */
// Renders the OG image (1200x630 PNG), favicons and apple-touch icon from the brand SVGs.
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
await mkdir(`${root}public`, { recursive: true });
const og = await readFile(`${root}src/art/brand/og.svg`);
await sharp(og, { density: 144 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(`${root}public/og.png`);
const fav = await readFile(`${root}src/art/brand/favicon.svg`);
await sharp(fav, { density: 512 }).resize(32, 32).png().toFile(`${root}public/favicon-32.png`);
await sharp(fav, { density: 1024 })
  .resize(180, 180)
  .flatten({ background: "#05070E" })
  .png()
  .toFile(`${root}public/apple-touch-icon.png`);
console.log("og: og.png, favicon-32.png, apple-touch-icon.png");
