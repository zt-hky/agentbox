import gsap from "gsap";
import { $ } from "../env";

/** The box dims to a sleeping state as you scroll, a moon passes, then it wakes. */
export function sleep(pinned: boolean): void {
  const root = $(".sleep");
  const art = $("#sleep-art");
  const state = $("#sleep-state");
  const path = $<SVGPathElement>("#moon-path");
  const moon = $<SVGGElement>("#moon");
  if (!root || !art || !state || !path || !moon) return;
  const label = $("em", state);
  const len = path.getTotalLength();
  const place = (t: number) => {
    const p = path.getPointAtLength(len * t);
    gsap.set(moon, { x: p.x, y: p.y });
  };
  const set = (text: string, mode: "awake" | "asleep" | "waking") => {
    if (label && label.textContent !== text) label.textContent = text;
    state.classList.toggle("is-asleep", mode === "asleep");
    const dot = $<HTMLElement>(".dot", state);
    if (dot) dot.style.backgroundColor = mode === "waking" ? "var(--ember)" : "";
  };
  const m = { t: 0 };
  gsap.set(art, { "--wake": 1 });
  gsap.set(moon, { opacity: 0 });
  place(0);

  const tl = gsap.timeline({
    paused: !pinned,
    defaults: { ease: "none" },
    scrollTrigger: pinned
      ? { trigger: root, start: "top top", end: "bottom bottom", scrub: 0.6 }
      : undefined,
  });
  tl.to(art, { "--wake": 0.1, duration: 2, ease: "power2.inOut" }, 0.4);
  tl.call(() => set("sleeping", "asleep"), [], 1.6);
  tl.call(() => set("awake", "awake"), [], 1.0).call(() => set("sleeping", "asleep"), [], 1.6);
  tl.to(moon, { opacity: 1, duration: 0.4 }, 1.8);
  tl.to(m, { t: 1, duration: 3.6, onUpdate: () => place(m.t) }, 1.8);
  tl.to(moon, { opacity: 0, duration: 0.5 }, 4.9);
  tl.call(() => set("waking…", "waking"), [], 5.3);
  tl.to(art, { "--wake": 1, duration: 1.8, ease: "power2.out" }, 5.4);
  tl.call(() => set("awake", "awake"), [], 6.9);
  tl.fromTo(".stats li", { opacity: 0.35 }, { opacity: 1, duration: 0.6, stagger: 0.2 }, 5.6);
  tl.to({}, { duration: 0.5 });
  if (!pinned) {
    gsap.set(".stats li", { opacity: 1 });
    gsap.timeline({
      scrollTrigger: {
        trigger: art,
        start: "top 75%",
        once: true,
        onEnter: () => tl.timeScale(1).play(),
      },
    });
  }
}
