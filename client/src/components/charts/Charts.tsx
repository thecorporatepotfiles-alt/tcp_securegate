import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ReactNode } from 'react';
import { AXIS, ChartTooltip, GRID, INK2, axisTick, compactTick, maxOf, niceTicks } from './chartKit';

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

/** Change over time: 2px lines, crosshair tooltip listing every series at that X. */
export function ActivityLines({ data, series, xKey, height = 260, xLabel }: { data: Record<string, unknown>[]; series: SeriesDef[]; xKey: string; height?: number; xLabel?: (v: string) => string }) {
  const ticks = niceTicks(maxOf(data, series.map((s) => s.key)));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: AXIS }} minTickGap={18} interval="preserveStartEnd" tickFormatter={xLabel} />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} width={36} tickFormatter={compactTick} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} />
        <Tooltip cursor={{ stroke: AXIS, strokeWidth: 1 }} content={<ChartTooltip labelFormatter={(l) => (xLabel ? xLabel(String(l)) : String(l))} />} />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4.5, fill: s.color, stroke: '#ffffff', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Grouped columns (e.g. entries vs exits per location). */
export function GroupedColumns({ data, series, xKey, height = 260 }: { data: Record<string, unknown>[]; series: SeriesDef[]; xKey: string; height?: number }) {
  const ticks = niceTicks(maxOf(data, series.map((s) => s.key)));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: AXIS }} interval={0} tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)} />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} width={36} tickFormatter={compactTick} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} />
        <Tooltip cursor={{ fill: 'rgba(16,34,25,0.04)' }} content={<ChartTooltip />} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Horizontal bars. One series (with optional per-bar colors and value labels
 * at the tip) or several grouped series with a legend.
 */
export function HorizontalBars({
  data,
  series,
  yKey,
  labelWidth = 150,
  rowHeight = 30,
  colorOf,
  valueLabels = true,
  tooltipExtra,
}: {
  data: Record<string, unknown>[];
  series: SeriesDef[];
  yKey: string;
  labelWidth?: number;
  rowHeight?: number;
  colorOf?: (row: Record<string, unknown>) => string;
  valueLabels?: boolean;
  tooltipExtra?: (row: Record<string, unknown>) => ReactNode;
}) {
  const height = Math.max(120, data.length * rowHeight * (series.length > 1 ? 1.35 : 1) + 36);
  const ticks = niceTicks(maxOf(data, series.map((s) => s.key)));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: valueLabels ? 44 : 12, left: 0, bottom: 0 }} barGap={2} barCategoryGap="24%">
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={compactTick} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} />
        <YAxis
          type="category"
          dataKey={yKey}
          tick={{ ...axisTick, fill: INK2 }}
          tickLine={false}
          axisLine={{ stroke: AXIS }}
          width={labelWidth}
          interval={0}
          tickFormatter={(v: string) => {
            const max = Math.floor(labelWidth / 6.4);
            return v.length > max ? `${v.slice(0, max - 1)}…` : v;
          }}
        />
        <Tooltip cursor={{ fill: 'rgba(16,34,25,0.04)' }} content={<ChartTooltip extra={tooltipExtra} />} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false}>
            {colorOf && data.map((row, i) => <Cell key={i} fill={colorOf(row)} />)}
            {valueLabels && series.length === 1 && (
              <LabelList dataKey={s.key} position="right" style={{ fill: INK2, fontSize: 11, fontVariantNumeric: 'tabular-nums' }} formatter={(v: number) => v.toLocaleString('en-IN')} />
            )}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
