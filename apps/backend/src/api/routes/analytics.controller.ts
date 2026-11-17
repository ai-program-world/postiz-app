import { Controller, Get, Param, Query } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { ApiTags } from '@nestjs/swagger';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { AnalyticsSnapshotService } from '@gitroom/nestjs-libraries/database/prisma/analytics-snapshots/analytics.snapshot.service';

@ApiTags('Analytics')
@Controller('/analytics')
export class AnalyticsController {
  constructor(
    private _postsService: PostsService,
    private _analyticsSnapshotService: AnalyticsSnapshotService
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
