'use client';

import React, { FC, useMemo, useState } from 'react';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { ChartSocial } from '@gitroom/frontend/components/analytics/chart-social';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

export interface AnalyticsBreakdownEntry {
  label: string;
  value: number;
  percentage?: number;
}

export interface AnalyticsPostEntry {
  id: string;
  title: string;
  url?: string;
  thumbnail?: string;
  publishedAt: string;
  mediaType?: string;
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  engagementRate?: number;
  avgWatchTimeSeconds?: number;
}

export interface RichAnalyticsItem {
  label: string;
  data: Array<{ total: number | string; date: string }>;
  percentageChange?: number;
  average?: boolean;
  unit?: 'number' | 'percent' | 'seconds' | 'minutes';
  aggregation?: 'sum' | 'average' | 'latest';
  category?:
    | 'overview'
    | 'engagement'
    | 'retention'
    | 'audience'
    | 'traffic'
    | 'posts';
  breakdown?: AnalyticsBreakdownEntry[];
  posts?: AnalyticsPostEntry[];
  note?: string;
  updatedAt?: string;
}

const METRIC_LABEL_KEYS: Record<string, string> = {
  Followers: 'metric_followers',
  Following: 'metric_following',
  'Follower Count': 'metric_follower_count',
  'New Followers': 'metric_new_followers',
  Subscribers: 'metric_subscribers',
  'Subscribers Gained': 'metric_subscribers_gained',
  'Subscribers Lost': 'metric_subscribers_lost',
  Views: 'metric_views',
  'Period Views': 'metric_period_views',
  'Lifetime Views': 'metric_lifetime_views',
  'Engaged Views': 'metric_engaged_views',
  'Media views': 'metric_media_views',
  Plays: 'metric_plays',
  Reach: 'metric_reach',
  Impressions: 'metric_impressions',
  'Page Impressions': 'metric_page_impressions',
  'Page Views': 'metric_page_views',
  'Page Likes': 'metric_page_likes',
  'Page followers': 'metric_page_followers',
  'Page Unfollows': 'metric_page_unfollows',
  'Posts Engagement': 'metric_posts_engagement',
  'Post Reactions': 'metric_post_reactions',
  Likes: 'metric_likes',
  'Total Likes': 'metric_total_likes',
  'Recent Likes': 'metric_recent_likes',
  Comments: 'metric_comments',
  'Recent Comments': 'metric_recent_comments',
  Replies: 'metric_replies',
  'Story Replies': 'metric_story_replies',
  Shares: 'metric_shares',
  'Recent Shares': 'metric_recent_shares',
  Reposts: 'metric_reposts',
  Quotes: 'metric_quotes',
  Saves: 'metric_saves',
  Favorites: 'metric_favorites',
  Bookmarks: 'metric_bookmarks',
  Retweets: 'metric_retweets',
  Reactions: 'metric_reactions',
  Clicks: 'metric_clicks',
  'Outbound Clicks': 'metric_outbound_clicks',
  'Pin Clicks': 'metric_pin_clicks',
  'Pin click rate': 'metric_pin_click_rate',
  'Website Clicks': 'metric_website_clicks',
  'Profile Views': 'metric_profile_views',
  'Profile Visits': 'metric_profile_visits',
  'Profile Link Taps': 'metric_profile_link_taps',
  'Accounts Engaged': 'metric_accounts_engaged',
  'Engaged Audience': 'metric_engaged_audience',
  Engagement: 'metric_engagement',
  'Total Interactions': 'metric_total_interactions',
  'Engagement Rate': 'metric_engagement_rate',
  Videos: 'metric_videos',
  'Published Media': 'metric_published_media',
  'Videos in Period': 'metric_videos_in_period',
  'Average Views per Video': 'metric_avg_views_per_video',
  'Estimated Minutes Watched': 'metric_estimated_minutes_watched',
  'Average View Duration': 'metric_avg_view_duration',
  'Average View Percentage': 'metric_avg_view_percentage',
  'Average Watch Time': 'metric_avg_watch_time',
  'Total Watch Time': 'metric_total_watch_time',
  'Completion Rate': 'metric_completion_rate',
  'Video Duration': 'metric_video_duration',
  'Views by Format': 'metric_views_by_format',
  'Views by Audience Type': 'metric_views_by_audience_type',
  'Follows & Unfollows': 'metric_follows_unfollows',
  'Audience by Country': 'metric_audience_by_country',
  'Audience by City': 'metric_audience_by_city',
  'Audience by Age': 'metric_audience_by_age',
  'Audience by Gender': 'metric_audience_by_gender',
  'Audience by Age & Gender': 'metric_audience_by_age_gender',
  'Followers by Country': 'metric_followers_by_country',
  'Followers by Gender': 'metric_followers_by_gender',
  'Views by Country': 'metric_views_by_country',
  'Active Followers by Hour': 'metric_active_followers_by_hour',
  'Media Views by Source': 'metric_media_views_by_source',
  'Reactions by Type': 'metric_reactions_by_type',
  'Clicks by Type': 'metric_clicks_by_type',
  'Traffic Sources': 'metric_traffic_sources',
  'Recent Posts Performance': 'metric_recent_posts_performance',
  'Top Videos Performance': 'metric_top_videos_performance',
};

const BREAKDOWN_VALUE_KEYS: Record<string, string> = {
  FOLLOWER: 'bd_follower',
  NON_FOLLOWER: 'bd_non_follower',
  REELS: 'bd_reels',
  FEED: 'bd_feed',
  STORY: 'bd_story',
  CAROUSEL_CONTAINER: 'bd_carousel',
  AD: 'bd_ad',
  Organic: 'bd_organic',
  Paid: 'bd_paid',
  F: 'bd_female',
  M: 'bd_male',
  U: 'bd_unspecified',
  Female: 'bd_female',
  Male: 'bd_male',
  like: 'bd_like',
  love: 'bd_love',
  wow: 'bd_wow',
  haha: 'bd_haha',
  sorry: 'bd_sad',
  anger: 'bd_angry',
  LIKE: 'bd_like',
  LOVE: 'bd_love',
  WOW: 'bd_wow',
  HAHA: 'bd_haha',
  SORRY: 'bd_sad',
  ANGER: 'bd_angry',
  'YouTube Search': 'bd_yt_search',
  'Shorts Feed': 'bd_shorts_feed',
  'Browse / Subscriptions': 'bd_browse_subscriptions',
  'Suggested Videos': 'bd_suggested_videos',
  External: 'bd_external',
  'Channel Pages': 'bd_channel_pages',
  'Other YouTube Features': 'bd_other_yt_features',
  'Direct or Unknown': 'bd_direct_unknown',
  Playlists: 'bd_playlists',
  Notifications: 'bd_notifications',
};

export function translateMetricLabel(
  t: ReturnType<typeof useT>,
  label: string
): string {
  const key = METRIC_LABEL_KEYS[label];
  return key ? String(t(key, label)) : label;
}

export function translateBreakdownDimension(
  t: ReturnType<typeof useT>,
  rawLabel: string
): string {
  const key = BREAKDOWN_VALUE_KEYS[rawLabel];
  return key ? String(t(key, rawLabel)) : rawLabel;
}

export function computeNumericMetric(item: RichAnalyticsItem): number {
  const pts = item?.data || [];
  if (!pts.length) return 0;
  const nums = pts.map((curr) => Number(curr.total) || 0);
  const mode = item.aggregation || (item.average ? 'average' : 'sum');
  if (mode === 'latest') {
    return nums[nums.length - 1] ?? 0;
  }
  const sum = nums.reduce((acc, v) => acc + v, 0);
  if (mode === 'average') {
    return sum / nums.length;
  }
  return sum;
}

export function formatDurationSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec < 60) {
    return `${Number(sec.toFixed(1))}s`;
  }
  const mins = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

export function formatMetricValue(item: RichAnalyticsItem): string {
  const value = computeNumericMetric(item);
  const effectiveUnit =
    item.unit || (item.average ? 'percent' : 'number');

  if (effectiveUnit === 'percent') {
    return `${value.toFixed(2)}%`;
  }
  if (effectiveUnit === 'seconds') {
    return formatDurationSeconds(value);
  }
  if (effectiveUnit === 'minutes') {
    return `${Number(value.toFixed(1))}m`;
  }
  return new Intl.NumberFormat().format(Math.round(value));
}

export const TrendIndicator: FC<{
  value?: number;
  isPercentPoint?: boolean;
}> = ({ value, isPercentPoint }) => {
  if (value === undefined || value === null || value === 0 || !Number.isFinite(value)) {
    return null;
  }

  const isPositive = value > 0;
  const displayValue = Math.abs(value).toFixed(1);

  return (
    <div
      className={clsx(
        'flex items-center gap-[4px] text-[13px] font-medium shrink-0',
        isPositive ? 'text-[#32d583]' : 'text-[#f97066]'
      )}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        className={isPositive ? '' : 'rotate-180'}
      >
        <path d="M6 2.5L10 7.5H2L6 2.5Z" fill="currentColor" />
      </svg>
      <span>
        {displayValue}
        {isPercentPoint ? 'pp' : '%'}
      </span>
    </div>
  );
};

export const AnalyticsKpiCard: FC<{
  item: RichAnalyticsItem;
  index: number;
}> = ({ item, index }) => {
  const t = useT();
  const colorVariants = ['purple', 'green', 'blue'] as const;
  const color = colorVariants[index % colorVariants.length];
  const formattedTotal = useMemo(() => formatMetricValue(item), [item]);
  const effectiveAgg = item.aggregation || (item.average ? 'average' : 'sum');
  const isPercentUnit =
    item.unit === 'percent' || (!item.unit && Boolean(item.average));
  const hasSeries = (item.data?.length ?? 0) > 1;

  return (
    <div className="group relative">
      <div className="flex flex-col h-full bg-newTableHeader border border-newTableBorder rounded-[12px] overflow-hidden transition-all duration-200 hover:border-[#612bd3]/50">
        <div className="flex items-center justify-between gap-[8px] px-[16px] pt-[14px] pb-[8px]">
          <div className="flex items-center gap-[10px] min-w-0">
            <div
              className={clsx(
                'w-[8px] h-[8px] rounded-full shrink-0',
                color === 'purple' && 'bg-[#612bd3]',
                color === 'green' && 'bg-[#32d583]',
                color === 'blue' && 'bg-[#1d9bf0]'
              )}
            />
            <span className="text-[15px] font-medium text-newTableText truncate">
              {translateMetricLabel(t, item.label)}
            </span>
          </div>
          <TrendIndicator
            value={item.percentageChange}
            isPercentPoint={isPercentUnit}
          />
        </div>

        {hasSeries ? (
          <>
            <div className="flex-1 px-[12px] py-[6px]">
              <div className="h-[112px] relative">
                <ChartSocial
                  data={item.data}
                  color={color}
                  aggregation={effectiveAgg}
                />
              </div>
            </div>
            <div className="px-[16px] pb-[14px]">
              <div className="text-[32px] leading-[38px] font-semibold tracking-tight">
                {formattedTotal}
              </div>
              {item.note && (
                <div className="text-[11px] text-gray-400 mt-[4px] line-clamp-1">
                  {item.note}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col justify-between px-[16px] py-[18px]">
            <div className="text-[36px] leading-[44px] font-semibold tracking-tight">
              {formattedTotal}
            </div>
            {item.note && (
              <div className="text-[11px] text-gray-400 mt-[8px]">
                {item.note}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const AnalyticsBreakdownCard: FC<{
  item: RichAnalyticsItem;
  index: number;
}> = ({ item, index }) => {
  const t = useT();
  const breakdown = item.breakdown || [];
  const isHourly = item.label === 'Active Followers by Hour';
  const accentColors = ['#612bd3', '#32d583', '#1d9bf0'];
  const accent = accentColors[index % accentColors.length];
  const headerValue = useMemo(() => formatMetricValue(item), [item]);
  const maxVal = useMemo(
    () => breakdown.reduce((m, b) => (b.value > m ? b.value : m), 0),
    [breakdown]
  );

  return (
    <div className="flex flex-col h-full bg-newTableHeader border border-newTableBorder rounded-[12px] p-[16px] gap-[12px] transition-all duration-200 hover:border-[#612bd3]/50">
      <div className="flex items-center justify-between gap-[8px]">
        <div className="flex items-center gap-[8px] min-w-0">
          <span
            className="w-[8px] h-[8px] rounded-full shrink-0"
            style={{ backgroundColor: accent }}
          />
          <span className="text-[15px] font-medium text-newTableText truncate">
            {translateMetricLabel(t, item.label)}
          </span>
        </div>
        {item.unit !== 'percent' && (
          <span className="text-[13px] font-semibold text-gray-400 shrink-0">
            {isHourly
              ? `${t('peak', 'Peak')}: ${headerValue}`
              : headerValue}
          </span>
        )}
      </div>

      {isHourly ? (
        <div className="flex flex-col gap-[6px] pt-[8px] flex-1 justify-end">
          <div className="grid grid-cols-24 items-end gap-[3px] h-[110px]" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
            {breakdown.map((b) => {
              const heightPct = maxVal > 0 ? Math.max(6, Math.round((b.value / maxVal) * 100)) : 6;
              return (
                <div
                  key={b.label}
                  className="group/bar relative flex flex-col items-center justify-end h-full"
                  title={`${b.label}: ${new Intl.NumberFormat().format(b.value)}`}
                >
                  <div
                    className="w-full rounded-t-[3px] transition-all opacity-80 hover:opacity-100"
                    style={{
                      height: `${heightPct}%`,
                      backgroundColor: accent,
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[11px] text-gray-400">
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>23:00</span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-[10px]">
          {breakdown.slice(0, 8).map((entry) => {
            const pct =
              entry.percentage !== undefined
                ? entry.percentage
                : maxVal > 0
                ? Number(((entry.value / maxVal) * 100).toFixed(1))
                : 0;
            const barWidth = Math.min(100, Math.max(3, pct));
            const displayCount =
              item.unit === 'percent'
                ? `${entry.value.toFixed(1)}%`
                : new Intl.NumberFormat().format(Math.round(entry.value));

            return (
              <div key={entry.label} className="flex flex-col gap-[4px]">
                <div className="flex items-center justify-between text-[13px] gap-[8px]">
                  <span className="truncate text-newTableText">
                    {translateBreakdownDimension(t, entry.label)}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums text-gray-300">
                    {displayCount}
                    {item.unit !== 'percent' && entry.percentage !== undefined
                      ? ` (${entry.percentage.toFixed(1)}%)`
                      : ''}
                  </span>
                </div>
                <div className="w-full h-[6px] rounded-full bg-newTableBorder overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${barWidth}%`,
                      backgroundColor: accent,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

type SortKey =
  | 'views'
  | 'reach'
  | 'likes'
  | 'comments'
  | 'shares'
  | 'saves'
  | 'engagementRate'
  | 'publishedAt';

export const AnalyticsPostsLeaderboard: FC<{
  item: RichAnalyticsItem;
}> = ({ item }) => {
  const t = useT();
  const posts = item.posts || [];
  const [sortByKey, setSortByKey] = useState<SortKey>('views');
  const [sortDesc, setSortDesc] = useState(true);

  const hasReach = useMemo(() => posts.some((p) => p.reach !== undefined), [posts]);
  const hasSaves = useMemo(() => posts.some((p) => p.saves !== undefined), [posts]);
  const hasShares = useMemo(() => posts.some((p) => p.shares !== undefined), [posts]);
  const hasWatchTime = useMemo(
    () => posts.some((p) => p.avgWatchTimeSeconds !== undefined),
    [posts]
  );

  const sortedPosts = useMemo(() => {
    const copy = [...posts];
    copy.sort((a, b) => {
      let va = 0;
      let vb = 0;
      if (sortByKey === 'publishedAt') {
        va = dayjs(a.publishedAt).valueOf() || 0;
        vb = dayjs(b.publishedAt).valueOf() || 0;
      } else {
        va = Number(a[sortByKey] ?? -1);
        vb = Number(b[sortByKey] ?? -1);
      }
      return sortDesc ? vb - va : va - vb;
    });
    return copy;
  }, [posts, sortByKey, sortDesc]);

  const toggleSort = (key: SortKey) => {
    if (sortByKey === key) {
      setSortDesc((prev) => !prev);
    } else {
      setSortByKey(key);
      setSortDesc(true);
    }
  };

  const renderSortHeader = (key: SortKey, label: string) => (
    <th
      onClick={() => toggleSort(key)}
      className="px-[12px] py-[10px] text-end font-medium cursor-pointer select-none hover:text-white whitespace-nowrap"
    >
      <span className="inline-flex items-center gap-[4px]">
        {label}
        {sortByKey === key && (
          <span className="text-[10px]">{sortDesc ? '▼' : '▲'}</span>
        )}
      </span>
    </th>
  );

  const fmtNum = (n?: number) =>
    n === undefined || n === null
      ? '—'
      : new Intl.NumberFormat().format(Math.round(n));

  return (
    <div className="bg-newTableHeader border border-newTableBorder rounded-[12px] overflow-hidden">
      <div className="flex items-center justify-between px-[16px] py-[14px] border-b border-newTableBorder">
        <div className="flex flex-col gap-[2px]">
          <h3 className="text-[16px] font-semibold text-newTableText">
            {translateMetricLabel(t, item.label)}
          </h3>
          {item.note && (
            <span className="text-[12px] text-gray-400">{item.note}</span>
          )}
        </div>
        <span className="text-[12px] text-gray-400">
          {posts.length} {t('posts_count_suffix', 'posts')}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="border-b border-newTableBorder text-gray-400">
              <th className="px-[16px] py-[10px] text-start font-medium">
                {t('leaderboard_post', 'Post')}
              </th>
              {renderSortHeader('publishedAt', t('leaderboard_date', 'Date'))}
              {renderSortHeader('views', t('metric_views', 'Views'))}
              {hasReach && renderSortHeader('reach', t('metric_reach', 'Reach'))}
              {renderSortHeader('likes', t('metric_likes', 'Likes'))}
              {renderSortHeader('comments', t('metric_comments', 'Comments'))}
              {hasShares && renderSortHeader('shares', t('metric_shares', 'Shares'))}
              {hasSaves && renderSortHeader('saves', t('metric_saves', 'Saves'))}
              {hasWatchTime && (
                <th className="px-[12px] py-[10px] text-end font-medium whitespace-nowrap">
                  {t('metric_avg_watch_time', 'Avg Watch')}
                </th>
              )}
              {renderSortHeader(
                'engagementRate',
                t('metric_engagement_rate', 'Eng. Rate')
              )}
            </tr>
          </thead>
          <tbody>
            {sortedPosts.map((post) => (
              <tr
                key={post.id}
                className="border-b border-newTableBorder/60 last:border-b-0 hover:bg-boxHover/40 transition-colors"
              >
                <td className="px-[16px] py-[10px] max-w-[320px]">
                  <div className="flex items-center gap-[10px]">
                    {post.thumbnail ? (
                      <img
                        src={post.thumbnail}
                        alt=""
                        className="w-[38px] h-[38px] rounded-[6px] object-cover shrink-0 bg-newTableBorder"
                      />
                    ) : (
                      <div className="w-[38px] h-[38px] rounded-[6px] bg-newTableBorder flex items-center justify-center text-[10px] text-gray-400 shrink-0">
                        {post.mediaType?.slice(0, 4) || 'POST'}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      {post.url ? (
                        <a
                          href={post.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-newTableText hover:text-[#a482ff] line-clamp-2 break-words"
                        >
                          {post.title}
                        </a>
                      ) : (
                        <span className="font-medium text-newTableText line-clamp-2 break-words">
                          {post.title}
                        </span>
                      )}
                      {post.mediaType && (
                        <span className="inline-block mt-[2px] text-[10px] px-[6px] py-[1px] rounded bg-newTableBorder text-gray-300">
                          {post.mediaType}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-[12px] py-[10px] text-end whitespace-nowrap text-gray-400 tabular-nums">
                  {dayjs(post.publishedAt).isValid()
                    ? dayjs(post.publishedAt).format('YYYY-MM-DD')
                    : post.publishedAt}
                </td>
                <td className="px-[12px] py-[10px] text-end tabular-nums font-medium">
                  {fmtNum(post.views)}
                </td>
                {hasReach && (
                  <td className="px-[12px] py-[10px] text-end tabular-nums">
                    {fmtNum(post.reach)}
                  </td>
                )}
                <td className="px-[12px] py-[10px] text-end tabular-nums">
                  {fmtNum(post.likes)}
                </td>
                <td className="px-[12px] py-[10px] text-end tabular-nums">
                  {fmtNum(post.comments)}
                </td>
                {hasShares && (
                  <td className="px-[12px] py-[10px] text-end tabular-nums">
                    {fmtNum(post.shares)}
                  </td>
                )}
                {hasSaves && (
                  <td className="px-[12px] py-[10px] text-end tabular-nums">
                    {fmtNum(post.saves)}
                  </td>
                )}
                {hasWatchTime && (
                  <td className="px-[12px] py-[10px] text-end tabular-nums">
                    {post.avgWatchTimeSeconds !== undefined
                      ? formatDurationSeconds(post.avgWatchTimeSeconds)
                      : '—'}
                  </td>
                )}
                <td className="px-[12px] py-[10px] text-end tabular-nums font-medium text-[#32d583]">
                  {post.engagementRate !== undefined
                    ? `${post.engagementRate.toFixed(2)}%`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export function splitAnalyticsSections(items: RichAnalyticsItem[] = []) {
  const kpiItems: RichAnalyticsItem[] = [];
  const breakdownItems: RichAnalyticsItem[] = [];
  const postLeaderboardItems: RichAnalyticsItem[] = [];

  for (const item of items) {
    if (item.posts && item.posts.length > 0) {
      postLeaderboardItems.push(item);
      continue;
    }
    if (item.breakdown && item.breakdown.length > 0) {
      breakdownItems.push(item);
      // If a postAnalytics metric (like Facebook feed `Reactions`) is both an engagement count
      // AND carries reaction breakdown, also keep a KPI card if no separate Reactions KPI exists
      if (
        item.category === 'engagement' &&
        !item.label.includes('by ') &&
        !items.some((other) => other !== item && other.label === item.label)
      ) {
        kpiItems.push(item);
      }
      continue;
    }
    kpiItems.push(item);
  }

  return { kpiItems, breakdownItems, postLeaderboardItems };
}
