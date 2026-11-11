import { FC, useCallback, useMemo, useState } from 'react';
import { Integration } from '@prisma/client';
import useSWR from 'swr';
import dayjs from 'dayjs';
import clsx from 'clsx';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  AnalyticsBreakdownCard,
  AnalyticsKpiCard,
  AnalyticsPostsLeaderboard,
  RichAnalyticsItem,
  splitAnalyticsSections,
} from '@gitroom/frontend/components/platform-analytics/analytics.widgets';

const EmptyState: FC<{ onRefresh: () => void }> = ({ onRefresh }) => {
  const t = useT();

  return (
    <div className="col-span-full flex flex-col items-center justify-center py-[48px] px-[24px] bg-newTableHeader border border-newTableBorder rounded-[12px]">
      <div className="w-[48px] h-[48px] mb-[16px] rounded-full bg-[#612bd3]/10 flex items-center justify-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-[#612bd3]"
        >
          <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          <path d="M12 8v4l2 2" />
        </svg>
      </div>
      <p className="text-[15px] text-newTableText text-center mb-[12px]">
        {t(
          'this_channel_needs_to_be_refreshed',
          'This channel needs to be refreshed to display analytics'
        )}
      </p>
      <button
        onClick={onRefresh}
        className="inline-flex items-center gap-[6px] px-[16px] py-[8px] text-[14px] font-medium text-white bg-[#612bd3] hover:bg-[#5023b8] rounded-[8px] transition-colors"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
        {t('refresh_channel', 'Refresh Channel')}
      </button>
    </div>
  );
};

export const RenderAnalytics: FC<{
  integration: Integration;
  date: number;
}> = (props) => {
  const { integration, date } = props;
  const [loading, setLoading] = useState(true);
  const [refreshingData, setRefreshingData] = useState(false);
  const fetch = useFetch();
  const t = useT();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      return await (
        await fetch(`/analytics/${integration.id}?date=${date}`)
      ).json();
    } finally {
      setLoading(false);
    }
  }, [integration, date, fetch]);

  const { data, mutate } = useSWR<RichAnalyticsItem[]>(
    `/analytics-${integration?.id}-${date}`,
    load,
    {
      refreshInterval: 0,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      refreshWhenOffline: false,
      revalidateOnMount: true,
    }
  );

  const handleForceRefresh = useCallback(async () => {
    if (refreshingData) return;
    setRefreshingData(true);
    try {
      const fresh = await (
        await fetch(`/analytics/${integration.id}?date=${date}&refresh=true`)
      ).json();
      await mutate(fresh, { revalidate: false });
    } finally {
      setRefreshingData(false);
    }
  }, [fetch, integration.id, date, mutate, refreshingData]);

  const refreshChannel = useCallback(
    (
        integrationData: Integration & {
          identifier: string;
        }
      ) =>
      async () => {
        const { url } = await (
          await fetch(
            `/integrations/social/${integrationData.identifier}?refresh=${integrationData.internalId}`,
            {
              method: 'GET',
            }
          )
        ).json();
        window.location.href = url;
      },
    [fetch]
  );

  const { kpiItems, breakdownItems, postLeaderboardItems } = useMemo(
    () => splitAnalyticsSections(Array.isArray(data) ? data : []),
    [data]
  );

  const updatedAtDisplay = useMemo(() => {
    const raw = Array.isArray(data) ? data[0]?.updatedAt : undefined;
    if (!raw) return null;
    const parsed = dayjs(raw);
    return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : null;
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-[48px]">
        <LoadingComponent />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-[16px]">
        <EmptyState onRefresh={refreshChannel(integration as any)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[24px]">
      {/* Toolbar: Last Updated + Force Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-[10px]">
        <div className="text-[13px] text-gray-400">
          {updatedAtDisplay && (
            <span>
              {t('analytics_last_updated', 'Last updated')}: {updatedAtDisplay}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleForceRefresh}
          disabled={refreshingData}
          className={clsx(
            'inline-flex items-center gap-[6px] px-[12px] py-[6px] text-[13px] font-medium rounded-[8px] border border-newTableBorder bg-newTableHeader hover:border-[#612bd3]/60 transition-colors',
            refreshingData && 'opacity-60 cursor-not-allowed'
          )}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={clsx(refreshingData && 'animate-spin')}
          >
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          {refreshingData
            ? t('refreshing_analytics', 'Refreshing...')
            : t('force_refresh_analytics', 'Refresh Data')}
        </button>
      </div>

      {/* Section 1: KPI & Trend Cards */}
      {kpiItems.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[16px]">
          {kpiItems.map((item, index) => (
            <AnalyticsKpiCard
              key={`kpi-${item.label}-${index}`}
              item={item}
              index={index}
            />
          ))}
        </div>
      )}

      {/* Section 2: Audience, Traffic & Format Breakdowns */}
      {breakdownItems.length > 0 && (
        <div className="flex flex-col gap-[12px]">
          <h3 className="text-[16px] font-semibold text-newTableText">
            {t(
              'section_audience_traffic',
              'Audience, Traffic & Content Breakdown'
            )}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[16px]">
            {breakdownItems.map((item, index) => (
              <AnalyticsBreakdownCard
                key={`bd-${item.label}-${index}`}
                item={item}
                index={index}
              />
            ))}
          </div>
        </div>
      )}

      {/* Section 3: Recent / Top Posts Leaderboard */}
      {postLeaderboardItems.map((item, index) => (
        <AnalyticsPostsLeaderboard
          key={`posts-${item.label}-${index}`}
          item={item}
        />
      ))}
    </div>
  );
};
