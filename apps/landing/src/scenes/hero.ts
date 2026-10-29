import gsap from "gsap";
import { $, $$ } from "../env";

function fmt(s: number): string {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Uptime digits keep ticking (one of the two allowed infinite loops). */
function startUptime(): void {
  const el = $("#uptime");
  if (!el) return;
  let s = 41;
  window.setInterval(() => {
    if (document.hidden) return;
    s += 1;
    el.textContent = fmt(s);
  }, 1000);
}

/** One orchestrated load moment: the light boots, the terminal types, the workspace wakes. */
export function heroBoot(split: (el: HTMLElement) => gsap.core.Tween | null): void {
  const html = document.documentElement;
  const visual = $("#hero-visual");
  const title = $<HTMLElement>(".hero-title");
  const cmd = $("#t-cmd");
  const lines = $$(".t-wake, .t-run, .t-host");
  const caret = $(".caret");
  const text = cmd?.textContent ?? "open maple";

  gsap.set("[data-boot]", { opacity: 0, y: 24 });
  gsap.set(visual, { "--box-light": 0 });
  gsap.set(["#term"], { opacity: 0, y: 24 });
  gsap.set(lines, { opacity: 0 });
  if (cmd) cmd.textContent = "";
  html.classList.remove("boot");

  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
  if (title) split(title);
  tl.to(
    "[data-boot]",
    { opacity: 1, y: 0, duration: 0.7, stagger: 0.08, clearProps: "transform" },
    0.15,
  );
  tl.fromTo(
    ".box-wrap",
    { y: 36, scale: 0.94 },
    { y: 0, scale: 1, duration: 1.6, ease: "power2.out", clearProps: "scale,y" },
    0.05,
  );
  tl.to(
    visual,
    { "--box-light": 1, duration: 1.6, ease: "power2.inOut", clearProps: "--box-light" },
    0.25,
  );
  tl.to("#term", { opacity: 1, y: 0, duration: 0.7 }, 0.9);

  const typed = { n: 0 };
  tl.to(
    typed,
    {
      n: text.length,
      duration: 0.7,
      ease: "none",
      onUpdate: () => {
        if (cmd) cmd.textContent = text.slice(0, Math.round(typed.n));
      },
    },
    1.25,
  );
  tl.set(".t-wake", { opacity: 1 }, 2.1);
  tl.set(".t-wake", { opacity: 0 }, 2.9);
  tl.call(() => $(".t-wake")?.classList.add("gone"), [], 2.9);
  tl.set(".t-run", { opacity: 1 }, 2.95);
  tl.fromTo(".t-host", { opacity: 0, x: -8 }, { opacity: 1, x: 0, duration: 0.5 }, 3.1);
  tl.call(
    () => {
      caret?.remove();
      startUptime();
    },
    [],
    3.1,
  );
}

/** Scroll scrub: the box tilts, the lid lifts and the windows rise out of it. */
export function heroScrub(wide: boolean): void {
  const hero = $(".hero");
  if (!hero) return;
  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: wide
      ? { trigger: hero, start: "top top", end: "bottom bottom", scrub: 0.6 }
      : { trigger: "#hero-visual", start: "top 70%", end: "bottom 30%", scrub: 0.6 },
  });
  tl.fromTo(
    ".pop",
    { opacity: 0, y: 70, scale: 0.72 },
    { opacity: 1, y: 0, scale: 1, stagger: 0.12, ease: "power2.out", duration: 0.5 },
    0.2,
  );
  tl.to("#box-lid", { y: -64, ease: "power1.inOut", duration: 0.7 }, 0.1);
  tl.to(
    ".box-wrap",
    wide
      ? { rotateY: -14, rotateX: 5, y: 8, scale: 1.06, duration: 1 }
      : { rotateY: -8, duration: 1 },
    0,
  );
  if (wide) {
    tl.to(".hero-copy", { y: -50, opacity: 0.18, duration: 0.5 }, 0.55);
    tl.to("#term", { opacity: 0.25, y: 30, duration: 0.4 }, 0.6);
    tl.to(".scroll-cue", { opacity: 0, duration: 0.1 }, 0);
  }
}
