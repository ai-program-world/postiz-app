'use client';

import { FC, useEffect, useMemo, useRef } from 'react';
import DrawChart from 'chart.js/auto';
import { TotalList } from '@gitroom/frontend/components/analytics/stars.and.forks.interface';
import { chunk } from 'lodash';
import useCookie from 'react-use-cookie';

function mergeDataPoints(
  data: Array<{ total: number | string; date: string }>,
  numPoints: number,
  aggregation: 'sum' | 'average' | 'latest' = 'sum'
): TotalList[] {
  const res = chunk(data, Math.ceil(data.length / numPoints));
  return res.map((row) => {
    const nums = row.map((curr) => Number(curr.total) || 0);
    let bucketTotal = 0;
    if (aggregation === 'latest') {
      bucketTotal = nums[nums.length - 1] ?? 0;
    } else {
      const sum = nums.reduce((acc, v) => acc + v, 0);
      bucketTotal =
        aggregation === 'average' && nums.length > 0 ? sum / nums.length : sum;
    }
    return {
      date:
        row.length === 1
          ? row[0].date
          : `${row[0].date} - ${row?.at(-1)?.date}`,
      total: Number.isInteger(bucketTotal)
        ? bucketTotal
        : Number(bucketTotal.toFixed(2)),
    };
  });
}

export const ChartSocial: FC<{
  data: Array<{ total: number | string; date: string }>;
  color?: 'purple' | 'green' | 'blue';
  aggregation?: 'sum' | 'average' | 'latest';
}> = (props) => {
  const { data, color = 'purple', aggregation = 'sum' } = props;
  const [mode] = useCookie('mode', 'dark');

  const list = useMemo(() => {
    const normalized: TotalList[] = (data || []).map((pt) => ({
      date: pt.date,
      total: Number(pt.total) || 0,
    }));
    const merged =
      normalized.length < 7
        ? normalized
        : mergeDataPoints(normalized, 7, aggregation);
    if (merged.length === 1) {
      return [
        // duplicating single datapoints metrics for chart to display a line on analytics
        merged[0],
        merged[0],
      ];
    }
    return merged;
  }, [data, aggregation]);

  const ref = useRef<any>(null);
  const chart = useRef<null | DrawChart>(null);

  const colorSchemes = {
    purple: {
      start: 'rgba(97, 43, 211, 0.8)',
      end: 'rgba(97, 43, 211, 0.1)',
      border: 'rgb(97, 43, 211)',
    },
    green: {
      start: 'rgba(50, 213, 131, 0.8)',
      end: 'rgba(50, 213, 131, 0.1)',
      border: 'rgb(50, 213, 131)',
    },
    blue: {
      start: 'rgba(29, 155, 240, 0.8)',
      end: 'rgba(29, 155, 240, 0.1)',
      border: 'rgb(29, 155, 240)',
    },
  };

  const colors = colorSchemes[color];

  useEffect(() => {
    const ctx = ref.current.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, ref.current.height);
    gradient.addColorStop(0, colors.start);
    gradient.addColorStop(1, colors.end);

    chart.current = new DrawChart(ref.current!, {
      type: 'line',
      options: {
        maintainAspectRatio: false,
        responsive: true,
        animation: {
          duration: 750,
          easing: 'easeOutQuart',
        },
        interaction: {
          mode: 'index',
          intersect: false,
        },
        layout: {
          padding: {
            left: 0,
            right: 0,
            top: 4,
            bottom: 0,
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            display: false,
          },
          x: {
            display: false,
            ticks: {
              stepSize: 10,
              maxTicksLimit: 7,
            },
          },
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            enabled: true,
            backgroundColor: mode === 'dark' ? '#1e1d1d' : '#fff',
            titleColor: mode === 'dark' ? '#fff' : '#000',
            bodyColor: mode === 'dark' ? '#9c9c9c' : '#777',
            borderColor: mode === 'dark' ? '#2b2b2b' : '#e7e9eb',
            borderWidth: 1,
            padding: 10,
            cornerRadius: 8,
            displayColors: false,
            titleFont: {
              size: 12,
              weight: 'normal',
            },
            bodyFont: {
              size: 14,
              weight: 'bold',
            },
          },
        },
      },
      data: {
        labels: list.map((row) => row.date),
        datasets: [
          {
            borderColor: colors.border,
            borderWidth: 2,
            label: 'Total',
            backgroundColor: gradient,
            fill: true,
            data: list.map((row) => row.total),
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: colors.border,
            pointHoverBorderColor: mode === 'dark' ? '#1e1d1d' : '#fff',
            pointHoverBorderWidth: 2,
          },
        ],
      },
    });
    return () => {
      chart?.current?.destroy();
    };
  }, [list, mode, colors.border, colors.start, colors.end]);

  return <canvas className="w-full h-full" ref={ref} />;
};
