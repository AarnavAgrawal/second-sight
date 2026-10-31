// Radar scope: Leaflet map with range rings, sector boundary, targets with data blocks,
// velocity vectors, short history trails, and conflict alert lines.
// The map is created once; markers are updated in place by ICAO hex.
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { destination } from "@shared/geo.ts";
import type { Airport, ConflictAlert, Handoff, Sector, TrafficEntry } from "@shared/types.ts";
import { dataBlock } from "../format.ts";

// CARTO dark tiles now return an "API KEY REQUIRED" watermark, so the default is Esri's keyless,
// label-free World Dark Gray Base. Override with VITE_TILE_URL / VITE_TILE_ATTRIBUTION.
const TILE_URL: string =
  (import.meta.env.VITE_TILE_URL as string | undefined) ??
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTRIBUTION: string =
  (import.meta.env.VITE_TILE_ATTRIBUTION as string | undefined) ??
  'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';

type BlockPos = "ne" | "nw" | "se" | "sw";
const BLOCK_POSITIONS: BlockPos[] = ["ne", "nw", "se", "sw"];
const LEADER_PX = 21;

const NM_M = 1852;
const VECTOR_SEC = 60;
const TRAIL_LEN = 6;

interface Props {
  airport: Airport | null;
  radiusNm: number;
  traffic: TrafficEntry[];
  trackControl: Record<string, Sector>;
  handoffs: Handoff[];
  conflicts: ConflictAlert[];
  selectedHex: string | null;
  highlight: Set<string> | null;
  onSelect: (hex: string | null) => void;
}

interface Target {
  marker: L.Marker;
  vector: L.Polyline;
  trail: L.Polyline;
  history: L.LatLng[];
  html: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function Scope(props: Props) {
  const { airport, radiusNm, traffic, trackControl, handoffs, conflicts, selectedHex, highlight, onSelect } = props;
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const rendererRef = useRef<L.Canvas | null>(null);
  const staticRef = useRef<L.LayerGroup | null>(null);
  const caRef = useRef<L.LayerGroup | null>(null);
  const targetsRef = useRef(new Map<string, Target>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const fitRef = useRef<() => void>(() => {});
  const posRef = useRef(new Map<string, BlockPos>());
  const trafficRef = useRef<TrafficEntry[]>(traffic);
  trafficRef.current = traffic;
  const selectedRef = useRef(selectedHex);
  selectedRef.current = selectedHex;

  // Greedy data block placement: put each block in the corner (NE/NW/SE/SW) with the least overlap,
  // most important aircraft first, preferring the corner it already had to avoid jitter.
  const layoutRef = useRef(() => {});
  layoutRef.current = () => {
    const map = mapRef.current;
    if (!map) return;
    const fontPx = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.95;
    const charW = fontPx * 0.62;
    const h = fontPx * 2.35;
    const rank = (t: TrafficEntry) => (t.hex === selectedRef.current ? 0 : t.ca ? 1 : t.status !== "none" ? 2 : 3);
    const list = [...trafficRef.current].sort((a, b) => rank(a) - rank(b));
    const pts = new Map(list.map((t) => [t.hex, map.latLngToContainerPoint([t.lat, t.lon])]));
    type Rect = { x: number; y: number; w: number; h: number };
    const placed: Rect[] = [...pts.values()].map((p) => ({ x: p.x - 8, y: p.y - 9, w: 16, h: 18 }));
    const overlap = (a: Rect, b: Rect) =>
      Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const next = new Map<string, BlockPos>();
    for (const t of list) {
      const p = pts.get(t.hex)!;
      const w = Math.max(9, (t.callsign || t.hex).length + (t.ca ? 3 : 0), 11) * charW;
      const rectFor = (pos: BlockPos): Rect => ({
        x: pos === "ne" || pos === "se" ? p.x + LEADER_PX : p.x - LEADER_PX - w,
        y: pos === "ne" || pos === "nw" ? p.y - h - 2 : p.y,
        w,
        h,
      });
      const prev = posRef.current.get(t.hex) ?? "ne";
      let best: BlockPos = prev;
      let bestScore = Infinity;
      for (const pos of [prev, ...BLOCK_POSITIONS.filter((q) => q !== prev)]) {
        const r = rectFor(pos);
        let s = 0;
        for (const o of placed) s += overlap(r, o);
        if (s < bestScore - 20) {
          best = pos;
          bestScore = s;
        }
        if (s === 0) break;
      }
      placed.push(rectFor(best));
      next.set(t.hex, best);
      const el = targetsRef.current.get(t.hex)?.marker.getElement();
      if (el && el.dataset.pos !== best) el.dataset.pos = best;
    }
    posRef.current = next;
  };

  // Create the map once.
  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, {
      zoomControl: false,
      attributionControl: true,
      zoomSnap: 0.25,
      center: [39.5, -98.35],
      zoom: 4,
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer(TILE_URL, {
      subdomains: "abcd",
      maxZoom: 18,
      maxNativeZoom: 16,
      className: "scope-tiles",
      attribution: TILE_ATTRIBUTION,
    }).addTo(map);
    map.on("zoomend moveend", () => layoutRef.current());
    rendererRef.current = L.canvas({ padding: 0.3 });
    staticRef.current = L.layerGroup().addTo(map);
    caRef.current = L.layerGroup().addTo(map);
    map.on("click", () => onSelectRef.current(null));
    mapRef.current = map;
    // Refit the airspace whenever the scope is resized (window resize, projector fullscreen).
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => fitRef.current(), 150);
    });
    ro.observe(divRef.current);
    return () => {
      clearTimeout(resizeTimer);
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      targetsRef.current.clear();
    };
  }, []);

  // Airport geometry: rings, boundary, sector tint, labels.
  useEffect(() => {
    const map = mapRef.current;
    const group = staticRef.current;
    if (!map || !group) return;
    group.clearLayers();
    for (const t of targetsRef.current.values()) {
      t.marker.remove();
      t.vector.remove();
      t.trail.remove();
    }
    targetsRef.current.clear();
    fitRef.current = () => {};
    if (!airport) return;
    const c = L.latLng(airport.lat, airport.lon);
    const r = radiusNm;
    const renderer = rendererRef.current ?? undefined;

    // Sector tint: half-discs north and south of the boundary.
    const half = (fromDeg: number) => {
      const pts: L.LatLngExpression[] = [];
      for (let b = fromDeg; b <= fromDeg + 180; b += 6) {
        const p = destination(airport.lat, airport.lon, b, r);
        pts.push([p.lat, p.lon]);
      }
      return pts;
    };
    L.polygon(half(270), { renderer, stroke: false, fillColor: "#36c6e0", fillOpacity: 0.05, interactive: false }).addTo(group);
    L.polygon(half(90), { renderer, stroke: false, fillColor: "#e05bd3", fillOpacity: 0.05, interactive: false }).addTo(group);

    for (let nm = 10; nm <= r; nm += 10) {
      L.circle(c, { renderer, radius: nm * NM_M, color: "#5e7a73", weight: 1, opacity: 0.55, fill: false, interactive: false }).addTo(group);
      const lp = destination(airport.lat, airport.lon, 45, nm);
      L.marker([lp.lat, lp.lon], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: "ring-label", html: `${nm}`, iconSize: [0, 0] }),
      }).addTo(group);
    }
    L.circle(c, { renderer, radius: r * NM_M, color: "#8fb3a8", weight: 1.5, opacity: 0.8, fill: false, interactive: false }).addTo(group);

    const west = destination(airport.lat, airport.lon, 270, r);
    const east = destination(airport.lat, airport.lon, 90, r);
    L.polyline(
      [
        [airport.lat, west.lon],
        [airport.lat, east.lon],
      ],
      { renderer, color: "#d9e4e0", weight: 2, opacity: 0.7, dashArray: "10 8", interactive: false },
    ).addTo(group);
    const labelAt = (lat: number, lon: number, cls: string, html: string) =>
      L.marker([lat, lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: cls, html, iconSize: [0, 0] }) }).addTo(group);
    // Sector names sit just inside the outer ring (top and bottom), where traffic is sparsest.
    const nLbl = destination(airport.lat, airport.lon, 0, r * 0.94);
    const sLbl = destination(airport.lat, airport.lon, 180, r * 0.94);
    labelAt(nLbl.lat, nLbl.lon, "sector-label north", "NORTH");
    labelAt(sLbl.lat, sLbl.lon, "sector-label south", "SOUTH");
    labelAt(airport.lat, airport.lon, "airport-label", `<span class="ap-cross">+</span><span class="ap-name">${esc(airport.icao)}</span>`);

    const sw = destination(airport.lat, airport.lon, 225, r * Math.SQRT2);
    const ne = destination(airport.lat, airport.lon, 45, r * Math.SQRT2);
    fitRef.current = () =>
      map.fitBounds(
        [
          [sw.lat, sw.lon],
          [ne.lat, ne.lon],
        ],
        { padding: [8, 8], animate: false },
      );
    fitRef.current();
  }, [airport?.icao, airport?.lat, airport?.lon, radiusNm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Targets.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !airport) return;
    const renderer = rendererRef.current ?? undefined;
    const pendingHandoff = new Set(handoffs.filter((h) => h.state === "pending").map((h) => h.hex));
    const live = new Set<string>();
    const targets = targetsRef.current;

    for (const t of traffic) {
      live.add(t.hex);
      const sector = trackControl[t.hex] ?? t.sector;
      const pos = L.latLng(t.lat, t.lon);
      const coasting = t.status === "coasting";
      const cls = [
        "tgt",
        `st-${t.status}`,
        sector ? `sec-${sector.toLowerCase()}` : "sec-none",
        pendingHandoff.has(t.hex) ? "blink" : "",
        t.hex === selectedHex ? "sel" : "",
        highlight && !highlight.has(t.hex) ? "dim" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const sym = sector ? sector[0] : "•";
      const html =
        `<div class="${cls}"><div class="sym">${sym}</div><div class="leader"></div>` +
        `<div class="db"><div class="l1">${esc(t.callsign || t.hex.toUpperCase())}${t.ca ? '<span class="ca">CA</span>' : ""}</div>` +
        `<div class="l2">${esc(dataBlock(t.altFt, t.vertRateFpm, t.gsKt))}${coasting ? '<span class="cst">CST</span>' : ""}` +
        `${pendingHandoff.has(t.hex) ? '<span class="ho">HO</span>' : ""}</div></div></div>`;
      const ahead = destination(t.lat, t.lon, t.trackTrueDeg, (t.gsKt / 3600) * VECTOR_SEC);
      const color = sector === "NORTH" ? "#36c6e0" : sector === "SOUTH" ? "#e05bd3" : "#c9d3cf";

      let tg = targets.get(t.hex);
      if (!tg) {
        const marker = L.marker(pos, {
          keyboard: false,
          icon: L.divIcon({ className: "tgt-icon", html, iconSize: [0, 0] }),
        }).addTo(map);
        const hex = t.hex;
        marker.on("click", () => onSelectRef.current(hex));
        const vector = L.polyline([pos, [ahead.lat, ahead.lon]], { renderer, color, weight: 1.5, opacity: 0.8, interactive: false }).addTo(map);
        const trail = L.polyline([pos], { renderer, color, weight: 2, opacity: 0.35, dashArray: "2 7", lineCap: "round", interactive: false }).addTo(map);
        tg = { marker, vector, trail, history: [pos], html };
        targets.set(t.hex, tg);
      } else {
        tg.marker.setLatLng(pos);
        if (tg.html !== html) {
          const el = tg.marker.getElement();
          if (el) el.innerHTML = html;
          tg.html = html;
        }
        const last = tg.history[tg.history.length - 1];
        if (!last || last.distanceTo(pos) > 50) tg.history = [...tg.history.slice(-(TRAIL_LEN - 1)), pos];
        tg.vector.setLatLngs([pos, [ahead.lat, ahead.lon]]);
        tg.vector.setStyle({ color, opacity: highlight && !highlight.has(t.hex) ? 0.25 : 0.8 });
        tg.trail.setLatLngs(tg.history);
        tg.trail.setStyle({ color });
      }
      tg.marker.setZIndexOffset(t.hex === selectedHex ? 2000 : t.ca ? 1000 : 0);
    }
    for (const [hex, tg] of targets) {
      if (live.has(hex)) continue;
      tg.marker.remove();
      tg.vector.remove();
      tg.trail.remove();
      targets.delete(hex);
    }
    layoutRef.current();

    // Conflict alert lines.
    const ca = caRef.current;
    if (ca) {
      ca.clearLayers();
      const byHex = new Map(traffic.map((t) => [t.hex, t]));
      for (const c of conflicts) {
        if (c.state === "resolved") continue;
        const a = byHex.get(c.hexA);
        const b = byHex.get(c.hexB);
        if (!a || !b) continue;
        L.polyline(
          [
            [a.lat, a.lon],
            [b.lat, b.lon],
          ],
          { renderer, color: "#ff4545", weight: 2.5, dashArray: "8 6", opacity: 0.95, interactive: false },
        ).addTo(ca);
        L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "ca-label",
            html: `CA ${c.predictedLatNm.toFixed(1)}NM/${Math.round(c.predictedVertFt)}FT ${Math.round(c.inSec)}s`,
            iconSize: [0, 0],
          }),
        }).addTo(ca);
      }
    }
  }, [airport, traffic, trackControl, handoffs, conflicts, selectedHex, highlight]);

  return <div ref={divRef} className="scope-map" />;
}
