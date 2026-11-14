import { Injectable } from '@nestjs/common';
import { Organization } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { AnalyticsSnapshotRepository } from '@gitroom/nestjs-libraries/database/prisma/analytics-snapshots/analytics.snapshot.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  AnalyticsData,
  AnalyticsPostItem,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  buildBreakdown,
  computeSeriesTrend,
} from '@gitroom/nestjs-libraries/integrations/social/analytics.helper';

dayjs.extend(utc);

export type AnalyticsSyncKind = 'snapshot' | 'story';

// Stories cost API calls every hour, so they are only stored for
// organizations that opened analytics in the last 30 days
const VIEWED_TTL = 30 * 24 * 3600;
const viewedKey = (orgId: string) => `analytics:viewed:${orgId}`;

@Injectable()
export class AnalyticsSnapshotService {
  constructor(
    private _analyticsSnapshotRepository: AnalyticsSnapshotRepository,
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager
  ) {}

  private providerMethod(kind: AnalyticsSyncKind) {
    return kind === 'snapshot' ? 'analyticsSnapshot' : 'storyInsights';
  }

  // Walks every channel in pages so the list never has to fit in one
  // Temporal payload; channels run 10 at a time. Snapshots skip channels that
  // already have today's row, so hourly runs fill in the ones that failed.
  async syncAll(kind: AnalyticsSyncKind) {
    const method = this.providerMethod(kind);
    const identifiers = this._integrationManager
      .getAllowedSocialsIntegrations()
      .filter(
        (identifier) =>
          typeof (
            this._integrationManager.getSocialIntegration(identifier) as any
          )?.[method] === 'function'
      );
    const missingOn =
      kind === 'snapshot' ? dayjs.utc().startOf('day').toDate() : undefined;

    const viewed = new Map<string, boolean>();
    const isViewed = async (orgId: string) => {
      if (!viewed.has(orgId)) {
        try {
          viewed.set(orgId, !!(await ioRedis.get(viewedKey(orgId))));
        } catch (err) {
          viewed.set(orgId, false);
        }
      }
      return viewed.get(orgId)!;
    };

    let cursor: string | undefined;
    let synced = 0;
    while (true) {
      const page = await this._analyticsSnapshotRepository.getSyncIntegrations(
        identifiers,
        100,
        cursor,
        missingOn
      );
      if (!page.length) {
        break;
      }
      cursor = page[page.length - 1].id;
      const targets: typeof page = [];
      for (const p of page) {
        if (kind !== 'story' || (await isViewed(p.organizationId))) {
          targets.push(p);
        }
      }
      for (let i = 0; i < targets.length; i += 10) {
        const results = await Promise.all(
          targets
            .slice(i, i + 10)
            .map((p) => this.syncIntegration(p.organizationId, p.id, kind))
        );
        synced += results.filter(Boolean).length;
      }
    }
    return synced;
  }

  // Runs in the background for every channel: never throws, a failure only
  // skips this channel until the next run
  async syncIntegration(
    orgId: string,
    integrationId: string,
    kind: AnalyticsSyncKind
  ) {
    try {
      const integration = await this._integrationService.getIntegrationById(
        orgId,
        integrationId
      );
      if (
        !integration ||
        integration.deletedAt ||
        integration.disabled ||
        integration.inBetweenSteps ||
        integration.refreshNeeded ||
        // Token refresh stays with the posting and refresh flows
        (integration.tokenExpiration &&
          dayjs(integration.tokenExpiration).isBefore(dayjs()))
      ) {
        return false;
      }

      const provider: SocialProvider =
        this._integrationManager.getSocialIntegration(
          integration.providerIdentifier
        );

      if (kind === 'snapshot' && provider?.analyticsSnapshot) {
        const data = await provider.analyticsSnapshot(
          integration.internalId,
          integration.token
        );
        if (!data) {
          return false;
        }
        await this._analyticsSnapshotRepository.upsertSnapshot(
          orgId,
          integrationId,
          dayjs.utc().startOf('day').toDate(),
          data
        );
        return true;
      }

      if (kind === 'story' && provider?.storyInsights) {
        const stories = await provider.storyInsights(
          integration.internalId,
          integration.token
        );
        for (const story of stories) {
          await this._analyticsSnapshotRepository.upsertStoryInsight(
            orgId,
            integrationId,
            story
          );
        }
        return true;
      }
    } catch (err: any) {
      console.warn(
        `[AnalyticsSnapshot] ${kind} sync skipped for ${integrationId}:`,
        err?.message || err
      );
    }
    return false;
  }

  async checkAnalyticsWithHistory(
    org: Organization,
    integration: string,
    date: string,
    skipCache = false
  ): Promise<AnalyticsData[]> {
    try {
      await ioRedis.set(viewedKey(org.id), '1', 'EX', VIEWED_TTL);
    } catch (err) {
      /** only affects which organizations get story sync **/
    }

    const analytics = await this._integrationService.checkAnalytics(
      org,
      integration,
      date,
      false,
      skipCache
    );
    if (!analytics.length) {
      return analytics;
    }

    const days = Number(date) > 0 ? Number(date) : 7;
    const since = dayjs.utc().subtract(days, 'day').startOf('day').toDate();
    const [snapshots, stories] = await Promise.all([
      this._analyticsSnapshotRepository.getSnapshots(org.id, integration, since),
      this._analyticsSnapshotRepository.getStoryInsights(
        org.id,
        integration,
        since
      ),
    ]);

    return [
      ...analytics,
      ...this.followerHistoryCards(snapshots),
      ...this.storyCards(stories),
    ];
  }

  private followerHistoryCards(
    snapshots: Array<{ date: Date; followers: number | null }>
  ): AnalyticsData[] {
    const points = snapshots
      .filter((s) => s.followers !== null)
      .map((s) => ({
        date: dayjs.utc(s.date).format('YYYY-MM-DD'),
        total: String(s.followers),
      }));
    if (points.length < 2) {
      return [];
    }
    return [
      {
        label: 'Follower History',
        percentageChange: computeSeriesTrend(points, 'latest'),
        aggregation: 'latest',
        unit: 'number',
        category: 'audience',
        data: points,
      },
    ];
  }

  private storyCards(
    stories: Array<{
      internalId: string;
      permalink: string | null;
      thumbnail: string | null;
      mediaType: string | null;
      publishedAt: Date;
      metrics: any;
    }>
  ): AnalyticsData[] {
    if (!stories.length) {
      return [];
    }
    const today = dayjs.utc().format('YYYY-MM-DD');
    const navigation: Record<string, number> = {};
    const posts: AnalyticsPostItem[] = stories.map((story) => {
      const m: Record<string, number> = story.metrics || {};
      for (const [key, value] of Object.entries(m)) {
        if (key.startsWith('navigation_')) {
          const action = key.replace('navigation_', '').toUpperCase();
          navigation[action] = (navigation[action] || 0) + (Number(value) || 0);
        }
      }
      const reach = Number(m.reach) || 0;
      return {
        id: story.internalId,
        title: 'Story',
        url: story.permalink || undefined,
        thumbnail: story.thumbnail || undefined,
        publishedAt: dayjs.utc(story.publishedAt).toISOString(),
        mediaType: 'STORY',
        views: m.views,
        reach: m.reach,
        comments: m.replies,
        shares: m.shares,
        engagementRate:
          reach > 0
            ? Number((((Number(m.total_interactions) || 0) / reach) * 100).toFixed(2))
            : undefined,
      };
    });

    const result: AnalyticsData[] = [
      {
        label: 'Stories Performance',
        percentageChange: 0,
        category: 'posts',
        posts,
        data: [
          {
            total: String(posts.reduce((s, p) => s + (p.views || 0), 0)),
            date: today,
          },
        ],
      },
    ];

    const navigationBd = buildBreakdown(navigation, 6);
    if (navigationBd.length > 0) {
      result.push({
        label: 'Story Navigation',
        percentageChange: 0,
        category: 'retention',
        breakdown: navigationBd,
        data: [
          {
            total: String(navigationBd.reduce((s, b) => s + b.value, 0)),
            date: today,
          },
        ],
      });
    }
    return result;
  }
}
