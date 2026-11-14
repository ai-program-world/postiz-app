import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { AnalyticsActivity } from '@gitroom/orchestrator/activities/analytics.activity';

// One run can walk thousands of channels: the activity heartbeats, so a long
// budget is safe and a dead worker is still noticed within minutes
const { syncAnalytics } = proxyActivities<AnalyticsActivity>({
  startToCloseTimeout: '55 minute',
  heartbeatTimeout: '5 minute',
  retry: {
    maximumAttempts: 2,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

const runSafely = async (kind: 'snapshot' | 'story') => {
  try {
    await syncAnalytics(kind);
  } catch (err) {
    // a failed hour must not end the cron, the next hour tries again
  }
};

// Every hour: store live stories before they expire (24h), and take today's
// follower snapshot for channels that do not have one yet
export async function analyticsSnapshotWorkflow() {
  for (let hour = 0; hour < 24; hour++) {
    await runSafely('snapshot');
    await runSafely('story');
    await sleep('1 hour');
  }
  return await continueAsNew<typeof analyticsSnapshotWorkflow>();
}
