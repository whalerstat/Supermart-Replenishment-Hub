// client/src/components/ForecastChart.tsx — 4 weeks of actuals, 2 weeks of forecast with a P10–P90
// band, and the context the decision needs: projected stock and the stock-out day (Signal 1), or
// the stock in hand joined to the purchase-order window (Signal 2). One y-axis (units), plain SVG on the
// theme's series tokens, a legend, a crosshair tooltip, and a table view for screen readers.
import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { cn } from '../lib/utils';
import { dLong, dShort, nf, type SeriesPoint, type SignalPayload } from '../lib/api';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.max(280, Math.round(el.getBoundingClientRect().width)));
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const PAD = { top: 22, right: 16, bottom: 26, left: 40 };

/** Round step (1, 2, 2.5, 5 × 10^k) so the axis reads 0, 20, 40, 60 rather than 0, 13, 25, 38. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
function niceScale(v: number, ticks = 4): { max: number; step: number } {
  const step = niceStep(Math.max(v, 1) / ticks);
  return { max: Math.ceil(Math.max(v, 1) / step) * step, step };
}

function Swatch({ kind, className }: { kind: 'line' | 'dash' | 'band' | 'step' | 'area'; className: string }) {
  return (
    <svg width="22" height="10" aria-hidden className="shrink-0">
      {kind === 'band' || kind === 'area' ? (
        <rect x="1" y="1" width="20" height="8" rx="2" className={className} />
      ) : (
        <line
          x1="1"
          x2="21"
          y1="5"
          y2="5"
          strokeWidth="2"
          strokeDasharray={kind === 'dash' ? '4 3' : undefined}
          className={className}
        />
      )}
    </svg>
  );
}

export function ForecastChart({ signal }: { signal: SignalPayload }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pts = signal.series;
  const c = signal.chart;
  const H = W < 520 ? 210 : 250;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const today = Math.max(
    0,
    pts.findIndex((p) => p.date === c.today)
  );
  const vals = pts
    .flatMap((p) => [
      p.actual,
      p.p90,
      c.showStock ? p.stock : undefined,
      c.showLy && !c.showStockLevel ? p.ly : undefined,
      c.showStockLevel ? p.stock_level : undefined,
    ])
    .filter((v): v is number => v !== undefined);
  const perDay = c.window?.perDay;
  const { max, step: tickStep } = niceScale(Math.max(...vals, perDay ?? 0, 1) * 1.05);
  const step = innerW / Math.max(pts.length - 1, 1);
  const x = (i: number) => PAD.left + i * step;
  const y = (v: number) => PAD.top + innerH - (Math.max(0, v) / max) * innerH;
  const line = (get: (p: SeriesPoint) => number | undefined, from = 0, to = pts.length - 1) => {
    let d = '';
    for (let i = from; i <= to; i++) {
      const v = get(pts[i]);
      if (v === undefined) continue;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    }
    return d;
  };
  const stepLine = (get: (p: SeriesPoint) => number | undefined) => {
    let d = '';
    for (let i = today; i < pts.length; i++) {
      const v = get(pts[i]);
      if (v === undefined) continue;
      d += d ? `H${x(i).toFixed(1)}V${y(v).toFixed(1)}` : `M${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    }
    return d;
  };
  const band = (() => {
    const idx = pts.map((p, i) => (p.p10 !== undefined ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) return '';
    const up = idx.map((i) => `${x(i).toFixed(1)},${y(pts[i].p90!).toFixed(1)}`).join(' L');
    const down = [...idx]
      .reverse()
      .map((i) => `${x(i).toFixed(1)},${y(pts[i].p10!).toFixed(1)}`)
      .join(' L');
    return `M${up} L${down} Z`;
  })();
  const lastActual = today - 1;
  const forecastPath = line(
    (p) => p.forecast ?? (pts.indexOf(p) === lastActual ? p.actual : undefined),
    Math.max(0, lastActual)
  );
  const stockout = c.stockout ? pts.findIndex((p) => p.date === c.stockout) : -1;
  const win = c.window
    ? { a: pts.findIndex((p) => p.date === c.window!.from), b: pts.findIndex((p) => p.date === c.window!.to) }
    : null;
  // Stock in hand runs up to the order window and meets the "ordered per day" line where the window opens.
  const stockLevelPath = (() => {
    if (!c.showStockLevel) return '';
    const upTo = win && win.a > 0 ? win.a - 1 : pts.length - 1;
    let d = line((p) => p.stock_level, 0, upTo);
    if (d && win && win.a >= 0 && perDay !== undefined) d += `L${x(win.a).toFixed(1)},${y(perDay).toFixed(1)}`;
    return d;
  })();
  const ticks = Array.from({ length: Math.round(max / tickStep) + 1 }, (_, i) => i * tickStep);
  const labelEvery = W < 520 ? 14 : 7;

  function onMove(e: PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round((e.clientX - r.left) / step);
    setHover(Math.min(pts.length - 1, Math.max(0, i)));
  }
  const hp = hover !== null ? pts[hover] : null;
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover) + 12, 8), W - 196) : 0;
  const flipTip = hover !== null && x(hover) > W - 210;

  const legend = [
    { kind: 'line' as const, cls: 'stroke-series-demand', label: 'Units sold' },
    { kind: 'dash' as const, cls: 'stroke-series-demand', label: 'Forecast' },
    { kind: 'band' as const, cls: 'fill-series-demand/20', label: 'P10–P90 range' },
    ...(c.showStock
      ? [{ kind: 'step' as const, cls: 'stroke-series-stock', label: 'Projected stock at close, no action' }]
      : []),
    ...(perDay !== undefined
      ? [{ kind: 'line' as const, cls: 'stroke-brand', label: 'Ordered, per day of the order window' }]
      : []),
    ...(c.showStockLevel
      ? [{ kind: 'line' as const, cls: 'stroke-series-stock', label: 'Stock (units sold + 15% buffer)' }]
      : []),
    ...(c.showLy && !c.showStockLevel
      ? [{ kind: 'dash' as const, cls: 'stroke-series-ref', label: 'Last year, same weekday' }]
      : []),
  ];

  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {legend.map((l) => (
          <span key={l.label} className="flex items-center gap-1.5">
            <Swatch kind={l.kind} className={l.cls} />
            {l.label}
          </span>
        ))}
      </figcaption>
      <div ref={ref} className="relative w-full">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="block max-w-full touch-none"
          role="img"
          aria-label={`${signal.title}: daily units, actual and forecast`}
        >
          <rect
            x={x(today)}
            y={PAD.top}
            width={W - PAD.right - x(today)}
            height={innerH}
            className="fill-secondary/60"
          />
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(v)}
                y2={y(v)}
                className="stroke-chart-grid"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y(v) + 4}
                textAnchor="end"
                className="fill-chart-axis-label text-[11px] tabular-nums"
              >
                {nf(v)}
              </text>
            </g>
          ))}
          {win && win.a >= 0 && win.b >= 0 && (
            <g>
              <rect
                x={x(win.a) - step / 2}
                y={PAD.top}
                width={x(win.b) - x(win.a) + step}
                height={innerH}
                className="fill-brand/10 stroke-brand/50"
                strokeDasharray="3 3"
              />
              {perDay !== undefined && (
                <line
                  x1={x(win.a) - step / 2}
                  x2={x(win.b) + step / 2}
                  y1={y(perDay)}
                  y2={y(perDay)}
                  className="stroke-brand"
                  strokeWidth={2.5}
                />
              )}
              <text
                x={x(win.b) + step / 2 - 4}
                y={perDay !== undefined ? y(perDay) - 7 : PAD.top + 12}
                textAnchor="end"
                className="fill-foreground text-[11px] font-semibold"
              >
                {c.window!.label}
              </text>
            </g>
          )}
          {band && <path d={band} className="fill-series-demand/20" />}
          {c.showLy && !c.showStockLevel && (
            <path
              d={line((p) => p.ly)}
              fill="none"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              className="stroke-series-ref"
            />
          )}
          <path
            d={line((p) => p.actual)}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            className="stroke-series-demand"
          />
          <path
            d={forecastPath}
            fill="none"
            strokeWidth={2}
            strokeDasharray="5 4"
            strokeLinejoin="round"
            className="stroke-series-demand"
          />
          {stockLevelPath && (
            <path
              d={stockLevelPath}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              className="stroke-series-stock"
            />
          )}
          {c.showStock && (
            <path d={stepLine((p) => p.stock)} fill="none" strokeWidth={2} className="stroke-series-stock" />
          )}
          <line
            x1={x(today)}
            x2={x(today)}
            y1={PAD.top - 6}
            y2={PAD.top + innerH}
            className="stroke-foreground"
            strokeWidth={1}
          />
          <text x={x(today) + 4} y={PAD.top - 9} className="fill-foreground text-[11px] font-semibold">
            Today
          </text>
          {stockout >= 0 && (
            <g>
              <line
                x1={x(stockout)}
                x2={x(stockout)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                className="stroke-destructive"
                strokeWidth={1.5}
                strokeDasharray="3 3"
              />
              <circle cx={x(stockout)} cy={y(0)} r={4.5} className="fill-destructive stroke-card" strokeWidth={2} />
              <text x={x(stockout) + 6} y={y(0) - 8} className="fill-foreground text-[11px] font-semibold">
                All lines out {dShort(c.stockout!)}
              </text>
            </g>
          )}
          {pts.map((p, i) =>
            (i - today) % labelEvery === 0 ? (
              <text key={p.date} x={x(i)} y={H - 8} textAnchor="middle" className="fill-chart-axis-label text-[11px]">
                {dShort(p.date)}
              </text>
            ) : null
          )}
          {hp && hover !== null && (
            <g pointerEvents="none">
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                className="stroke-foreground/40"
                strokeWidth={1}
              />
              {[hp.actual, hp.forecast].map((v, k) =>
                v !== undefined ? (
                  <circle
                    key={k === 0 ? 'actual' : 'forecast'}
                    cx={x(hover)}
                    cy={y(v)}
                    r={4}
                    className="fill-series-demand stroke-card"
                    strokeWidth={2}
                  />
                ) : null
              )}
              {c.showStock && hp.stock !== undefined && (
                <circle
                  cx={x(hover)}
                  cy={y(hp.stock)}
                  r={4}
                  className="fill-series-stock stroke-card"
                  strokeWidth={2}
                />
              )}
              {c.showStockLevel && hp.stock_level !== undefined && (
                <circle
                  cx={x(hover)}
                  cy={y(hp.stock_level)}
                  r={3.5}
                  className="fill-series-stock stroke-card"
                  strokeWidth={2}
                />
              )}
              {c.showLy && !c.showStockLevel && hp.ly !== undefined && (
                <circle cx={x(hover)} cy={y(hp.ly)} r={3.5} className="fill-series-ref stroke-card" strokeWidth={2} />
              )}
            </g>
          )}
          <rect
            x={PAD.left - step / 2}
            y={PAD.top}
            width={innerW + step}
            height={innerH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hp && hover !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-[188px] rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md"
            style={flipTip ? { left: Math.max(8, x(hover) - 200) } : { left: tipLeft }}
          >
            <p className="m-0 mb-1 font-semibold">{dLong(hp.date)}</p>
            {hp.actual !== undefined && <TipRow cls="bg-series-demand" label="Units sold" value={nf(hp.actual)} />}
            {hp.forecast !== undefined && <TipRow cls="bg-series-demand" label="Forecast" value={nf(hp.forecast)} />}
            {hp.p10 !== undefined && (
              <TipRow cls="bg-series-demand/30" label="P10–P90" value={`${nf(hp.p10)}–${nf(hp.p90 ?? 0)}`} />
            )}
            {c.showStock && hp.stock !== undefined && (
              <TipRow cls="bg-series-stock" label="Stock at close" value={nf(hp.stock)} />
            )}
            {c.showStockLevel && hp.stock_level !== undefined && (
              <TipRow cls="bg-series-stock" label="Stock" value={nf(hp.stock_level)} />
            )}
            {c.showLy && !c.showStockLevel && hp.ly !== undefined && (
              <TipRow cls="bg-series-ref" label="Last year" value={nf(hp.ly)} />
            )}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{signal.title}: daily values</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Units sold</th>
            <th>Forecast</th>
            {c.showStock && <th>Projected on hand</th>}
            {c.showStockLevel && <th>Stock (units sold + 15% buffer)</th>}
            {c.showLy && !c.showStockLevel && <th>Last year</th>}
          </tr>
        </thead>
        <tbody>
          {pts.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td>{p.actual ?? ''}</td>
              <td>{p.forecast ?? ''}</td>
              {c.showStock && <td>{p.stock ?? ''}</td>}
              {c.showStockLevel && <td>{p.stock_level ?? ''}</td>}
              {c.showLy && !c.showStockLevel && <td>{p.ly ?? ''}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function TipRow({ cls, label, value }: { cls: string; label: string; value: string }) {
  return (
    <p className="m-0 flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', cls)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-medium tabular-nums">{value}</span>
    </p>
  );
}

/** Small bar chart of the customer-behaviour driver (Signal 1): members departing in 2–10 days. */
export function DriverBars({ signal }: { signal: SignalPayload }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pts = signal.series;
  const H = 96;
  const pad = { top: 8, right: PAD.right, bottom: 20, left: PAD.left };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const step = innerW / Math.max(pts.length - 1, 1);
  const { max } = niceScale(Math.max(...pts.map((p) => p.driver ?? 0), 1), 2);
  const x = (i: number) => pad.left + i * step;
  const today = Math.max(
    0,
    pts.findIndex((p) => p.date === signal.chart.today)
  );
  const bw = Math.max(2, step - 2);
  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block max-w-full"
        role="img"
        aria-label={`${signal.chart.driverLabel ?? 'Driver'} by day`}
      >
        <line
          x1={pad.left}
          x2={W - pad.right}
          y1={pad.top + innerH}
          y2={pad.top + innerH}
          className="stroke-chart-grid"
        />
        <text
          x={pad.left - 6}
          y={pad.top + 8}
          textAnchor="end"
          className="fill-chart-axis-label text-[11px] tabular-nums"
        >
          {nf(max)}
        </text>
        {pts.map((p, i) => {
          const h = ((p.driver ?? 0) / max) * innerH;
          return (
            <rect
              key={p.date}
              x={x(i) - bw / 2}
              y={pad.top + innerH - h}
              width={bw}
              height={Math.max(h, 1)}
              rx={Math.min(2, bw / 2)}
              className={cn(
                i >= today ? 'fill-series-driver' : 'fill-series-driver/55',
                hover === i && 'fill-foreground'
              )}
            />
          );
        })}
        <line
          x1={x(today) - step / 2}
          x2={x(today) - step / 2}
          y1={pad.top - 4}
          y2={pad.top + innerH}
          className="stroke-foreground"
        />
        {pts.map((p, i) =>
          (i - today) % 14 === 0 ? (
            <text key={p.date} x={x(i)} y={H - 6} textAnchor="middle" className="fill-chart-axis-label text-[11px]">
              {dShort(p.date)}
            </text>
          ) : null
        )}
        <rect
          x={pad.left - step / 2}
          y={pad.top}
          width={innerW + step}
          height={innerH}
          fill="transparent"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(Math.min(pts.length - 1, Math.max(0, Math.round((e.clientX - r.left) / step))));
          }}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && pts[hover] && (
        <div
          className="pointer-events-none absolute -top-8 z-10 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: Math.min(Math.max(x(hover) - 70, 4), W - 150) }}
        >
          <span className="font-semibold">{dShort(pts[hover].date)}</span>
          <span className="text-muted-foreground"> · </span>
          <span className="tabular-nums">{nf(pts[hover].driver ?? 0)} members departing</span>
        </div>
      )}
    </div>
  );
}
