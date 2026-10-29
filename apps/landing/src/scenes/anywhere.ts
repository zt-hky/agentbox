import gsap from "gsap";

export function anywhere(wide: boolean): void {
  if (wide) {
    const st = {
      trigger: ".anywhere",
      start: "top bottom",
      end: "bottom top",
      scrub: true,
    } as const;
    gsap.fromTo(".any-photo", { yPercent: -5 }, { yPercent: 5, ease: "none", scrollTrigger: st });
    gsap.fromTo("#frame-browser", { y: 90 }, { y: -40, ease: "none", scrollTrigger: { ...st } });
    gsap.fromTo("#frame-phone", { y: 190 }, { y: -70, ease: "none", scrollTrigger: { ...st } });
    gsap.from(["#frame-browser", "#frame-phone"], {
      opacity: 0,
      duration: 0.8,
      ease: "power3.out",
      stagger: 0.15,
      scrollTrigger: { trigger: ".any-frames", start: "top 85%", once: true },
    });
  } else {
    gsap.from(["#frame-browser", "#frame-phone"], {
      opacity: 0,
      y: 36,
      duration: 0.8,
      ease: "power3.out",
      stagger: 0.15,
      scrollTrigger: { trigger: ".any-frames", start: "top 88%", once: true },
    });
  }
}
