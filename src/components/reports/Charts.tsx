/**
 * Hand-rolled SVG charts. No charting dependency: the datasets here are a
 * handful of points, the shapes needed are bars and one polyline, and the app
 * already draws its most complex visualization (the occupancy grid) by hand.
 *
 * Both charts use a fixed viewBox and scale with `w-full`, so text and strokes
 * stay proportional without a resize observer. Colors come from theme tokens
 * (fill-primary, stroke-border) so dark mode is handled by the same variables
 * the rest of the app uses.
 */

export type ChartPoint = { label: string; value: number }

const VIEW_W = 640
const PAD = { top: 12, right: 8, bottom: 26, left: 52 }

/** Keep x labels readable by showing at most ~10 of them, evenly spaced. */
function labelStride(count: number): number {
  return count <= 10 ? 1 : Math.ceil(count / 10)
}

function EmptyPlot({ height, message }: { height: number; message: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
      style={{ height }}
    >
      {message}
    </div>
  )
}

type ChartProps = {
  data: ChartPoint[]
  /** Formats a raw value for the y-axis and the accessible summary. */
  format: (value: number) => string
  ariaLabel: string
  height?: number
  /** Force the top of the y axis (occupancy uses 100). Default: data max. */
  yMax?: number
  emptyMessage?: string
}

export function BarChart({
  data,
  format,
  ariaLabel,
  height = 200,
  yMax,
  emptyMessage = 'No data in this range',
}: ChartProps) {
  if (data.length === 0) {
    return <EmptyPlot height={height} message={emptyMessage} />
  }

  const plotW = VIEW_W - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const top = Math.max(yMax ?? Math.max(...data.map((d) => d.value)), 1)
  const slot = plotW / data.length
  const barW = Math.max(Math.min(slot * 0.62, 44), 2)
  const stride = labelStride(data.length)

  return (
    <svg
      role="img"
      aria-label={`${ariaLabel}. ${data
        .map((d) => `${d.label}: ${format(d.value)}`)
        .join('; ')}`}
      viewBox={`0 0 ${VIEW_W} ${height}`}
      className="h-auto w-full"
    >
      {[0, 0.5, 1].map((tick) => {
        const y = PAD.top + plotH - tick * plotH
        return (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {format(top * tick)}
            </text>
          </g>
        )
      })}

      {data.map((point, index) => {
        const barH = top > 0 ? (point.value / top) * plotH : 0
        const x = PAD.left + index * slot + (slot - barW) / 2
        return (
          <g key={`${point.label}-${index}`}>
            <rect
              x={x}
              y={PAD.top + plotH - barH}
              width={barW}
              height={Math.max(barH, point.value > 0 ? 2 : 0)}
              rx={2}
              className="fill-primary"
            />
            {index % stride === 0 && (
              <text
                x={x + barW / 2}
                y={height - 8}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {point.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export function LineChart({
  data,
  format,
  ariaLabel,
  height = 200,
  yMax,
  emptyMessage = 'No data in this range',
}: ChartProps) {
  if (data.length === 0) {
    return <EmptyPlot height={height} message={emptyMessage} />
  }

  const plotW = VIEW_W - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const top = Math.max(yMax ?? Math.max(...data.map((d) => d.value)), 1)
  // A single point has no span to divide, so pin it to the left edge.
  const step = data.length > 1 ? plotW / (data.length - 1) : 0
  const stride = labelStride(data.length)

  const coords = data.map((point, index) => ({
    ...point,
    x: PAD.left + index * step,
    y: PAD.top + plotH - (point.value / top) * plotH,
  }))

  return (
    <svg
      role="img"
      aria-label={`${ariaLabel}. ${data
        .map((d) => `${d.label}: ${format(d.value)}`)
        .join('; ')}`}
      viewBox={`0 0 ${VIEW_W} ${height}`}
      className="h-auto w-full"
    >
      {[0, 0.5, 1].map((tick) => {
        const y = PAD.top + plotH - tick * plotH
        return (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {format(top * tick)}
            </text>
          </g>
        )
      })}

      {coords.length > 1 && (
        <polyline
          fill="none"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          className="stroke-primary"
          points={coords.map((c) => `${c.x},${c.y}`).join(' ')}
        />
      )}

      {coords.map((c, index) => (
        <g key={`${c.label}-${index}`}>
          <circle cx={c.x} cy={c.y} r={2.5} className="fill-primary" />
          {index % stride === 0 && (
            <text
              x={c.x}
              y={height - 8}
              textAnchor="middle"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {c.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}
