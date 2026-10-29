import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { $, $$ } from "../env";

const PKTS = [
  { id: "#pkt-lan", key: "lan" },
  { id: "#pkt-vpn", key: "vpn" },
  { id: "#pkt-meta", key: "meta" },
  { id: "#pkt-tenant", key: "tenant" },
] as const;

/** Rings expand around the box; labelled packets fly in and are stopped at the ring. */
export function security(pinned: boolean): void {
  const root = $(".security");
  const art = $("#sec-art");
  const ring = $<SVGGraphicsElement>("#ring-2");
  const svg = $<SVGSVGElement>(".rings-svg");
  if (!root || !art || !ring || !svg) return;
  const vb = svg.viewBox.baseVal;
  const bb = ring.getBBox();
  const cx = bb.x + bb.width / 2,
    cy = bb.y + bb.height / 2,
    rx = bb.width / 2,
    ry = bb.height / 2;

  // Chips ride along with their glyphs: place them under the glyph's rendered position.
  const scale = () => svg.getScreenCTM()?.a ?? art.clientWidth / vb.width;
  const placeChips = () => {
    const ar = art.getBoundingClientRect();
    for (const { id, key } of PKTS) {
      const g = $<SVGGraphicsElement>(id);
      const chip = $<HTMLElement>(`[data-pkt="${key}"]`);
      if (!g || !chip || !pinned) continue;
      const r = g.getBoundingClientRect();
      const left = r.left + r.width / 2 < ar.left + ar.width / 2;
      // Chips sit outside the glyph, away from the box, so they never pile up on the ring.
      const x = left ? r.left - ar.left - chip.offsetWidth - 10 : r.right - ar.left + 10;
      chip.style.left = `${Math.max(0, Math.min(x, ar.width - chip.offsetWidth))}px`;
      chip.style.top = `${r.top - ar.top + r.height / 2 - chip.offsetHeight / 2 - 4}px`;
    }
  };
  if (pinned) ScrollTrigger.addEventListener("refreshInit", placeChips);

  const tl = gsap.timeline({
    paused: !pinned,
    defaults: { ease: "power2.out" },
    scrollTrigger: pinned
      ? {
          trigger: root,
          start: "top top",
          end: "bottom bottom",
          scrub: 0.6,
          invalidateOnRefresh: true,
        }
      : undefined,
  });
  gsap.set(svg, { "--box-light": 1 });
  tl.fromTo(
    ["#ring-1", "#ring-2", "#ring-3", "#ring-4"],
    { scale: 0.55, opacity: 0 },
    { scale: 1, opacity: 1, duration: 1.4, stagger: 0.25 },
    0,
  );
  tl.fromTo("#ring-core", { opacity: 0.4 }, { opacity: 1, duration: 1 }, 0);
  gsap.set("#spark", { opacity: 0 });

  PKTS.forEach(({ id, key }, i) => {
    const g = $<SVGGraphicsElement>(id);
    const chip = $<HTMLElement>(`[data-pkt="${key}"]`);
    if (!g) return;
    const m = g.transform.baseVal.consolidate()?.matrix;
    const sx = m?.e ?? 0,
      sy = m?.f ?? 0;
    const dx = sx - cx,
      dy = sy - cy;
    const k = 1 / Math.hypot(dx / rx, dy / ry);
    const tx = cx + dx * k * 1.12,
      ty = cy + dy * k * 1.12;
    const t0 = 1.6 + i * 1.5;
    gsap.set(g, { x: sx, y: sy });
    tl.fromTo(g, { x: sx, y: sy }, { x: tx, y: ty, duration: 1.1, ease: "power2.in" }, t0);
    if (chip && pinned) {
      tl.fromTo(
        chip,
        { x: 0, y: 0 },
        {
          x: () => (tx - sx) * scale(),
          y: () => (ty - sy) * scale(),
          duration: 1.1,
          ease: "power2.in",
        },
        t0,
      );
    }
    if (chip) tl.to(chip, { "--deny": 1, duration: 0.25, ease: "none" }, t0 + 1.05);
    tl.set("#spark", { x: cx + dx * k, y: cy + dy * k }, t0 + 1.05);
    tl.fromTo(
      "#spark",
      { opacity: 1, scale: 0.4 },
      { opacity: 0, scale: 1.5, duration: 0.5, ease: "power2.out" },
      t0 + 1.05,
    );
    tl.fromTo(
      "#ring-2",
      { opacity: 1 },
      { opacity: 0.45, duration: 0.15, yoyo: true, repeat: 1, ease: "none" },
      t0 + 1.05,
    );
  });
  const end = 1.6 + PKTS.length * 1.5 + 0.6;
  tl.fromTo("#sec-note", { opacity: 0.25, y: 12 }, { opacity: 1, y: 0, duration: 0.8 }, end - 0.4);
  tl.to({}, { duration: 0.6 });
  placeChips();

  if (!pinned) {
    gsap.set("#sec-note", { opacity: 0.25 });
    gsap.timeline({
      scrollTrigger: {
        trigger: art,
        start: "top 78%",
        once: true,
        onEnter: () => tl.timeScale(1.6).play(),
      },
    });
    $$("[data-pkt]").forEach((c) => c.style.setProperty("--deny", "0"));
  }
}
