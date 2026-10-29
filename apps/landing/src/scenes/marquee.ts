import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { $$, clamp } from "../env";

/** Giant words travel with scroll position and lean into the scroll velocity; they never move on their own. */
export function marquee(): void {
  const rows = $$<HTMLElement>(".mq-track");
  if (rows.length < 2) return;
  const [a, b] = rows as [HTMLElement, HTMLElement];
  const st = { trigger: ".marquee", start: "top bottom", end: "bottom top", scrub: 0.4 } as const;
  gsap.fromTo(a, { xPercent: 2 }, { xPercent: -28, ease: "none", scrollTrigger: st });
  gsap.fromTo(b, { xPercent: -30 }, { xPercent: 0, ease: "none", scrollTrigger: st });
  const skewA = gsap.quickSetter(a, "skewX", "deg") as (v: number) => void;
  const skewB = gsap.quickSetter(b, "skewX", "deg") as (v: number) => void;
  const proxy = { v: 0 };
  ScrollTrigger.create({
    trigger: ".marquee",
    start: "top bottom",
    end: "bottom top",
    onUpdate: (self) => {
      const v = clamp(self.getVelocity() / -260, -7, 7);
      if (Math.abs(v) > Math.abs(proxy.v)) {
        proxy.v = v;
        skewA(v);
        skewB(v);
        gsap.to(proxy, {
          v: 0,
          duration: 0.7,
          ease: "power3.out",
          overwrite: true,
          onUpdate: () => {
            skewA(proxy.v);
            skewB(proxy.v);
          },
        });
      }
    },
  });
}
