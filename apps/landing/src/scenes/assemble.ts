import gsap from "gsap";
import { $, $$, clamp } from "../env";

const LAYERS = [
  "#asm-system",
  "#asm-user",
  "#asm-container",
  "#asm-tools",
  "#asm-files",
  "#asm-lid",
];

/** Pinned exploded-hardware scene: six layers drop onto the stack while the left column steps. */
export function assemble(): void {
  const root = $(".assemble");
  if (!root) return;
  const steps = $$(".asm-step", root);
  const bar = $<HTMLElement>(".asm-progress", root);
  const counts = $$(".asm-count span", root);
  let active = -1;
  const setActive = (i: number) => {
    if (i === active) return;
    active = i;
    steps.forEach((s, k) => s.classList.toggle("is-active", k === i));
    counts.forEach((c, k) => c.classList.toggle("is-active", k === i));
  };
  setActive(0);

  const tl = gsap.timeline({
    defaults: { ease: "power2.out" },
    scrollTrigger: {
      trigger: root,
      start: "top top",
      end: "bottom bottom",
      scrub: 0.6,
      onUpdate: (self) => {
        setActive(clamp(Math.floor(self.progress * 6.0), 0, 5));
        bar?.style.setProperty("--p", self.progress.toFixed(3));
      },
    },
  });
  gsap.set("#asm-plate", { opacity: 0 });
  gsap.set("#asm-glow", { opacity: 0 });
  gsap.set("#asm-beam", { opacity: 0 });
  LAYERS.forEach((id, i) => {
    tl.fromTo(id, { y: -140, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8 }, i);
  });
  tl.to("#asm-glow", { opacity: 0.9, duration: 1.4, ease: "none" }, 4.4);
  tl.to("#asm-beam", { opacity: 1, duration: 0.6 }, 5.2);
  tl.to("#asm-plate", { opacity: 1, duration: 0.6 }, 5.3);
  tl.to(".asm-halo", { "--halo": 1.0, duration: 6, ease: "none" }, 0);
  tl.fromTo(".asm-halo", { opacity: 0.25 }, { opacity: 1, duration: 6, ease: "none" }, 0);
  tl.to({}, { duration: 0.35 }); // a short rest on the final frame
}
