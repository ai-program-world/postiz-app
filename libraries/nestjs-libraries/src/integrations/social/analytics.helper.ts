import dayjs from 'dayjs';
import {
  Disconnect,
  RefreshToken,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { AnalyticsBreakdownItem } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

export interface DateWindow {
  since: number;
  until: number;
}

/**
 * Splits a lookback range of `days` ending at `endUnix` (defaults to end of today)
 * into non-overlapping [since, until] windows of at most `maxChunkDays` days.
 * Meta / Threads Insights APIs reject ranges wider than 30 days (2,592,000s),
 * so 28-day chunks safely cover 7, 30, and 90-day queries.
 */
export function splitDateWindows(
  days: number,
  maxChunkDays = 28,
  endMoment = dayjs().endOf('day')
): DateWindow[] {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days || 7)));
  const startMoment = endMoment.subtract(safeDays, 'day').startOf('day');
  const windows: DateWindow[] = [];

  let cursor = startMoment;
  while (cursor.isBefore(endMoment)) {
    const next = cursor.add(maxChunkDays, 'day');
    const chunkEnd = next.isBefore(endMoment) ? next : endMoment;
    windows.push({
      since: cursor.unix(),
      until: chunkEnd.unix(),
    });
    cursor = chunkEnd.add(1, 'second');
  }

  return windows;
}

/**
 * Builds the immediately preceding equal-length date windows for period-over-period comparison.
 */
export function previousDateWindows(
  days: number,
  maxChunkDays = 28,
  endMoment = dayjs().endOf('day')
): DateWindow[] {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days || 7)));
  const previousEnd = endMoment
    .subtract(safeDays, 'day')
    .startOf('day')
    .subtract(1, 'second');
  return splitDateWindows(safeDays, maxChunkDays, previousEnd);
}

/**
 * Deduplicates and sorts daily series points chronologically.
 */
export function mergeDailyPoints(
  points: Array<{ date: string; total: number | string }>
): Array<{ date: string; total: string }> {
  const byDate = new Map<string, number>();
  for (const pt of points || []) {
    if (!pt?.date) continue;
    const num = Number(pt.total);
    byDate.set(pt.date, Number.isFinite(num) ? num : 0);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, val]) => ({
      date,
      total: String(Number.isInteger(val) ? val : Number(val.toFixed(2))),
    }));
}

/**
 * Aggregates series values using sum, average, or latest semantics.
 */
export function aggregatePoints(
  points: Array<{ total: number | string }>,
  aggregation: 'sum' | 'average' | 'latest' = 'sum'
): number {
  if (!points || points.length === 0) return 0;
  const nums = points.map((p) => Number(p.total) || 0);
  if (aggregation === 'latest') {
    return nums[nums.length - 1] ?? 0;
  }
  const sum = nums.reduce((acc, v) => acc + v, 0);
  if (aggregation === 'average') {
    return sum / nums.length;
  }
  return sum;
}

/**
 * Computes period-over-period percentage change (or percentage-point delta when `isPercentPoint` is true).
 * Never returns hardcoded dummy values; returns 0 when insufficient baseline exists.
 */
export function computePercentageChange(
  current: number,
  previous?: number,
  isPercentPoint = false
): number {
  if (
    previous === undefined ||
    previous === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return 0;
  }
  if (isPercentPoint) {
    return Number((current - previous).toFixed(1));
  }
  if (previous <= 0) {
    return 0;
  }
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

/**
 * Computes trend change from a time series when no explicit prior window was queried:
 * - `latest`: compares last data point against first data point
 * - `sum` / `average`: compares second half average against first half average when >= 4 points
 */
export function computeSeriesTrend(
  points: Array<{ total: number | string; date: string }>,
  aggregation: 'sum' | 'average' | 'latest' = 'sum',
  isPercentPoint = false
): number {
  if (!points || points.length < 2) return 0;
  const nums = points.map((p) => Number(p.total) || 0);
  if (aggregation === 'latest') {
    return computePercentageChange(
      nums[nums.length - 1],
      nums[0],
      isPercentPoint
    );
  }
  if (nums.length < 4) return 0;
  const mid = Math.floor(nums.length / 2);
  const firstHalf = nums.slice(0, mid);
  const secondHalf = nums.slice(mid);
  const avg1 = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avg2 = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  return computePercentageChange(avg2, avg1, isPercentPoint);
}

/**
 * Normalizes a key-value map or array into sorted breakdown bars with percentages.
 */
export function buildBreakdown(
  entries: Array<{ label: string; value: number }> | Record<string, number>,
  limit = 12,
  preserveOrder = false
): AnalyticsBreakdownItem[] {
  const raw = Array.isArray(entries)
    ? entries
    : Object.entries(entries || {}).map(([label, value]) => ({
        label,
        value: Number(value) || 0,
      }));

  const filtered = raw
    .map((item) => ({
      label: String(item.label || '').trim(),
      value: Number(item.value) || 0,
    }))
    .filter((item) => item.label && item.value > 0);

  if (filtered.length === 0) return [];

  const total = filtered.reduce((acc, cur) => acc + cur.value, 0);
  const ordered = preserveOrder
    ? filtered
    : [...filtered].sort((a, b) => b.value - a.value);

  return ordered.slice(0, limit).map((item) => ({
    label: item.label,
    value: Number.isInteger(item.value)
      ? item.value
      : Number(item.value.toFixed(2)),
    percentage:
      total > 0 ? Number(((item.value / total) * 100).toFixed(1)) : 0,
  }));
}

/**
 * Executes an optional sub-query safely: rethrows OAuth RefreshToken / Disconnect
 * so channel token refresh still triggers, while isolating permission / threshold
 * (<100 followers) / unsupported-metric errors to `fallback`.
 */
export async function safeAnalyticsCall<T>(
  context: string,
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (err instanceof RefreshToken || err instanceof Disconnect) {
      throw err;
    }
    console.warn(
      `[Analytics] Optional query skipped (${context}):`,
      err?.message || err
    );
    return fallback;
  }
}

/**
 * Formats a human-readable caption/title snippet for post leaderboards.
 */
export function summarizePostTitle(
  text?: string | null,
  fallback = 'Untitled post',
  maxLen = 80
): string {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  const chars = [...cleaned];
  if (chars.length <= maxLen) return cleaned;
  return chars.slice(0, maxLen).join('') + '…';
}
