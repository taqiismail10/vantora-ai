"use client";

/**
 * 30-day Cash-Flow-at-Risk fan chart.
 *
 * P90/P50/P10 percentile trajectories, the minimum safe buffer, the crunch-day
 * marker, and an optional overlay of the P10 line once the optimal plan runs.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { DashboardState } from "@/lib/dashboard-state";

import { money } from "./primitives";

const COLORS = {
  p90: "#059669", // emerald-600: optimistic
  p50: "#d97706", // amber-600: central
  p10: "#e11d48", // rose-600: downside
  recovered: "#1d4ed8", // blue-700: post-recovery overlay, distinct from the P90 green
  buffer: "#475569", // slate-600
};

export function FanChart({
  data,
  showRecovery,
}: {
  data: DashboardState;
  showRecovery: boolean;
}) {
  const { forecast, optimization, state, post_recovery_p10_trajectory } = data;
  const crunchDay = forecast.first_shortfall_day ?? optimization.crunch_day;

  const rows = forecast.p10_trajectory.map((p10, index) => ({
    day: index + 1,
    p10,
    p50: forecast.p50_trajectory[index],
    p90: forecast.p90_trajectory[index],
    band: [p10, forecast.p90_trajectory[index]] as [number, number],
    recovered: post_recovery_p10_trajectory[index],
  }));

  const crunchPayables = state.payables_ap.filter((p) => p.due_day === crunchDay);

  return (
    <div className="h-[420px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 16, right: 24, bottom: 8, left: 8 }}>
          <defs>
            <linearGradient id="vantora-fan" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS.p90} stopOpacity={0.16} />
              <stop offset="100%" stopColor={COLORS.p10} stopOpacity={0.1} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="2 4" stroke="currentColor" className="text-slate-200 dark:text-slate-800" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            label={{ value: "Day", position: "insideBottomRight", offset: -4, fontSize: 11 }}
          />
          <YAxis
            tickFormatter={(value: number) => money(value)}
            tickLine={false}
            axisLine={false}
            width={78}
            tick={{ fontSize: 11 }}
          />
          <Tooltip
            formatter={(value, name) =>
              Array.isArray(value)
                ? [`${money(Number(value[0]))} … ${money(Number(value[1]))}`, "P10–P90 band"]
                : [money(Number(value), 2), String(name)]
            }
            labelFormatter={(label) => `Day ${String(label)}`}
            contentStyle={{ fontSize: 12, borderRadius: 8, fontVariantNumeric: "tabular-nums" }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />

          {/* The buffer breach region, so the shortfall reads at a glance. */}
          <ReferenceArea
            y1={Math.min(...forecast.p10_trajectory, 0) * 1.05}
            y2={state.minimum_safe_buffer}
            fill={COLORS.p10}
            fillOpacity={0.04}
          />
          <Area
            type="monotone"
            dataKey="band"
            name="P10–P90 band"
            stroke="none"
            fill="url(#vantora-fan)"
            isAnimationActive={false}
            legendType="none"
          />

          <Line
            type="monotone"
            dataKey="p90"
            name="P90 (optimistic)"
            stroke={COLORS.p90}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="p50"
            name="P50 (central)"
            stroke={COLORS.p50}
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="p10"
            name="P10 (downside)"
            stroke={COLORS.p10}
            strokeWidth={2.25}
            dot={false}
            isAnimationActive={false}
          />
          {showRecovery ? (
            <Line
              type="monotone"
              dataKey="recovered"
              name="P10 after recovery plan"
              stroke={COLORS.recovered}
              strokeWidth={2}
              strokeDasharray="6 3"
              dot={false}
            />
          ) : null}

          <ReferenceLine
            y={state.minimum_safe_buffer}
            stroke={COLORS.buffer}
            strokeDasharray="6 4"
            label={{
              value: `Minimum safe buffer ${money(state.minimum_safe_buffer)}`,
              position: "insideTopLeft",
              fontSize: 11,
              fill: COLORS.buffer,
            }}
          />
          <ReferenceLine y={0} stroke={COLORS.buffer} strokeOpacity={0.4} />
          <ReferenceLine
            x={crunchDay}
            stroke={COLORS.p10}
            strokeWidth={1.5}
            label={{
              value: `Day ${crunchDay}: ${crunchPayables
                .map((p) => money(p.amount))
                .join(" + ")} due`,
              position: "top",
              fontSize: 11,
              fill: COLORS.p10,
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
