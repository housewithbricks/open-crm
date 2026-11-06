import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/format";

/** Width of an element, kept in sync on resize. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Tooltip that follows a hovered mark inside a positioned container. */
export function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute z-[5] min-w-[120px] -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-panel px-2.5 py-2 text-xs shadow-pop [&>b]:mb-1 [&>b]:block"
      style={{ left: x, top: y }}>
      {children}
    </div>
  );
}

export type Series = { key: string; label: string; color: string };

/**
 * Stacked daily columns (e.g. changes by you vs agents). One y-axis, recessive grid,
 * 2px surface gap between stacked segments, 4px rounded top, per-column hover tooltip.
 */
export function StackedColumns({ data, series, height = 150, formatKey, formatValue = (v) => String(v), ariaLabel = "Chart" }: {
  /** One entry per column: its x key plus a number per series key. */
  data: ({ key: string } & Record<string, number | string>)[];
  series: Series[];
  height?: number;
  formatKey: (k: string) => string;
  formatValue?: (v: number) => string;
  ariaLabel?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 44, padB = 20, padT = 6;
  const plotW = Math.max(0, width - padL);
  const plotH = height - padB - padT;
  const totals = data.map((d) => series.reduce((s, x) => s + Number(d[x.key] ?? 0), 0));
  const rawMax = Math.max(1, ...totals);
  // A "nice" step (1, 2, 5 × 10^n) so ticks land on round numbers.
  const mag = 10 ** Math.floor(Math.log10(rawMax / 4 || 1));
  const counts = data.every((d) => series.every((s) => Number.isInteger(Number(d[s.key] ?? 0))));
  const niceStep = [1, 2, 5, 10].map((m) => m * mag).find((x) => rawMax / x <= 5) ?? 10 * mag;
  const step = counts ? Math.max(1, Math.round(niceStep)) : niceStep; // whole-number data → whole-number ticks
  const max = Math.ceil(rawMax / step) * step;
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const slot = data.length ? plotW / data.length : 0;
  const barW = Math.max(3, Math.min(data.length <= 8 ? 28 : 14, slot - 4));
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  return (
    <div ref={ref} className="relative w-full" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width} y1={y(t)} y2={y(t)} className={t === 0 ? "stroke-line-2" : "stroke-line [stroke-dasharray:2_3]"} />
              <text x={padL - 6} y={y(t) + 3.5} className="fill-faint text-[10px] tabular-nums" textAnchor="end">{formatValue(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + slot * i + slot / 2;
            let acc = 0;
            const segs = series.map((s) => {
              const v = Number(d[s.key] ?? 0);
              const seg = { s, v, y0: acc, y1: acc + v };
              acc += v;
              return seg;
            }).filter((g) => g.v > 0);
            return (
              <g key={d.key}>
                {segs.map((g, j) => {
                  const top = y(g.y1);
                  const bottom = y(g.y0) - (j > 0 ? 2 : 0); // 2px gap between stacked segments
                  const h = Math.max(1, bottom - top);
                  const isTop = j === segs.length - 1;
                  return isTop ? (
                    <path key={g.s.key} fill={g.s.color} opacity={hover === null || hover === i ? 1 : 0.45}
                      d={roundedTop(cx - barW / 2, top, barW, h, Math.min(4, barW / 2, h))} />
                  ) : (
                    <rect key={g.s.key} x={cx - barW / 2} y={top} width={barW} height={h} fill={g.s.color} opacity={hover === null || hover === i ? 1 : 0.45} />
                  );
                })}
                <rect x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
          {(data.length <= 8 ? data.map((_, i) => i) : [0, Math.floor(data.length / 2), data.length - 1]).filter((i) => data[i]).map((i) => (
            <text key={i} x={padL + slot * i + slot / 2} y={height - 5} className="fill-faint text-[10px] tabular-nums"
              textAnchor={data.length > 8 && i === 0 ? "start" : data.length > 8 && i === data.length - 1 ? "end" : "middle"}>
              {formatKey(data[i].key)}
            </text>
          ))}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <Tip x={Math.min(Math.max(padL + slot * hover + slot / 2, 70), width - 70)} y={Math.max(y(totals[hover]) - 8, 64)}>
          <b>{formatKey(data[hover].key)}</b>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 text-ink-2">
              <i className="size-2 rounded-[2px]" style={{ background: s.color }} />{s.label}
              <span className="ml-auto pl-3 font-semibold text-ink tabular-nums">{formatValue(Number(data[hover][s.key] ?? 0))}</span>
            </div>
          ))}
        </Tip>
      )}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/** Horizontal bar rows: label on the left, value on the right, thin bar between. */
export function BarRows({ rows, format, onPick }: {
  rows: { key: string; label: ReactNode; value: number; color: string; detail?: string; muted?: boolean }[];
  format: (v: number) => string;
  onPick?: (key: string) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-0.5">
      {rows.map((r) => (
        <button key={r.key} type="button" onClick={() => onPick?.(r.key)} disabled={!onPick}
          className={cn("-mx-1.5 grid h-[34px] grid-cols-[minmax(110px,34%)_minmax(0,1fr)_auto] items-center gap-3 rounded-ctl px-1.5 text-left text-ink",
            onPick && "hover:bg-hover", r.muted && "opacity-60")}>
          <span className="inline-flex min-w-0 items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">{r.label}</span>
          <span className="h-2 overflow-hidden rounded bg-ink/6">
            <span className="block h-full rounded transition-[width] duration-300" style={{ width: `${Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100)}%`, background: r.color }} />
          </span>
          <span className="min-w-[72px] text-right font-medium tabular-nums">
            {format(r.value)}{r.detail && <small className="block text-[11px] leading-tight font-normal text-muted">{r.detail}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Tiny inline trend line for a KPI tile (single series, no axes). */
export function Sparkline({ values, color, width = 96, height = 28 }: { values: number[]; color: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 2, height - 3 - (v / max) * (height - 6)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} aria-hidden="true" className="flex-none">
      <path d={`${d} L${last[0]},${height} L2,${height} Z`} fill={color} opacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />
    </svg>
  );
}

/* ------------------------- series color safety check ------------------------- */

function oklab(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab distance ×100, the same scale the palette validator uses. */
export function deltaE(a: string, b: string) {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
}

/**
 * The "You" series uses the accent, unless the accent is too close to the agent teal
 * (e.g. a green accent). Then it falls back to indigo, which passes the palette check.
 */
export function youSeriesColor(accent: string | undefined, agent: string) {
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return "var(--accent)";
  return deltaE(accent, agent) < 20 ? "#6366f1" : "var(--accent)";
}
