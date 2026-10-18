"use client";

/**
 * 30-day Cash-Flow-at-Risk fan chart.
 *
 * Two states, one chart: the baseline trajectory and the post-plan trajectory.
 * The P10 line animates between them so the recovery is something the viewer
 * watches happen rather than a second line they have to find.
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
  recovered: "#1d4ed8", // blue-700: post-recovery, distinct from the P90 green
  buffer: "#475569", // slate-600
  decision: "#b45309", // amber-700: the window that closes
};

/** Round the axis to $10k/$25k steps so ticks read as money, not as data. */
function roundTicks(min: number, max: number): number[] {
  const span = max - min;
  const raw = span / 6;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const step = [1, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

export function FanChart({
  data,
  showRecovery,
  showQuantMath,
}: {
  data: DashboardState;
  /** True = draw the P10 line as it runs with the plan executed. */
  showRecovery: boolean;
  /** True = reveal P90, the band and the percentile vocabulary. */
  showQuantMath: boolean;
}) {
  const { forecast, optimization, state, post_recovery_p10_trajectory } = data;
  const crunchDay = forecast.first_shortfall_day ?? optimization.crunch_day;
  const decisionDay = forecast.decision_day;

  const rows = forecast.p10_trajectory.map((p10, index) => ({
    day: index + 1,
    // One key, two states: Recharts tweens the path when the values change,
    // so toggling the control animates the recovery instead of cutting to it.
    p10: showRecovery ? post_recovery_p10_trajectory[index] : p10,
    p50: forecast.p50_trajectory[index],
    p90: forecast.p90_trajectory[index],
    band: [p10, forecast.p90_trajectory[index]] as [number, number],
  }));

  const crunchPayables = state.payables_ap.filter((p) => p.due_day === crunchDay);
  const floor = Math.min(...forecast.p10_trajectory, 0);
  const ceiling = Math.max(...forecast.p90_trajectory, state.minimum_safe_buffer);
  const ticks = roundTicks(floor, ceiling);
  const p10Name = showRecovery
    ? `With the ${money(optimization.optimal_plan.total_cost)} plan`
    : showQuantMath
      ? "P10 (downside)"
      : "If customers pay late (P10 downside)";

  return (
    <div className="h-[420px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 24, right: 24, bottom: 8, left: 8 }}>
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
            ticks={ticks}
            domain={[ticks[0], ticks[ticks.length - 1]]}
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
            contentStyle={{ fontSize: 12, borderRadius: 6, fontVariantNumeric: "tabular-nums" }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />

          {/* Two different problems, two different colours: amber is eating
              into the safety buffer, rose is running out of money outright. */}
          <ReferenceArea y1={0} y2={state.minimum_safe_buffer} fill={COLORS.p50} fillOpacity={0.07} />
          <ReferenceArea y1={ticks[0]} y2={0} fill={COLORS.p10} fillOpacity={0.09} />

          {/* The window in which the full lever set is still open. */}
          {decisionDay && crunchDay ? (
            <ReferenceArea
              x1={decisionDay}
              x2={crunchDay}
              fill={COLORS.decision}
              fillOpacity={0.1}
              label={{
                value: `Decision window · day ${decisionDay}→${crunchDay}`,
                position: "insideTop",
                fontSize: 10,
                fill: COLORS.decision,
              }}
            />
          ) : null}

          {showQuantMath ? (
            <Area
              type="monotone"
              dataKey="band"
              name="P10–P90 band"
              stroke="none"
              fill="url(#vantora-fan)"
              isAnimationActive={false}
              legendType="none"
            />
          ) : null}

          {showQuantMath ? (
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
          ) : null}
          <Line
            type="monotone"
            dataKey="p50"
            name={showQuantMath ? "P50 (central)" : "Typical timing (P50)"}
            stroke={COLORS.p50}
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="p10"
            name={p10Name}
            stroke={showRecovery ? COLORS.recovered : COLORS.p10}
            strokeWidth={2.5}
            dot={false}
            isAnimationActive
            animationDuration={500}
          />

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
          {crunchDay ? (
            <ReferenceLine
              x={crunchDay}
              stroke={COLORS.p10}
              strokeWidth={1.5}
              label={{
                value: `Day ${crunchDay}: ${crunchPayables.map((p) => money(p.amount)).join(" + ")} due`,
                position: "top",
                fontSize: 11,
                fill: COLORS.p10,
              }}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
