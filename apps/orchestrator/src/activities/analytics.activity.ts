import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import {
  AnalyticsSnapshotService,
  AnalyticsSyncKind,
} from '@gitroom/nestjs-libraries/database/prisma/analytics-snapshots/analytics.snapshot.service';
import { withHeartbeat } from '@gitroom/nestjs-libraries/temporal/temporal.heartbeat';

@Injectable()
@Activity()
export class AnalyticsActivity {
  constructor(private _analyticsSnapshotService: AnalyticsSnapshotService) {}

  // Walks every channel inside one activity (like
  // searchForMissingThreeHoursPosts), so the workflow history stays small
  @ActivityMethod()
  async syncAnalytics(kind: AnalyticsSyncKind) {
    return withHeartbeat(() => this._analyticsSnapshotService.syncAll(kind));
  }
}
