import { Controller, Get, Param, Query } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { ApiTags } from '@nestjs/swagger';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { AnalyticsSnapshotService } from '@gitroom/nestjs-libraries/database/prisma/analytics-snapshots/analytics.snapshot.service';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { GetAnalyticsPostsDto } from '@gitroom/nestjs-libraries/dtos/analytics/get.analytics.posts.dto';

@ApiTags('Analytics')
@Controller('/analytics')
export class AnalyticsController {
  constructor(
    private _postsService: PostsService,
    private _analyticsSnapshotService: AnalyticsSnapshotService,
    private _integrationService: IntegrationService
  ) {}

  @Get('/:integration')
  async getIntegration(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') integration: string,
    @Query('date') date: string,
    @Query('refresh') refresh?: string
  ) {
    const skipCache = refresh === 'true' || refresh === '1';
    // Stored history is app-only for now, the public API keeps checkAnalytics
    return this._analyticsSnapshotService.checkAnalyticsWithHistory(
      org,
      integration,
      date,
      skipCache
    );
  }

  // Next pages of the posts leaderboard, from the card's postsNextCursor
  @Get('/:integration/posts')
  async getIntegrationPosts(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') integration: string,
    @Query() query: GetAnalyticsPostsDto
  ) {
    return this._integrationService.checkAnalyticsPosts(
      org,
      integration,
      query.date,
      query.limit || 10,
      query.cursor
    );
  }

  @Get('/post/:postId')
  async getPostAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string,
    @Query('date') date: string,
    @Query('refresh') refresh?: string
  ) {
    const skipCache = refresh === 'true' || refresh === '1';
    return this._postsService.checkPostAnalytics(
      org.id,
      postId,
      +date,
      false,
      skipCache
    );
  }
}
