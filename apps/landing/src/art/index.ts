// Hand-authored SVG art, inlined as strings (Vite `?raw`). Every file uses unique id prefixes, so several can be
// inlined in one document (brand/og.svg and brand/favicon.svg are build-time files, not imported here); each animated element has a stable id (see PLAN.md section 5).
import assembly from "./assembly.svg?raw";
import bento1 from "./bento/bento-1.svg?raw";
import bento2 from "./bento/bento-2.svg?raw";
import bento3 from "./bento/bento-3.svg?raw";
import bento4 from "./bento/bento-4.svg?raw";
import bento5 from "./bento/bento-5.svg?raw";
import bento6 from "./bento/bento-6.svg?raw";
import boxAwake from "./box-awake.svg?raw";
import boxIdle from "./box-idle.svg?raw";
import boxSleeping from "./box-sleeping.svg?raw";
import box from "./box.svg?raw";
import brandMark from "./brand/mark.svg?raw";
import brandWordmark from "./brand/wordmark.svg?raw";
import browser from "./browser.svg?raw";
import glyphs from "./glyphs.svg?raw";
import phone from "./phone.svg?raw";
import rings from "./rings.svg?raw";
import sleep from "./sleep.svg?raw";

export const art = {
  assembly,
  bento1,
  bento2,
  bento3,
  bento4,
  bento5,
  bento6,
  boxAwake,
  boxIdle,
  boxSleeping,
  box,
  brandMark,
  brandWordmark,
  browser,
  glyphs,
  phone,
  rings,
  sleep,
} as const;

export type ArtName = keyof typeof art;
