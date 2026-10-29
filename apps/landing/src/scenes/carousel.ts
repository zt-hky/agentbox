import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { $, $$ } from "../env";

/** Apple-style highlights: scroll-snap track, progress-pill pager, autoplay with a pause control. */
export function carousel(autoplayAllowed: boolean): void {
  const viewport = $<HTMLElement>("#hl-viewport");
  const cards = $$<HTMLElement>(".hl-card");
  const dots = $$<HTMLButtonElement>("#hl-dots button");
  const pp = $<HTMLButtonElement>("#hl-pp");
  const section = $("#highlights");
  if (!viewport || !pp || !section || cards.length === 0) return;
  const DURATION = 6;
  let idx = 0;
  let playing = autoplayAllowed;
  let visible = false;
  let programmatic = 0;
  const prog = { p: 0 };

  const padLeft = () => parseFloat(getComputedStyle(viewport).scrollPaddingLeft) || 0;
  const leftOf = (i: number) => {
    const c = cards[i];
    if (!c) return 0;
    return (
      c.getBoundingClientRect().left -
      viewport.getBoundingClientRect().left +
      viewport.scrollLeft -
      padLeft()
    );
  };
  const paint = () => {
    dots.forEach((d, i) => {
      d.classList.toggle("is-active", i === idx);
      d.setAttribute("aria-current", i === idx ? "true" : "false");
      if (i === idx) d.style.setProperty("--prog", prog.p.toFixed(3));
    });
  };
  const tween = gsap.to(prog, {
    p: 1,
    duration: DURATION,
    ease: "none",
    paused: true,
    onUpdate: paint,
    onComplete: () => goTo((idx + 1) % cards.length),
  });
  const sync = () => {
    pp.setAttribute("aria-pressed", String(!playing));
    pp.setAttribute("aria-label", playing ? "Pause autoplay" : "Play autoplay");
    if (playing && visible && !document.hidden) tween.play();
    else tween.pause();
  };
  function goTo(i: number, smooth = true) {
    idx = i;
    prog.p = 0;
    tween.restart(true, false);
    programmatic = Date.now();
    viewport!.scrollTo({
      left: leftOf(i),
      behavior: smooth && autoplayAllowed ? "smooth" : "auto",
    });
    paint();
    sync();
  }
  const stopAuto = () => {
    if (!playing) return;
    playing = false;
    sync();
  };
  pp.addEventListener("click", () => {
    playing = !playing;
    sync();
  });
  dots.forEach((d, i) =>
    d.addEventListener("click", () => {
      stopAuto();
      goTo(i);
    }),
  );
  let t = 0;
  viewport.addEventListener(
    "scroll",
    () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        let best = 0,
          bd = Infinity;
        cards.forEach((c, i) => {
          const d = Math.abs(leftOf(i) - viewport.scrollLeft);
          if (d < bd) {
            bd = d;
            best = i;
          }
        });
        if (best !== idx) {
          idx = best;
          prog.p = 0;
          tween.restart(true, false);
          paint();
          sync();
        }
      }, 90);
    },
    { passive: true },
  );
  for (const ev of ["pointerdown", "wheel", "touchstart"] as const)
    viewport.addEventListener(
      ev,
      () => {
        if (Date.now() - programmatic > 800) stopAuto();
      },
      { passive: true },
    );
  viewport.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      stopAuto();
      goTo(Math.min(cards.length - 1, idx + 1));
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      stopAuto();
      goTo(Math.max(0, idx - 1));
    }
  });
  document.addEventListener("visibilitychange", sync);
  ScrollTrigger.create({
    trigger: section,
    start: "top 70%",
    end: "bottom 20%",
    onToggle: (self) => {
      visible = self.isActive;
      sync();
    },
  });
  paint();
  sync();
}
