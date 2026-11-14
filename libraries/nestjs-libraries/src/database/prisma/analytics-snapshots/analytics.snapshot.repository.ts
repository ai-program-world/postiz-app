import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import {
  AnalyticsSnapshotData,
  StoryInsightData,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

@Injectable()
export class AnalyticsSnapshotRepository {
  constructor(
    private _integration: PrismaRepository<'integration'>,
    private _analyticsSnapshot: PrismaRepository<'analyticsSnapshot'>,
    private _storyInsight: PrismaRepository<'storyInsight'>
  ) {}

  // Paged by id; for snapshots only channels that have no row for `missingOn`
  getSyncIntegrations(
    providerIdentifiers: string[],
    take: number,
    cursor?: string,
    missingOn?: Date
  ) {
    return this._integration.model.integration.findMany({
      where: {
        providerIdentifier: { in: providerIdentifiers },
        type: 'social',
        deletedAt: null,
        disabled: false,
        inBetweenSteps: false,
        refreshNeeded: false,
        ...(missingOn
          ? { analyticsSnapshots: { none: { date: missingOn } } }
          : {}),
      },
      select: {
        id: true,
        organizationId: true,
      },
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }

  upsertSnapshot(
    orgId: string,
    integrationId: string,
    date: Date,
    data: AnalyticsSnapshotData
  ) {
    return this._analyticsSnapshot.model.analyticsSnapshot.upsert({
      where: {
        integrationId_date: { integrationId, date },
      },
      create: {
        organizationId: orgId,
        integrationId,
        date,
        followers: data.followers ?? null,
        demographics: data.demographics ?? undefined,
      },
      // keep the earlier value of a field this run could not read
      update: {
        followers: data.followers ?? undefined,
        demographics: data.demographics ?? undefined,
      },
      select: { id: true },
    });
  }

  upsertStoryInsight(
    orgId: string,
    integrationId: string,
    story: StoryInsightData
  ) {
    const fields = {
      permalink: story.permalink || null,
      thumbnail: story.thumbnail || null,
      mediaType: story.mediaType || null,
      publishedAt: new Date(story.publishedAt),
      metrics: story.metrics,
    };
    return this._storyInsight.model.storyInsight.upsert({
      where: {
        integrationId_internalId: { integrationId, internalId: story.id },
      },
      create: {
        organizationId: orgId,
        integrationId,
        internalId: story.id,
        ...fields,
      },
      update: fields,
      select: { id: true },
    });
  }

  getSnapshots(orgId: string, integrationId: string, since: Date) {
    return this._analyticsSnapshot.model.analyticsSnapshot.findMany({
      where: {
        organizationId: orgId,
        integrationId,
        date: { gte: since },
      },
      select: {
        date: true,
        followers: true,
      },
      orderBy: { date: 'asc' },
    });
  }

  getStoryInsights(orgId: string, integrationId: string, since: Date) {
    return this._storyInsight.model.storyInsight.findMany({
      where: {
        organizationId: orgId,
        integrationId,
        publishedAt: { gte: since },
      },
      select: {
        internalId: true,
        permalink: true,
        thumbnail: true,
        mediaType: true,
        publishedAt: true,
        metrics: true,
      },
      orderBy: { publishedAt: 'desc' },
    });
  }
}
