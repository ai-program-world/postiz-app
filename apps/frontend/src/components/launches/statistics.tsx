import React, { FC, Fragment, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import clsx from 'clsx';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { Select } from '@gitroom/react/form/select';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { MissingReleaseModal } from '@gitroom/frontend/components/launches/missing-release.modal';
import {
  AnalyticsBreakdownCard,
  AnalyticsKpiCard,
  RichAnalyticsItem,
  splitAnalyticsSections,
} from '@gitroom/frontend/components/platform-analytics/analytics.widgets';

export const StatisticsModal: FC<{
  postId: string;
}> = (props) => {
  const { postId } = props;
  const t = useT();
  const fetch = useFetch();
  const [dateRange, setDateRange] = useState(7);
  const [refreshing, setRefreshing] = useState(false);

  const loadStatistics = useCallback(async () => {
    return (await fetch(`/posts/${postId}/statistics`)).json();
  }, [postId, fetch]);

  const loadPostAnalytics = useCallback(async () => {
    return (await fetch(`/analytics/post/${postId}?date=${dateRange}`)).json();
  }, [postId, dateRange, fetch]);

  const { data: statisticsData, isLoading: isLoadingStatistics } = useSWR(
    `/posts/${postId}/statistics`,
    loadStatistics
  );

  const {
    data: analyticsData,
    isLoading: isLoadingAnalytics,
    mutate: mutateAnalytics,
  } = useSWR(`/analytics/post/${postId}?date=${dateRange}`, loadPostAnalytics, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
  });

  const handleForceRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const fresh = await (
        await fetch(`/analytics/post/${postId}?date=${dateRange}&refresh=true`)
      ).json();
      await mutateAnalytics(fresh, { revalidate: false });
    } finally {
      setRefreshing(false);
    }
  }, [fetch, postId, dateRange, mutateAnalytics, refreshing]);

  const isMissing =
    analyticsData && !Array.isArray(analyticsData) && analyticsData.missing;

  const dateOptions = useMemo(() => {
    return [
      { key: 7, value: t('7_days', '7 Days') },
      { key: 30, value: t('30_days', '30 Days') },
      { key: 90, value: t('90_days', '90 Days') },
    ];
  }, [t]);

  const { kpiItems, breakdownItems } = useMemo(() => {
    if (!analyticsData || !Array.isArray(analyticsData)) {
      return { kpiItems: [], breakdownItems: [] };
    }
    return splitAnalyticsSections(analyticsData as RichAnalyticsItem[]);
  }, [analyticsData]);

  const updatedAtDisplay = useMemo(() => {
    const raw = Array.isArray(analyticsData)
      ? analyticsData[0]?.updatedAt
      : undefined;
    if (!raw) return null;
    const parsed = dayjs(raw);
    return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : null;
  }, [analyticsData]);

  const isLoading = isLoadingStatistics || isLoadingAnalytics;

  return (
    <div className="relative min-h-[200px]">
      {isLoading ? (
        <div className="flex items-center justify-center py-[40px]">
          <LoadingComponent />
        </div>
      ) : isMissing ? (
        <MissingReleaseModal
          postId={postId}
          onSuccess={() => mutateAnalytics()}
        />
      ) : (
        <div className="flex flex-col gap-[24px]">
          {/* Post Analytics Section */}
          {analyticsData &&
            Array.isArray(analyticsData) &&
            analyticsData.length > 0 && (
              <div className="flex flex-col gap-[16px]">
                <div className="flex flex-wrap items-center justify-between gap-[12px]">
                  <div className="flex flex-col gap-[2px]">
                    <h3 className="text-[18px] font-[500]">
                      {t('post_analytics', 'Post Analytics')}
                    </h3>
                    {updatedAtDisplay && (
                      <span className="text-[12px] text-gray-400">
                        {t('analytics_last_updated', 'Last updated')}:{' '}
                        {updatedAtDisplay}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-[10px]">
                    <button
                      type="button"
                      onClick={handleForceRefresh}
                      disabled={refreshing}
                      className={clsx(
                        'inline-flex items-center gap-[6px] px-[12px] py-[8px] text-[13px] font-medium rounded-[8px] border border-newTableBorder bg-newTableHeader hover:border-[#612bd3]/60 transition-colors',
                        refreshing && 'opacity-60 cursor-not-allowed'
                      )}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={clsx(refreshing && 'animate-spin')}
                      >
                        <path d="M23 4v6h-6M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                      </svg>
                      {refreshing
                        ? t('refreshing_analytics', 'Refreshing...')
                        : t('force_refresh_analytics', 'Refresh Data')}
                    </button>
                    <div className="w-[130px]">
                      <Select
                        label=""
                        name="date"
                        disableForm={true}
                        hideErrors={true}
                        value={dateRange}
                        onChange={(e) => setDateRange(+e.target.value)}
                      >
                        {dateOptions.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.value}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                </div>

                {kpiItems.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[16px]">
                    {kpiItems.map((p, index) => (
                      <AnalyticsKpiCard
                        key={`post-kpi-${p.label}-${index}`}
                        item={p}
                        index={index}
                      />
                    ))}
                  </div>
                )}

                {breakdownItems.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-[16px]">
                    {breakdownItems.map((p, index) => (
                      <AnalyticsBreakdownCard
                        key={`post-bd-${p.label}-${index}`}
                        item={p}
                        index={index}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

          {/* Short Links Statistics Section */}
          <div className="flex flex-col gap-[14px]">
            <h3 className="text-[18px] font-[500]">
              {t('short_links_statistics', 'Short Links Statistics')}
            </h3>
            {statisticsData?.clicks?.length === 0 ? (
              <div className="text-gray-400">
                {t('no_short_link_results', 'No short link results')}
              </div>
            ) : (
              <div className="grid grid-cols-3">
                <div className="bg-forth p-[4px] rounded-tl-lg">
                  {t('short_link', 'Short Link')}
                </div>
                <div className="bg-forth p-[4px]">
                  {t('original_link', 'Original Link')}
                </div>
                <div className="bg-forth p-[4px] rounded-tr-lg">
                  {t('clicks', 'Clicks')}
                </div>
                {statisticsData?.clicks?.map((p: any) => (
                  <Fragment key={p.short}>
                    <div className="p-[4px] py-[10px] bg-customColor6">
                      {p.short}
                    </div>
                    <div className="p-[4px] py-[10px] bg-customColor6">
                      {p.original}
                    </div>
                    <div className="p-[4px] py-[10px] bg-customColor6">
                      {p.clicks}
                    </div>
                  </Fragment>
                ))}
              </div>
            )}
          </div>

          {/* No analytics available message */}
          {(!analyticsData ||
            !Array.isArray(analyticsData) ||
            analyticsData.length === 0) &&
            (!statisticsData?.clicks || statisticsData.clicks.length === 0) && (
              <div className="text-center text-gray-400 py-[20px]">
                {t(
                  'no_statistics_available',
                  'No statistics available for this post'
                )}
              </div>
            )}
        </div>
      )}
    </div>
  );
};
