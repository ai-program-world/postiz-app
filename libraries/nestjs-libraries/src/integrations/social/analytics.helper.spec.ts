import dayjs from 'dayjs';
import {
  Disconnect,
  RefreshToken,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  aggregatePoints,
  buildBreakdown,
  computePercentageChange,
  computeSeriesTrend,
  mergeDailyPoints,
  previousDateWindows,
  safeAnalyticsCall,
  splitDateWindows,
  summarizePostTitle,
} from './analytics.helper';

describe('analytics.helper', () => {
  it('splits 90-day lookbacks into <=28-day non-overlapping windows for Meta/Threads', () => {
    const anchor = dayjs('2026-11-10T23:59:59Z');
    const windows = splitDateWindows(90, 28, anchor);
    expect(windows.length).toBe(4);
    for (const w of windows) {
      expect(w.until - w.since).toBeLessThanOrEqual(28 * 86400);
      expect(w.until).toBeGreaterThanOrEqual(w.since);
    }
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].since).toBe(windows[i - 1].until + 1);
    }
  });

  it('builds non-overlapping previousDateWindows immediately preceding the current range', () => {
    const anchor = dayjs('2026-11-10T23:59:59Z');
    const curr = splitDateWindows(30, 28, anchor);
    const prev = previousDateWindows(30, 28, anchor);
    expect(prev[prev.length - 1].until).toBeLessThan(curr[0].since);
  });

  it('deduplicates, sorts, and coerces string totals in mergeDailyPoints & aggregatePoints', () => {
    const merged = mergeDailyPoints([
      { date: '2026-11-03', total: '20' },
      { date: '2026-11-01', total: '10' },
      { date: '2026-11-02', total: 15.456 },
      { date: '2026-11-01', total: '12' }, // overwrites duplicate
    ]);

    expect(merged).toEqual([
      { date: '2026-11-01', total: '12' },
      { date: '2026-11-02', total: '15.46' },
      { date: '2026-11-03', total: '20' },
    ]);

    expect(aggregatePoints(merged, 'sum')).toBeCloseTo(47.46, 2);
    expect(aggregatePoints(merged, 'average')).toBeCloseTo(47.46 / 3, 2);
    expect(aggregatePoints(merged, 'latest')).toBe(20);
  });

  it('computes real percentageChange and percentage-point deltas without hardcoded dummy values', () => {
    expect(computePercentageChange(150, 100)).toBe(50);
    expect(computePercentageChange(80, 100)).toBe(-20);
    expect(computePercentageChange(100, 0)).toBe(0);
    expect(computePercentageChange(100, undefined)).toBe(0);
    expect(computePercentageChange(6.4, 4.1, true)).toBe(2.3);
  });

  it('computes series trends for latest and multi-point series', () => {
    const snap = [
      { date: '2026-11-01', total: '1000' },
      { date: '2026-11-07', total: '1050' },
    ];
    expect(computeSeriesTrend(snap, 'latest')).toBe(5);

    const daily = [
      { date: '2026-11-01', total: '10' },
      { date: '2026-11-02', total: '10' },
      { date: '2026-11-03', total: '20' },
      { date: '2026-11-04', total: '20' },
    ];
    expect(computeSeriesTrend(daily, 'sum')).toBe(100);
  });

  it('builds sorted percentage breakdowns and preserves order when requested', () => {
    const bd = buildBreakdown({ Reels: 300, Feed: 100, Zero: 0 });
    expect(bd).toEqual([
      { label: 'Reels', value: 300, percentage: 75 },
      { label: 'Feed', value: 100, percentage: 25 },
    ]);

    const hourly = buildBreakdown(
      [
        { label: '00:00', value: 10 },
        { label: '01:00', value: 30 },
      ],
      24,
      true
    );
    expect(hourly[0].label).toBe('00:00');
    expect(hourly[1].label).toBe('01:00');
  });

  it('safeAnalyticsCall isolates optional sub-query errors while rethrowing RefreshToken & Disconnect', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = await safeAnalyticsCall(
      'demographics',
      async () => {
        throw new Error('Requires at least 100 followers');
      },
      []
    );
    expect(fallback).toEqual([]);

    await expect(
      safeAnalyticsCall(
        'expired-oauth',
        async () => {
          throw new RefreshToken('instagram', '{}', '{}');
        },
        []
      )
    ).rejects.toBeInstanceOf(RefreshToken);

    await expect(
      safeAnalyticsCall(
        'revoked-oauth',
        async () => {
          throw new Disconnect('facebook', '{}', '{}');
        },
        []
      )
    ).rejects.toBeInstanceOf(Disconnect);
    warnSpy.mockRestore();
  });

  it('summarizes captions cleanly by Unicode code points', () => {
    expect(summarizePostTitle('  Hello\n\nWorld  ')).toBe('Hello World');
    expect(summarizePostTitle('', 'Fallback')).toBe('Fallback');
    expect(summarizePostTitle('一二三四五六', 'Fallback', 4)).toBe('一二三四…');
  });
});
