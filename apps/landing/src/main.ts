import "./styles/base.css";
import "./styles/sections.css";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import Lenis from "lenis";
import { $, $$, MQ } from "./env";
import { heroBoot, heroScrub } from "./scenes/hero";
import { assemble } from "./scenes/assemble";
import { anywhere } from "./scenes/anywhere";
import { marquee } from "./scenes/marquee";
import { security } from "./scenes/security";
import { sleep } from "./scenes/sleep";
import { carousel } from "./scenes/carousel";

gsap.registerPlugin(ScrollTrigger, SplitText);

/* ---- nav, menu, phone dock: plain DOM, independent of motion ---- */
function chrome(): void {
  const nav = $("#nav");
  const dock = $("#dock");
  const cta = $("#cta");
  const btn = $<HTMLButtonElement>(".nav-menu");
  const menu = $("#menu");
  let ticking = false;
  const update = () => {
    ticking = false;
    const y = window.scrollY;
    const vh = window.innerHeight;
    nav?.classList.toggle("is-compact", y > vh * 0.6);
    const ctaTop = cta ? cta.getBoundingClientRect().top : Infinity;
    dock?.classList.toggle("is-on", y > vh * 0.9 && ctaTop > vh * 0.55);
  };
  window.addEventListener(
    "scroll",
    () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    },
    { passive: true },
  );
  update();
  const close = () => {
    menu?.setAttribute("hidden", "");
    btn?.setAttribute("aria-expanded", "false");
  };
  btn?.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    if (open) close();
    else {
      menu?.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
  });
  menu?.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

/* ---- headline line reveals ---- */
function splitReveal(el: HTMLElement, opts: { immediate?: boolean } = {}): gsap.core.Tween | null {
  let tween: gsap.core.Tween | null = null;
  SplitText.create(el, {
    type: "lines",
    mask: "lines",
    autoSplit: true,
    linesClass: "line",
    onSplit(self) {
      tween = gsap.from(self.lines, {
        yPercent: 110,
        duration: 0.9,
        ease: "power3.out",
        stagger: 0.07,
        delay: opts.immediate ? 0.05 : 0,
        scrollTrigger: opts.immediate ? undefined : { trigger: el, start: "top 88%", once: true },
      });
      return tween;
    },
  });
  return tween;
}

function init(): void {
  chrome();
  const mm = gsap.matchMedia();

  mm.add({ motion: MQ.motion, wide: MQ.wide, short: MQ.short }, (ctx) => {
    const conditions = ctx.conditions as { motion: boolean; wide: boolean; short: boolean };
    if (!conditions.motion) {
      document.documentElement.classList.remove("boot");
      return;
    }
    const wide = conditions.wide;

    // Scrubbed scenes first (they set their own start states), then the boot sequence.
    heroScrub(wide);
    if (!conditions.short) assemble();
    anywhere(wide);
    marquee();
    security(wide);
    sleep(wide);
    heroBoot((el) => splitReveal(el, { immediate: true }));

    for (const el of $$<HTMLElement>("[data-split]")) {
      if (el.classList.contains("hero-title")) continue;
      splitReveal(el);
    }
    ScrollTrigger.batch(".reveal", {
      start: "top 90%",
      once: true,
      onEnter: (els) =>
        gsap.to(els, {
          opacity: 1,
          y: 0,
          duration: 0.6,
          ease: "power3.out",
          stagger: 0.06,
          overwrite: true,
        }),
    });
    for (const cell of $$(".cell")) {
      ScrollTrigger.create({
        trigger: cell,
        start: "top 85%",
        once: true,
        onEnter: () =>
          gsap.from($$(".bar u", cell), {
            scaleX: 0,
            duration: 1.1,
            ease: "power3.out",
            delay: 0.25,
          }),
      });
    }
    $$(".tile").forEach((tile, i) => {
      gsap.from(tile, {
        opacity: 0,
        y: 24,
        duration: 0.6,
        ease: "power3.out",
        delay: i * 0.06,
        scrollTrigger: { trigger: ".tiles", start: "top 88%", once: true },
      });
    });
    carousel(true);
    return () => {
      /* matchMedia reverts tweens and triggers */
    };
  });

  mm.add(MQ.smooth, () => {
    const lenis = new Lenis({ anchors: true, lerp: 0.1, wheelMultiplier: 1 });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (t: number) => lenis.raf(t * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  });

  mm.add("(prefers-reduced-motion: reduce)", () => {
    document.documentElement.classList.remove("boot");
    carousel(false);
  });

  document.fonts?.ready.then(() => ScrollTrigger.refresh());
  window.addEventListener("load", () => ScrollTrigger.refresh());
}

try {
  init();
} catch (err) {
  console.error(err);
  document.documentElement.classList.remove("boot");
  document.documentElement.classList.add("no-motion");
}
