"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { EDGE_LIST, NODE_LIST, NODE_MAP } from "@/lib/graph/stadiumGraph";
import { capacityPct } from "@/lib/graph/jitter";
import { useI18n } from "@/lib/i18n";
import type { OccupancyState, PathfinderResult } from "@/lib/types";

const W = 1000;
const H = 680;
const PAD = 70;
const MIN_SCALE = 1;
const MAX_SCALE = 5;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function loadColor(pct: number): string {
  if (pct >= 0.9) return "#ef4444";
  if (pct >= 0.8) return "#f97316";
  if (pct >= 0.5) return "#eab308";
  return "#22c55e";
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  );
}

interface Projection {
  x: (id: string) => number;
  y: (id: string) => number;
}

function useProjection(): Projection {
  const [proj] = useState<Projection>(() => {
    const lats = NODE_LIST.map((n) => n.lat);
    const lngs = NODE_LIST.map((n) => n.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const spanLat = maxLat - minLat || 1;
    const spanLng = maxLng - minLng || 1;
    const x = (id: string) => PAD + ((NODE_MAP[id].lng - minLng) / spanLng) * (W - 2 * PAD);
    const y = (id: string) => PAD + ((maxLat - NODE_MAP[id].lat) / spanLat) * (H - 2 * PAD);
    return { x, y };
  });
  return proj;
}

function pathPoints(path: string[], proj: Projection): string {
  return path.map((id) => `${proj.x(id).toFixed(0)},${proj.y(id).toFixed(0)}`).join(" ");
}

function RouteArrows({ path, proj }: { path: string[]; proj: Projection }) {
  const arrows: ReactElement[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const x1 = proj.x(path[i]);
    const y1 = proj.y(path[i]);
    const x2 = proj.x(path[i + 1]);
    const y2 = proj.y(path[i + 1]);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    arrows.push(
      <g key={`arrow-${i}`} transform={`translate(${mx} ${my}) rotate(${ang})`}>
        <polygon points="0,-4 8,0 0,4" fill="#2dd4bf" />
      </g>
    );
  }
  return <>{arrows}</>;
}

/** Stadium bowl + field backdrop, fitted to the gate ring so it reads as
 *  MetLife instead of a bare node graph. Drawn behind the edges/nodes and
 *  inside the pan/zoom group so it transforms with the map. */
function StadiumBowl({ proj }: { proj: Projection }) {
  // Bowl center = the central concourse node; radii enclose the four perimeter
  // gates (+padding for the gate circles themselves).
  const cx = proj.x("junction_c");
  const cy = proj.y("junction_c");
  const rx = Math.max(Math.abs(proj.x("gate_a") - cx), Math.abs(proj.x("gate_c") - cx)) + 30;
  const ry = Math.max(Math.abs(proj.y("gate_b") - cy), Math.abs(proj.y("gate_d") - cy)) + 30;
  const fieldRx = rx * 0.46;
  const fieldRy = ry * 0.46;
  const yardYs = [-0.72, -0.36, 0, 0.36, 0.72];
  return (
    <g aria-hidden>
      <defs>
        <radialGradient id="bowlGlow" cx="50%" cy="42%" r="60%">
          <stop offset="0%" stopColor="#152033" />
          <stop offset="100%" stopColor="#0a1020" />
        </radialGradient>
        <linearGradient id="turf" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1f4530" />
          <stop offset="100%" stopColor="#173021" />
        </linearGradient>
        <clipPath id="fieldClip">
          <ellipse cx={cx} cy={cy} rx={fieldRx} ry={fieldRy} />
        </clipPath>
      </defs>

      {/* Soft halo behind the bowl. */}
      <ellipse cx={cx} cy={cy} rx={rx + 26} ry={ry + 26} fill="#0d1626" opacity={0.7} />
      {/* Bowl structure (outer + inner ring = the stand wall). */}
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#bowlGlow)" stroke="#243044" strokeWidth={6} />
      <ellipse
        cx={cx}
        cy={cy}
        rx={rx - 14}
        ry={ry - 14}
        fill="none"
        stroke="#1a2740"
        strokeWidth={2}
        strokeDasharray="3 7"
        opacity={0.7}
      />

      {/* Field (turf) with yard lines + center logo, clipped to the ellipse. */}
      <ellipse cx={cx} cy={cy} rx={fieldRx} ry={fieldRy} fill="url(#turf)" stroke="#2a4a36" strokeWidth={1.5} />
      <g clipPath="url(#fieldClip)" stroke="#3b6650" strokeWidth={1.5} opacity={0.7}>
        {yardYs.map((f, i) => (
          <line
            key={i}
            x1={cx - fieldRx}
            y1={cy + fieldRy * f}
            x2={cx + fieldRx}
            y2={cy + fieldRy * f}
          />
        ))}
        <line x1={cx} y1={cy - fieldRy} x2={cx} y2={cy + fieldRy} stroke="#4a7a60" />
        <circle cx={cx} cy={cy} r={Math.min(fieldRx, fieldRy) * 0.16} fill="none" stroke="#4a7a60" strokeWidth={1.5} />
      </g>
    </g>
  );
}

function Legend({ t }: { t: (k: string) => string }) {
  const items = [
    { color: "#22c55e", label: "<50%" },
    { color: "#eab308", label: "50–80%" },
    { color: "#f97316", label: "80–90%" },
    { color: "#ef4444", label: "≥90%" },
  ];
  return (
    // Box sized to actually enclose the title + 4 swatch rows (the old fixed
    // height cut off the last row), and raised off the bottom edge so it doesn't
    // crowd the gate-control panel beneath the map.
    <g transform={`translate(${W - PAD - 120} ${H - PAD - 112})`}>
      <rect x={-10} y={-8} width={152} height={108} rx={8} fill="#0b1220" opacity={0.88} stroke="#1f2937" />
      <text x={0} y={12} fontSize={11} fontWeight={700} fill="#cbd5e1">{t("map.legend")}</text>
      {items.map((it, i) => (
        <g key={it.label} transform={`translate(0 ${28 + i * 18})`}>
          <rect width={12} height={12} rx={2} fill={it.color} />
          <text x={18} y={10} fontSize={10} fill="#94a3b8">{it.label}</text>
        </g>
      ))}
    </g>
  );
}

export interface StadiumMapProps {
  occupancy: OccupancyState;
  closedGates: string[];
  routeResult: PathfinderResult | null;
  selectedId?: string | null;
  onNodeSelect?: (id: string | null) => void;
  boundNodeId?: string | null;
  alertGateIds?: string[];
  onRouteTo?: (id: string) => void;
  onRouteFrom?: (id: string) => void;
}

export default function StadiumMap({
  occupancy,
  closedGates,
  routeResult,
  selectedId,
  onNodeSelect,
  boundNodeId,
  alertGateIds,
  onRouteTo,
  onRouteFrom,
}: StadiumMapProps) {
  const proj = useProjection();
  const reduced = usePrefersReducedMotion();
  const { t } = useI18n();
  const closed = new Set(closedGates);
  const alertSet = new Set(alertGateIds ?? []);
  const winnerPath = routeResult?.winner?.path;
  const runnerUpPath = routeResult?.runnerUp?.path;
  const selected = selectedId ? NODE_MAP[selectedId] : null;

  // --- Pan + zoom ----------------------------------------------------------
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastPan = useRef<{ x: number; y: number } | null>(null);
  const pinchDist = useRef<number | null>(null);
  const draggedRef = useRef(false);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // keep page from scrolling while zooming the map
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return;
      const mx = (e.clientX - rect.left) * (W / rect.width);
      const my = (e.clientY - rect.top) * (H / rect.height);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setView((v) => {
        const ns = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
        if (ns === 1) return { tx: 0, ty: 0, scale: 1 };
        return { tx: v.tx + (v.scale - ns) * mx, ty: v.ty + (v.scale - ns) * my, scale: ns };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) =>
    setView((v) => {
      const ns = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      if (ns === 1) return { tx: 0, ty: 0, scale: 1 };
      const mx = W / 2;
      const my = H / 2;
      return { tx: v.tx + (v.scale - ns) * mx, ty: v.ty + (v.scale - ns) * my, scale: ns };
    });
  const reset = () => setView({ tx: 0, ty: 0, scale: 1 });

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      lastPan.current = { x: e.clientX, y: e.clientY };
      draggedRef.current = false;
    } else if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()];
      pinchDist.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      lastPan.current = null; // pinch, not pan
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    if (pointers.current.size === 2 && pinchDist.current != null) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = ((pts[0].x + pts[1].x) / 2 - rect.left) * (W / rect.width);
      const midY = ((pts[0].y + pts[1].y) / 2 - rect.top) * (H / rect.height);
      const factor = dist / (pinchDist.current || dist);
      setView((v) => {
        const ns = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
        if (ns === 1) return { tx: 0, ty: 0, scale: 1 };
        return { tx: v.tx + (v.scale - ns) * midX, ty: v.ty + (v.scale - ns) * midY, scale: ns };
      });
      pinchDist.current = dist;
      draggedRef.current = true;
    } else if (pointers.current.size === 1 && lastPan.current) {
      const dx = e.clientX - lastPan.current.x;
      const dy = e.clientY - lastPan.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) draggedRef.current = true;
      if (draggedRef.current) {
        const k = W / rect.width;
        setView((v) =>
          v.scale === 1 ? v : { ...v, tx: v.tx + dx * k, ty: v.ty + dy * k }
        );
      }
      lastPan.current = { x: e.clientX, y: e.clientY };
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchDist.current = null;
    if (pointers.current.size === 1) {
      lastPan.current = [...pointers.current.values()][0];
    } else if (pointers.current.size === 0) {
      lastPan.current = null;
    }
  };

  const nodeShape = (n: (typeof NODE_LIST)[number]) => {
    const occ = occupancy[n.id] ?? 0;
    const pct = capacityPct(occ, n.capacity);
    const color = loadColor(pct);
    const isClosed = closed.has(n.id);
    const cx = proj.x(n.id);
    const cy = proj.y(n.id);
    const onRoute = winnerPath?.includes(n.id);
    const isSel = selectedId === n.id;
    const isAlert = alertSet.has(n.id);

    const common = {
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!draggedRef.current) onNodeSelect?.(n.id);
      },
      style: { cursor: onNodeSelect ? "pointer" : "default" },
    };

    const labelEl =
      n.type === "gate" ? (
        <>
          <text x={cx} y={cy - 20} textAnchor="middle" fontSize={12} fontWeight={700} fill="#e2e8f0">{n.label}</text>
          <text x={cx} y={cy + 30} textAnchor="middle" fontSize={10} fill="#94a3b8">{Math.round(pct * 100)}%</text>
        </>
      ) : n.type === "section" ? (
        // Section 300 sits ~21px north of Field Level in projection, so a label
        // below it (cy+26) lands on Field Level's box. Put 300's label above.
        <text
          x={cx}
          y={n.id === "sec_300" ? cy - 14 : cy + 26}
          textAnchor="middle"
          fontSize={11}
          fill="#cbd5e1"
        >
          {n.label.replace("Section ", "Sec ")}
        </text>
      ) : n.type === "transit" ? (
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0b1220">{n.label}</text>
      ) : n.type === "amenity" ? (
        <text x={cx} y={cy - 12} textAnchor="middle" fontSize={9} fill="#94a3b8">{n.label.split(" ")[0]}</text>
      ) : null;

    const alertRing =
      isAlert && n.type === "gate" ? (
        reduced ? (
          <circle cx={cx} cy={cy} r={18} fill="none" stroke="#ef4444" strokeWidth={2} opacity={0.8} />
        ) : (
          <circle cx={cx} cy={cy} r={13} fill="none" stroke="#ef4444" strokeWidth={2}>
            <animate attributeName="r" values="13;22;13" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.9;0;0.9" dur="1.6s" repeatCount="indefinite" />
          </circle>
        )
      ) : null;

    const youMarker =
      boundNodeId === n.id ? (
        <g>
          <circle cx={cx} cy={cy} r={n.type === "gate" ? 17 : 13} fill="none" stroke="#38bdf8" strokeWidth={2.5} strokeDasharray="4 3" />
          <text x={cx} y={cy - (n.type === "gate" ? 34 : 26)} textAnchor="middle" fontSize={10} fontWeight={700} fill="#38bdf8">{t("map.you")}</text>
        </g>
      ) : null;

    const selRing = isSel ? (
      <circle cx={cx} cy={cy} r={n.type === "gate" ? 17 : n.type === "section" ? 14 : 12} fill="none" stroke="#2dd4bf" strokeWidth={3} />
    ) : null;

    let shape: ReactElement;
    if (n.type === "section") {
      shape = (
        <g key={n.id} {...common}>
          {alertRing}
          <rect x={cx - 9} y={cy - 9} width={18} height={18} rx={3} fill={color} stroke={onRoute ? "#0b1220" : "#0006"} strokeWidth={onRoute ? 2 : 1} opacity={isClosed ? 0.3 : 1} />
          {labelEl}
          {selRing}
          {youMarker}
        </g>
      );
    } else if (n.type === "gate") {
      shape = (
        <g key={n.id} {...common}>
          {alertRing}
          <circle cx={cx} cy={cy} r={13} fill={color} stroke={onRoute ? "#fff" : "#0b1220"} strokeWidth={onRoute ? 3 : 2} opacity={isClosed ? 0.3 : 1} />
          {labelEl}
          {isClosed && (
            <g stroke="#ef4444" strokeWidth={3}>
              <line x1={cx - 11} y1={cy - 11} x2={cx + 11} y2={cy + 11} />
              <line x1={cx + 11} y1={cy - 11} x2={cx - 11} y2={cy + 11} />
            </g>
          )}
          {selRing}
          {youMarker}
        </g>
      );
    } else if (n.type === "entry") {
      shape = (
        <g key={n.id} {...common}>
          <rect x={cx - 16} y={cy - 10} width={32} height={20} rx={4} fill="#334155" stroke={isSel ? "#2dd4bf" : "#475569"} strokeWidth={isSel ? 2 : 1} />
          <text x={cx} y={cy + 5} textAnchor="middle" fontSize={11} fontWeight={700} fill="#e2e8f0">ENTRY</text>
          {youMarker}
        </g>
      );
    } else if (n.type === "transit") {
      // Width from the label length so "Rideshare Drop-off" doesn't overflow
      // (the old fixed 60px box clipped long transit labels).
      const tw = Math.max(64, n.label.length * 5.4 + 14);
      shape = (
        <g key={n.id} {...common}>
          <rect x={cx - tw / 2} y={cy - 9} width={tw} height={18} rx={4} fill={color} stroke={onRoute ? "#0b1220" : "#1d4ed8"} strokeWidth={onRoute ? 3 : 1.5} opacity={isClosed ? 0.3 : 0.95} />
          {labelEl}
          {selRing}
        </g>
      );
    } else if (n.type === "amenity") {
      shape = (
        <g key={n.id} {...common}>
          <circle cx={cx} cy={cy} r={6} fill={color} stroke="#0006" />
          {labelEl}
          {selRing}
        </g>
      );
    } else {
      shape = (
        <g key={n.id} {...common}>
          <circle cx={cx} cy={cy} r={6} fill={color} stroke="#0b1220" strokeWidth={1} />
          {selRing}
        </g>
      );
    }
    return shape;
  };

  const popover = selected ? (() => {
    const cx = proj.x(selected.id);
    const cy = proj.y(selected.id);
    const cardW = 168;
    const cardH = 78;
    const dx = cx + cardW + 12 > W ? cx - cardW - 12 : cx + 14;
    const dy = cy + cardH + 12 > H ? cy - cardH - 12 : cy + 14;
    const occ = occupancy[selected.id] ?? 0;
    const pct = Math.round(capacityPct(occ, selected.capacity) * 100);
    return (
      <g>
        <rect x={dx} y={dy} width={cardW} height={cardH} rx={8} fill="#0b1220" stroke="#2dd4bf" strokeWidth={1.5} opacity={0.97} />
        <text x={dx + 10} y={dy + 18} fontSize={12} fontWeight={700} fill="#e2e8f0">{selected.label}</text>
        <text x={dx + 10} y={dy + 34} fontSize={10} fill="#94a3b8">{pct}% load · {occ} ppl</text>
        {onRouteTo && (
          <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onRouteTo(selected.id); }}>
            <rect x={dx + 8} y={dy + 42} width={72} height={24} rx={5} fill="#2dd4bf" />
            <text x={dx + 44} y={dy + 58} textAnchor="middle" fontSize={11} fontWeight={700} fill="#0b1220">{t("map.routeHere")}</text>
          </g>
        )}
        {onRouteFrom && (
          <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onRouteFrom(selected.id); }}>
            <rect x={dx + 88} y={dy + 42} width={72} height={24} rx={5} fill="#334155" stroke="#475569" />
            <text x={dx + 124} y={dy + 58} textAnchor="middle" fontSize={11} fontWeight={700} fill="#e2e8f0">{t("map.fromHere")}</text>
          </g>
        )}
        <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onNodeSelect?.(null); }}>
          <text x={dx + cardW - 12} y={dy + 16} textAnchor="middle" fontSize={12} fill="#94a3b8">✕</text>
        </g>
      </g>
    );
  })() : null;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="h-full w-full touch-none select-none"
      style={{ cursor: view.scale > 1 ? "grab" : "default" }}
      role="img"
      aria-label="MetLife Stadium crowd map with the recommended route (scroll to zoom, drag to pan)"
      onClick={() => {
        if (!draggedRef.current) onNodeSelect?.(null);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <defs>
        <radialGradient id="mapVignette" cx="50%" cy="50%" r="62%">
          <stop offset="60%" stopColor="#070d18" stopOpacity={0} />
          <stop offset="100%" stopColor="#02040a" stopOpacity={0.9} />
        </radialGradient>
      </defs>
      <rect x={0} y={0} width={W} height={H} fill="#070d18" rx={16} />
      {/* Subtle radial vignette frames the bowl. */}
      <rect x={0} y={0} width={W} height={H} rx={16} fill="url(#mapVignette)" />

      {/* Pan/zoom group: all map content scales + pans together. */}
      <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
        <StadiumBowl proj={proj} />
        <g stroke="#243044" strokeWidth={2} opacity={0.85}>
          {EDGE_LIST.map((e, i) => (
            <line key={i} x1={proj.x(e.from)} y1={proj.y(e.from)} x2={proj.x(e.to)} y2={proj.y(e.to)} />
          ))}
        </g>
        {runnerUpPath && (
          <polyline points={pathPoints(runnerUpPath, proj)} fill="none" stroke="#94a3b8" strokeWidth={3} strokeDasharray="8 6" opacity={0.55} />
        )}
        {winnerPath && (
          <>
            <polyline points={pathPoints(winnerPath, proj)} fill="none" stroke="#2dd4bf" strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
            <RouteArrows path={winnerPath} proj={proj} />
          </>
        )}
        {NODE_LIST.map(nodeShape)}
        {popover}
      </g>

      {/* Fixed overlays (don't scale/pan). */}
      <Legend t={t} />
      <g transform={`translate(${W - 44} ${PAD})`}>
        <g className="map-btn" style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); zoomBy(1.3); }}>
          <rect x={0} y={0} width={28} height={28} rx={6} fill="#0b1220" stroke="#1f2937" />
          <text x={14} y={20} textAnchor="middle" fontSize={18} fontWeight={700} fill="#e2e8f0">+</text>
        </g>
        <g className="map-btn" style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); zoomBy(1 / 1.3); }}>
          <rect x={0} y={34} width={28} height={28} rx={6} fill="#0b1220" stroke="#1f2937" />
          <text x={14} y={55} textAnchor="middle" fontSize={20} fill="#e2e8f0">−</text>
        </g>
        <g className="map-btn" style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); reset(); }}>
          <rect x={0} y={68} width={28} height={28} rx={6} fill="#0b1220" stroke="#1f2937" />
          <text x={14} y={88} textAnchor="middle" fontSize={13} fill="#e2e8f0">⟲</text>
        </g>
      </g>
    </svg>
  );
}
