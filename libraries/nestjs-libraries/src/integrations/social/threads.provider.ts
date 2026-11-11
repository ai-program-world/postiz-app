import {
  AnalyticsData,
  AnalyticsPostItem,
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { timer } from '@gitroom/helpers/utils/timer';
import dayjs from 'dayjs';
import {
  BadBody,
  Disconnect,
  RefreshToken,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  aggregatePoints,
  buildBreakdown,
  computePercentageChange,
  computeSeriesTrend,
  mergeDailyPoints,
  previousDateWindows,
  safeAnalyticsCall,
  splitDateWindows,
  summarizePostTitle,
} from '@gitroom/nestjs-libraries/integrations/social/analytics.helper';
import { capitalize, chunk } from 'lodash';
import { Plug } from '@gitroom/helpers/decorators/plug.decorator';
import { Integration } from '@prisma/client';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';

export class ThreadsProvider extends SocialAbstract implements SocialProvider {
  identifier = 'threads';
  name = 'Threads';
  isBetweenSteps = false;
  scopes = [
    'threads_basic',
    'threads_content_publish',
    'threads_manage_replies',
    'threads_manage_insights',
    // 'threads_profile_discovery',
  ];
  override maxConcurrentJob = 20; // Threads limits are per profile
  refreshCron = true;

  editor = 'normal' as const;
  maxLength() {
    return 500;
  }

  override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry';
        value: string;
      }
    | undefined {
    console.log(body);
    if (body.includes('Error validating access token')) {
      return { type: 'refresh-token', value: 'Threads access token expired' };
    }

    if (body.includes('2207051')) {
      return {
        type: 'bad-body',
        value:
          'Error from Meta: We restrict certain activity to protect our community',
      };
    }

    if (body.includes('4279013')) {
      return {
        type: 'bad-body',
        value:
          'User restricted',
      };
    }
    if (body.includes('4279047')) {
      return {
        type: 'bad-body',
        value:
          'Threads rejected the link in this post as an invalid link attachment, please check the link and try again',
      };
    }
    if (body.includes('The media could not be fetched from this URI')) {
      return {
        type: 'bad-body',
        value:
          "One of the media URLs is invalid or inaccessible, make sure it's being uploaded to Postiz first",
      };
    }
    if (body.includes('4279009')) {
      return {
        type: 'retry',
        value:
          'Threads could not find the media container yet, please try again in a few seconds',
      };
    }
    if (body.includes('text must be at most 500 characters')) {
      return {
        type: 'bad-body',
        value: 'Post text exceeds 500 characters limit',
      };
    }

    return undefined;
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    const { access_token } = await (
      await this.fetch(
        `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${refresh_token}`
      )
    ).json();

    const { id, name, username, picture } = await this.fetchUserInfo(
      access_token
    );

    return {
      id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(58, 'days').unix() - dayjs().unix(),
      picture: picture || '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return {
      url:
        'https://www.threads.net/oauth/authorize' +
        `?client_id=${process.env.THREADS_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(
          `${
            process?.env.FRONTEND_URL?.indexOf('https') == -1
              ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
              : `${process?.env.FRONTEND_URL}`
          }/integrations/social/threads`
        )}` +
        `&state=${state}` +
        `&scope=${encodeURIComponent(this.scopes.join(','))}`,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const getAccessToken = await (
      await this.fetch(
        'https://graph.threads.net/oauth/access_token' +
          `?client_id=${process.env.THREADS_APP_ID}` +
          `&redirect_uri=${encodeURIComponent(
            `${
              process?.env.FRONTEND_URL?.indexOf('https') == -1
                ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
                : `${process?.env.FRONTEND_URL}`
            }/integrations/social/threads`
          )}` +
          `&grant_type=authorization_code` +
          `&client_secret=${process.env.THREADS_APP_SECRET}` +
          `&code=${params.code}`
      )
    ).json();

    const { access_token } = await (
      await this.fetch(
        'https://graph.threads.net/access_token' +
          '?grant_type=th_exchange_token' +
          `&client_secret=${process.env.THREADS_APP_SECRET}` +
          `&access_token=${getAccessToken.access_token}`
      )
    ).json();

    const { id, name, username, picture } = await this.fetchUserInfo(
      access_token
    );

    return {
      id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(58, 'days').unix() - dayjs().unix(),
      picture: picture || '',
      username: username,
    };
  }

  // Single, read-only status check of a media container - no loops and no
  // timers, so the post workflow can poll it with durable timers.
  private async checkContainerStatus(
    mediaContainerId: string,
    accessToken: string
  ): Promise<'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED'> {
    const { status, error_message } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${mediaContainerId}?fields=status,error_message&access_token=${accessToken}`
      )
    ).json();

    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new BadBody(
        this.identifier,
        JSON.stringify({ status, error_message }),
        '{}',
        error_message && error_message !== 'UNKNOWN'
          ? error_message
          : 'Threads could not process the media, please check the media format and try again'
      );
    }

    if (status === 'FINISHED' || status === 'PUBLISHED') {
      return status;
    }

    return 'IN_PROGRESS';
  }

  private async checkLoaded(
    mediaContainerId: string,
    accessToken: string
  ): Promise<boolean> {
    // Bounded (the old version recursed forever and could hang the activity
    // into a timeout): ~5.5 minutes at 2.2s intervals.
    for (let i = 0; i < 150; i++) {
      const status = await this.checkContainerStatus(
        mediaContainerId,
        accessToken
      );

      if (status === 'FINISHED' || status === 'PUBLISHED') {
        await timer(2000);
        return true;
      }

      await timer(2200);
    }

    throw new BadBody(
      this.identifier,
      '{}',
      '{}',
      'Threads took too long to process the media, please try again'
    );
  }

  private async fetchUserInfo(accessToken: string) {
    const { id, username, threads_profile_picture_url } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url&access_token=${accessToken}`
      )
    ).json();

    return {
      id,
      name: username,
      picture: threads_profile_picture_url || '',
      username,
    };
  }

  private async createSingleMediaContent(
    userId: string,
    accessToken: string,
    media: { path: string },
    message: string,
    isCarouselItem = false,
    replyToId?: string
  ): Promise<string> {
    const mediaType = hasExtension(media.path, 'mp4')
      ? 'video_url'
      : 'image_url';
    const mediaParams = new URLSearchParams({
      ...(mediaType === 'video_url' ? { video_url: media.path } : {}),
      ...(mediaType === 'image_url' ? { image_url: media.path } : {}),
      ...(isCarouselItem ? { is_carousel_item: 'true' } : {}),
      ...(replyToId ? { reply_to_id: replyToId } : {}),
      media_type: mediaType === 'video_url' ? 'VIDEO' : 'IMAGE',
      text: message,
      access_token: accessToken,
    });

    const { id: mediaId } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${userId}/threads?${mediaParams.toString()}`,
        {
          method: 'POST',
        }
      )
    ).json();

    return mediaId;
  }

  private async createCarouselContent(
    userId: string,
    accessToken: string,
    media: { path: string }[],
    message: string,
    replyToId?: string
  ): Promise<string> {
    // Create each media item
    const mediaIds = [];
    for (const mediaItem of media) {
      const mediaId = await this.createSingleMediaContent(
        userId,
        accessToken,
        mediaItem,
        message,
        true
      );
      mediaIds.push(mediaId);
    }

    // Wait for all media to be loaded
    await Promise.all(
      mediaIds.map((id: string) => this.checkLoaded(id, accessToken))
    );

    // Create carousel container
    const params = new URLSearchParams({
      text: message,
      media_type: 'CAROUSEL',
      children: mediaIds.join(','),
      ...(replyToId ? { reply_to_id: replyToId } : {}),
      access_token: accessToken,
    });

    const { id: containerId } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${userId}/threads?${params.toString()}`,
        {
          method: 'POST',
        }
      )
    ).json();

    return containerId;
  }

  private async createTextContent(
    userId: string,
    accessToken: string,
    message: string,
    replyToId?: string,
    quoteId?: string
  ): Promise<string> {
    const form = new FormData();
    form.append('media_type', 'TEXT');
    form.append('text', message);
    form.append('access_token', accessToken);

    if (replyToId) {
      form.append('reply_to_id', replyToId);
    }

    if (quoteId) {
      form.append('quote_post_id', quoteId);
    }

    const { id: contentId, ...all } = await (
      await this.fetch(`https://graph.threads.net/v1.0/${userId}/threads`, {
        method: 'POST',
        body: form,
      })
    ).json();

    return contentId;
  }

  private async publishThread(
    userId: string,
    accessToken: string,
    creationId: string
  ): Promise<{ threadId: string; permalink: string }> {
    await this.checkLoaded(creationId, accessToken);

    const { id: threadId } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${userId}/threads_publish?creation_id=${creationId}&access_token=${accessToken}`,
        {
          method: 'POST',
        }
      )
    ).json();

    const { permalink } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${threadId}?fields=id,permalink&access_token=${accessToken}`
      )
    ).json();

    return { threadId, permalink };
  }

  private async createThreadContent(
    userId: string,
    accessToken: string,
    postDetails: PostDetails,
    replyToId?: string,
    quoteId?: string
  ): Promise<string> {
    // Handle content creation based on media type
    if (!postDetails.media || postDetails.media.length === 0) {
      // Text-only content
      return await this.createTextContent(
        userId,
        accessToken,
        postDetails.message,
        replyToId,
        quoteId
      );
    } else if (postDetails.media.length === 1) {
      // Single media content
      return await this.createSingleMediaContent(
        userId,
        accessToken,
        postDetails.media[0],
        postDetails.message,
        false,
        replyToId
      );
    } else {
      // Carousel content
      return await this.createCarouselContent(
        userId,
        accessToken,
        postDetails.media,
        postDetails.message,
        replyToId
      );
    }
  }

  // The thread is live, the permalink is only cosmetic: never fail (and risk
  // re-publishing) a live post over it.
  private async threadPermalink(
    threadId: string,
    accessToken: string,
    integration: Integration
  ): Promise<string> {
    try {
      const { permalink } = await (
        await this.fetch(
          `https://graph.threads.net/v1.0/${threadId}?fields=id,permalink&access_token=${accessToken}`
        )
      ).json();
      return permalink;
    } catch (err) {
      return `https://www.threads.net/@${integration.profile}`;
    }
  }

  async postPending(
    userId: string,
    accessToken: string,
    postDetails: PostDetails<{
      active_thread_finisher: boolean;
      thread_finisher: string;
    }>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    if (!postDetails.length) {
      return [];
    }

    const [firstPost] = postDetails;

    // Carousels: only create the child containers here, the carousel container
    // itself is created by finalizePost once the children are processed.
    if ((firstPost.media?.length || 0) > 1) {
      const childIds = [];
      for (const mediaItem of firstPost.media!) {
        childIds.push(
          await this.createSingleMediaContent(
            userId,
            accessToken,
            mediaItem,
            firstPost.message,
            true
          )
        );
      }

      return [
        {
          id: firstPost.id,
          postId: '',
          releaseURL: '',
          status: 'pending',
          pendingData: {
            step: 'children',
            childIds,
            message: firstPost.message,
          },
        },
      ];
    }

    // Text / single media: one container, nothing is visible until
    // threads_publish runs in finalizePost.
    const containerId =
      !firstPost.media || firstPost.media.length === 0
        ? await this.createTextContent(userId, accessToken, firstPost.message)
        : await this.createSingleMediaContent(
            userId,
            accessToken,
            firstPost.media[0],
            firstPost.message,
            false
          );

    return [
      {
        id: firstPost.id,
        postId: '',
        releaseURL: '',
        status: 'pending',
        pendingData: { step: 'container', containerId },
      },
    ];
  }

  override async checkPostStatus(
    accessToken: string,
    pendingData: {
      step: 'children' | 'container';
      childIds?: string[];
      containerId?: string;
      message?: string;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    // waiting for the carousel children to be processed
    if (pendingData.step === 'children') {
      for (const childId of pendingData.childIds || []) {
        const status = await this.checkContainerStatus(childId, accessToken);
        if (status === 'IN_PROGRESS') {
          return { status: 'pending', pendingData };
        }
      }

      // all children processed, finalizePost creates the carousel container
      return { status: 'ready', pendingData };
    }

    const status = await this.checkContainerStatus(
      pendingData.containerId!,
      accessToken
    );

    if (status === 'IN_PROGRESS') {
      return { status: 'pending', pendingData };
    }

    // a previous finalizePost published but died before reporting: the post is
    // live, never publish again
    if (status === 'PUBLISHED') {
      return {
        status: 'completed',
        postId: pendingData.containerId!,
        releaseURL: `https://www.threads.net/@${integration.profile}`,
      };
    }

    return { status: 'ready', pendingData };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: {
      step: 'children' | 'container';
      childIds?: string[];
      containerId?: string;
      message?: string;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    // the carousel children are processed: create the carousel container and
    // hand back to the workflow to wait for it (an orphan container from a
    // crashed run is invisible, so re-running this is safe)
    if (pendingData.step === 'children') {
      const params = new URLSearchParams({
        text: pendingData.message || '',
        media_type: 'CAROUSEL',
        children: (pendingData.childIds || []).join(','),
        access_token: accessToken,
      });

      const { id: containerId } = await (
        await this.fetch(
          `https://graph.threads.net/v1.0/${integration.internalId}/threads?${params.toString()}`,
          {
            method: 'POST',
          }
        )
      ).json();

      return {
        status: 'pending',
        pendingData: { step: 'container', containerId },
      };
    }

    const { id: threadId } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${integration.internalId}/threads_publish?creation_id=${pendingData.containerId}&access_token=${accessToken}`,
        {
          method: 'POST',
        }
      )
    ).json();

    return {
      status: 'completed',
      postId: threadId,
      releaseURL: await this.threadPermalink(threadId, accessToken, integration),
    };
  }

  // Old blocking behavior, kept for workflow versions before v1.0.6 that don't
  // know how to resolve a `pending` response.
  async post(
    userId: string,
    accessToken: string,
    postDetails: PostDetails<{
      active_thread_finisher: boolean;
      thread_finisher: string;
    }>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    if (!postDetails.length) {
      return [];
    }

    const [firstPost] = postDetails;
    const [response] = await this.postPending(
      userId,
      accessToken,
      postDetails,
      integration
    );

    let pendingData = response.pendingData;
    const started = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Cap below the 10-minute activity timeout of the old workflows using
      // this method: failing here (non-retryable) is safe, timing the
      // activity out is not - a retried activity would publish again.
      if (Date.now() - started > 8 * 60 * 1000) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          'Threads took too long to process the media, please try again'
        );
      }

      const check = await this.checkPostStatus(
        accessToken,
        pendingData,
        integration
      );

      if (check.status === 'pending') {
        pendingData = check.pendingData;
        await timer(2200);
        continue;
      }

      const result =
        check.status === 'ready'
          ? await this.finalizePost(accessToken, check.pendingData, integration)
          : check;

      if (result.status === 'completed') {
        return [
          {
            id: firstPost.id,
            postId: result.postId,
            status: 'success',
            releaseURL: result.releaseURL,
          },
        ];
      }

      pendingData = result.pendingData;
      await timer(2200);
    }
  }

  async comment(
    userId: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<{
      active_thread_finisher: boolean;
      thread_finisher: string;
    }>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    if (!postDetails.length) {
      return [];
    }

    const [commentPost] = postDetails;
    const replyToId = lastCommentId || postId;

    // Create reply content
    const replyContentId = await this.createThreadContent(
      userId,
      accessToken,
      commentPost,
      replyToId
    );

    // Publish the reply
    const { threadId: replyThreadId, permalink } = await this.publishThread(
      userId,
      accessToken,
      replyContentId
    );

    return [
      {
        id: commentPost.id,
        postId: replyThreadId,
        status: 'success',
        releaseURL: permalink,
      },
    ];
  }

  private async fetchThreadsJson(url: string): Promise<any> {
    const res = await fetch(url);
    const json = await res.json();
    if (json?.error) {
      if (json.error.code === 190) {
        throw new RefreshToken(this.identifier, JSON.stringify(json), '{}');
      }
      throw new Error(json.error.message || 'Threads API error');
    }
    return json;
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');
    const windows = splitDateWindows(date, 28);
    const prevWindows = date <= 30 ? previousDateWindows(date, 28) : [];
    const result: AnalyticsData[] = [];

    // 1. Followers snapshot
    const followersCount = await safeAnalyticsCall<number | undefined>(
      'threads.followers_count',
      async () => {
        const res = await this.fetchThreadsJson(
          `https://graph.threads.net/v1.0/${id}/threads_insights?metric=followers_count&access_token=${accessToken}`
        );
        const item = res?.data?.find((d: any) => d.name === 'followers_count');
        const val = item?.total_value?.value ?? item?.values?.[0]?.value;
        return val !== undefined ? Number(val) : undefined;
      },
      undefined
    );

    if (followersCount !== undefined) {
      result.push({
        label: 'Followers',
        percentageChange: 0,
        aggregation: 'latest',
        unit: 'number',
        category: 'overview',
        data: [{ total: String(followersCount), date: today }],
      });
    }

    // 2. Chunked core metrics (views time-series + likes/replies/reposts/quotes totals)
    const fetchWindowMetrics = async (winList = windows) => {
      const viewsRaw: Array<{ date: string; total: number }> = [];
      const totals: Record<string, number> = {};

      for (const w of winList) {
        const res = await this.fetchThreadsJson(
          `https://graph.threads.net/v1.0/${id}/threads_insights?metric=views,likes,replies,reposts,quotes&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
        );
        for (const d of res?.data || []) {
          if (Array.isArray(d.values) && d.values.length > 0) {
            for (const v of d.values) {
              viewsRaw.push({
                date: dayjs(v.end_time).format('YYYY-MM-DD'),
                total: Number(v.value) || 0,
              });
            }
          } else if (d.total_value?.value !== undefined) {
            totals[d.name] =
              (totals[d.name] || 0) + (Number(d.total_value.value) || 0);
          }
        }
      }
      return { viewsPoints: mergeDailyPoints(viewsRaw), totals };
    };

    const [currentCore, prevCore, clicksTotal] = await Promise.all([
      safeAnalyticsCall(
        'threads.core',
        () => fetchWindowMetrics(windows),
        { viewsPoints: [], totals: {} as Record<string, number> }
      ),
      prevWindows.length > 0
        ? safeAnalyticsCall(
            'threads.core.prev',
            () => fetchWindowMetrics(prevWindows),
            { viewsPoints: [], totals: {} as Record<string, number> }
          )
        : Promise.resolve({
            viewsPoints: [],
            totals: {} as Record<string, number>,
          }),
      safeAnalyticsCall<
        { sum: number; byLink: Record<string, number> } | undefined
      >(
        'threads.clicks',
        async () => {
          let sum = 0;
          let found = false;
          const byLink: Record<string, number> = {};
          for (const w of windows) {
            const res = await this.fetchThreadsJson(
              `https://graph.threads.net/v1.0/${id}/threads_insights?metric=clicks&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
            );
            const d = res?.data?.[0];
            if (Array.isArray(d?.link_total_values)) {
              // `clicks` is a "Link Total Values" metric: one entry per shared URL
              for (const l of d.link_total_values) {
                const v = Number(l?.value) || 0;
                sum += v;
                if (l?.link_url) {
                  byLink[l.link_url] = (byLink[l.link_url] || 0) + v;
                }
              }
              found = true;
            } else if (d?.total_value?.value !== undefined) {
              sum += Number(d.total_value.value) || 0;
              found = true;
            } else if (Array.isArray(d?.values)) {
              for (const v of d.values) sum += Number(v.value) || 0;
              found = true;
            }
          }
          return found ? { sum, byLink } : undefined;
        },
        undefined
      ),
    ]);

    const viewsSum =
      currentCore.viewsPoints.length > 0
        ? aggregatePoints(currentCore.viewsPoints, 'sum')
        : currentCore.totals.views || 0;
    const prevViewsSum =
      prevCore.viewsPoints.length > 0
        ? aggregatePoints(prevCore.viewsPoints, 'sum')
        : prevCore.totals.views;

    if (currentCore.viewsPoints.length > 0) {
      result.push({
        label: 'Views',
        percentageChange:
          prevViewsSum !== undefined && prevViewsSum > 0
            ? computePercentageChange(viewsSum, prevViewsSum)
            : computeSeriesTrend(currentCore.viewsPoints, 'sum'),
        aggregation: 'sum',
        unit: 'number',
        category: 'overview',
        data: currentCore.viewsPoints,
      });
    } else if (currentCore.totals.views !== undefined) {
      result.push({
        label: 'Views',
        percentageChange: computePercentageChange(
          currentCore.totals.views,
          prevCore.totals.views
        ),
        aggregation: 'sum',
        unit: 'number',
        category: 'overview',
        data: [{ total: String(currentCore.totals.views), date: today }],
      });
    }

    for (const metricName of ['likes', 'replies', 'reposts', 'quotes']) {
      const val = currentCore.totals[metricName];
      if (val === undefined) continue;
      result.push({
        label: capitalize(metricName),
        percentageChange: computePercentageChange(
          val,
          prevCore.totals[metricName]
        ),
        aggregation: 'sum',
        unit: 'number',
        category: 'engagement',
        data: [{ total: String(val), date: today }],
      });
    }

    if (clicksTotal !== undefined) {
      result.push({
        label: 'Link Clicks',
        percentageChange: 0,
        aggregation: 'sum',
        unit: 'number',
        category: 'traffic',
        data: [{ total: String(clicksTotal.sum), date: today }],
      });
      const linksBd = buildBreakdown(clicksTotal.byLink, 10);
      if (linksBd.length > 0) {
        result.push({
          label: 'Clicks by Link',
          percentageChange: 0,
          category: 'traffic',
          breakdown: linksBd,
          data: [{ total: String(clicksTotal.sum), date: today }],
        });
      }
    }

    const totalInteractions =
      (currentCore.totals.likes || 0) +
      (currentCore.totals.replies || 0) +
      (currentCore.totals.reposts || 0) +
      (currentCore.totals.quotes || 0);
    const prevInteractions =
      (prevCore.totals.likes || 0) +
      (prevCore.totals.replies || 0) +
      (prevCore.totals.reposts || 0) +
      (prevCore.totals.quotes || 0);

    if (
      currentCore.totals.likes !== undefined ||
      currentCore.totals.replies !== undefined
    ) {
      result.push({
        label: 'Total Interactions',
        percentageChange:
          prevWindows.length > 0
            ? computePercentageChange(totalInteractions, prevInteractions)
            : 0,
        aggregation: 'sum',
        unit: 'number',
        category: 'engagement',
        data: [{ total: String(totalInteractions), date: today }],
      });

      if (viewsSum > 0) {
        const engRate = Number(((totalInteractions / viewsSum) * 100).toFixed(2));
        const prevEngRate =
          prevViewsSum && prevViewsSum > 0
            ? (prevInteractions / prevViewsSum) * 100
            : undefined;
        result.push({
          label: 'Engagement Rate',
          average: true,
          unit: 'percent',
          aggregation: 'latest',
          category: 'engagement',
          percentageChange: computePercentageChange(
            engRate,
            prevEngRate,
            true
          ),
          data: [{ total: String(engRate), date: today }],
        });
      }
    }

    // 3. Follower demographics (country, city, age, gender; requires >= 100 followers)
    const fetchThreadsDemo = async (
      breakdown: 'country' | 'city' | 'age' | 'gender'
    ): Promise<Record<string, number>> => {
      const res = await this.fetchThreadsJson(
        `https://graph.threads.net/v1.0/${id}/threads_insights?metric=follower_demographics&breakdown=${breakdown}&access_token=${accessToken}`
      );
      const results =
        res?.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
      const map: Record<string, number> = {};
      for (const row of results) {
        const dim = (row.dimension_values || []).join(' ');
        if (!dim) continue;
        map[dim] = (map[dim] || 0) + (Number(row.value) || 0);
      }
      return map;
    };

    const [countryMap, cityMap, ageMap, genderMap] = await Promise.all([
      safeAnalyticsCall(
        'threads.demo.country',
        () => fetchThreadsDemo('country'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'threads.demo.city',
        () => fetchThreadsDemo('city'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'threads.demo.age',
        () => fetchThreadsDemo('age'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'threads.demo.gender',
        () => fetchThreadsDemo('gender'),
        {} as Record<string, number>
      ),
    ]);

    const addDemoCard = (title: string, raw: Record<string, number>, limit = 10) => {
      const bd = buildBreakdown(raw, limit);
      if (bd.length > 0) {
        const sum = bd.reduce((a, b) => a + b.value, 0);
        result.push({
          label: title,
          percentageChange: 0,
          category: 'audience',
          breakdown: bd,
          data: [{ total: String(sum), date: today }],
        });
      }
    };

    addDemoCard('Audience by Country', countryMap, 10);
    addDemoCard('Audience by City', cityMap, 10);
    addDemoCard('Audience by Age', ageMap, 10);
    addDemoCard('Audience by Gender', genderMap, 6);

    // 4. Recent Threads Leaderboard
    const recentThreads = await safeAnalyticsCall<AnalyticsPostItem[]>(
      'threads.recent_posts',
      async () => {
        const listRes = await this.fetchThreadsJson(
          `https://graph.threads.net/v1.0/${id}/threads?fields=id,text,media_type,permalink,thumbnail_url,media_url,timestamp&limit=12&access_token=${accessToken}`
        );
        const items: any[] = listRes?.data || [];
        return Promise.all(
          items.map(async (item) => {
            const ins = await safeAnalyticsCall(
              `threads.post_insight.${item.id}`,
              () =>
                this.fetchThreadsJson(
                  `https://graph.threads.net/v1.0/${item.id}/insights?metric=views,likes,replies,reposts,quotes,shares&access_token=${accessToken}`
                ),
              null
            );
            const m: Record<string, number> = {};
            for (const row of ins?.data || []) {
              const val = row?.values?.[0]?.value ?? row?.total_value?.value;
              if (val !== undefined) m[row.name] = Number(val) || 0;
            }
            const views = m.views;
            const likes = m.likes;
            const comments = m.replies;
            const shares = (m.reposts || 0) + (m.quotes || 0) + (m.shares || 0);
            const interactions = (likes || 0) + (comments || 0) + shares;
            return {
              id: String(item.id),
              title: summarizePostTitle(item.text, item.media_type || 'Thread'),
              url: item.permalink,
              thumbnail:
                item.thumbnail_url ||
                (item.media_type === 'IMAGE' ? item.media_url : undefined),
              publishedAt: item.timestamp
                ? dayjs(item.timestamp).format('YYYY-MM-DD HH:mm')
                : today,
              mediaType: item.media_type,
              views,
              likes,
              comments,
              shares,
              engagementRate:
                views && views > 0
                  ? Number(((interactions / views) * 100).toFixed(2))
                  : undefined,
            } as AnalyticsPostItem;
          })
        );
      },
      []
    );

    if (recentThreads.length > 0) {
      result.push({
        label: 'Recent Posts Performance',
        percentageChange: 0,
        category: 'posts',
        posts: recentThreads,
        data: [{ total: String(recentThreads.length), date: today }],
      });
    }

    return result;
  }

  @Plug({
    identifier: 'threads-autoPlugPost',
    title: 'Auto plug post',
    description:
      'When a post reached a certain number of likes, add another post to it so you followers get a notification about your promotion',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
      {
        name: 'post',
        type: 'richtext',
        placeholder: 'Post to plug',
        description: 'Message content to plug',
        validation: /^[\s\S]{3,}$/g,
      },
    ],
  })
  async autoPlugPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string; post: string }
  ) {
    const { data } = await (
      await fetch(
        `https://graph.threads.net/v1.0/${id}/insights?metric=likes&access_token=${integration.token}`
      )
    ).json();

    const {
      values: [value],
    } = data.find((p: any) => p.name === 'likes');

    if (value.value >= fields.likesAmount) {
      await timer(2000);

      const form = new FormData();
      form.append('media_type', 'TEXT');
      form.append('text', stripHtmlValidation('normal', fields.post, true));
      form.append('reply_to_id', id);
      form.append('access_token', integration.token);

      const { id: replyId } = await (
        await this.fetch('https://graph.threads.net/v1.0/me/threads', {
          method: 'POST',
          body: form,
        })
      ).json();

      await (
        await this.fetch(
          `https://graph.threads.net/v1.0/${integration.internalId}/threads_publish?creation_id=${replyId}&access_token=${integration.token}`,
          {
            method: 'POST',
          }
        )
      ).json();
      return true;
    }

    return false;
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');

    try {
      const [coreData, sharesData] = await Promise.all([
        this.fetchThreadsJson(
          `https://graph.threads.net/v1.0/${postId}/insights?metric=views,likes,replies,reposts,quotes&access_token=${accessToken}`
        ),
        safeAnalyticsCall(
          'threads.post.shares',
          () =>
            this.fetchThreadsJson(
              `https://graph.threads.net/v1.0/${postId}/insights?metric=shares&access_token=${accessToken}`
            ),
          null
        ),
      ]);

      const data = [...(coreData?.data || []), ...(sharesData?.data || [])];
      if (data.length === 0) {
        return [];
      }

      const result: AnalyticsData[] = [];
      const valuesMap: Record<string, number> = {};

      for (const metric of data) {
        const value = metric.values?.[0]?.value ?? metric.total_value?.value;
        if (value === undefined) continue;
        valuesMap[metric.name] = Number(value) || 0;

        let label = '';
        switch (metric.name) {
          case 'views':
            label = 'Views';
            break;
          case 'likes':
            label = 'Likes';
            break;
          case 'replies':
            label = 'Replies';
            break;
          case 'reposts':
            label = 'Reposts';
            break;
          case 'quotes':
            label = 'Quotes';
            break;
          case 'shares':
            label = 'Shares';
            break;
        }

        if (label) {
          result.push({
            label,
            percentageChange: 0,
            unit: 'number',
            aggregation: 'latest',
            category: metric.name === 'views' ? 'overview' : 'engagement',
            data: [{ total: String(value), date: today }],
          });
        }
      }

      const interactions =
        (valuesMap.likes || 0) +
        (valuesMap.replies || 0) +
        (valuesMap.reposts || 0) +
        (valuesMap.quotes || 0) +
        (valuesMap.shares || 0);
      result.push({
        label: 'Total Interactions',
        percentageChange: 0,
        unit: 'number',
        aggregation: 'latest',
        category: 'engagement',
        data: [{ total: String(interactions), date: today }],
      });

      if ((valuesMap.views || 0) > 0) {
        result.push({
          label: 'Engagement Rate',
          percentageChange: 0,
          average: true,
          unit: 'percent',
          aggregation: 'latest',
          category: 'engagement',
          data: [
            {
              total: String(
                Number(((interactions / valuesMap.views) * 100).toFixed(2))
              ),
              date: today,
            },
          ],
        });
      }

      return result;
    } catch (err: any) {
      if (err instanceof RefreshToken || err instanceof Disconnect) {
        throw err;
      }
      console.error(
        'Error fetching Threads post analytics:',
        err?.cause?.code || err?.message || err
      );
      return [];
    }
  }

  // override async mention(
  //   token: string,
  //   data: { query: string },
  //   id: string,
  //   integration: Integration
  // ) {
  //   const p = await (
  //     await fetch(
  //       `https://graph.threads.net/v1.0/profile_lookup?username=${data.query}&access_token=${integration.token}`
  //     )
  //   ).json();
  //
  //   return [
  //     {
  //       id: String(p.id),
  //       label: p.name,
  //       image: p.profile_picture_url,
  //     },
  //   ];
  // }
  //
  // mentionFormat(idOrHandle: string, name: string) {
  //   return `@${idOrHandle}`;
  // }
}
