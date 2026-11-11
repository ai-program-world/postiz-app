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
import dayjs from 'dayjs';
import {
  BadBody,
  Disconnect,
  RefreshToken,
  SocialAbstract,
  ValidityMedia,
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
import {
  FacebookDto,
  FACEBOOK_PRESET_MAX_CHARS,
} from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/facebook.dto';
import { DribbbleDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/dribbble.dto';
import { Integration } from '@prisma/client';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { timer } from '@gitroom/helpers/utils/timer';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { DashboardFunction } from '@gitroom/nestjs-libraries/integrations/dashboard.function.decorator';

export const META_GRAPH_API_VERSION = 'v25.0';

@Rules(
  "Facebook posts can be text only, or include photos or a video. If it's a story, it must have at least one attachment (photo or video), and each media is published as a separate story. Video posts (not stories) can carry an optional title."
)
export class FacebookProvider extends SocialAbstract implements SocialProvider {
  identifier = 'facebook';
  name = 'Facebook Page';
  isBetweenSteps = true;
  scopes = [
    'pages_show_list',
    'business_management',
    'pages_manage_posts',
    'pages_manage_engagement',
    'pages_read_engagement',
    'read_insights',
  ];
  override maxConcurrentJob = 500; // Facebook has reasonable rate limits
  editor = 'normal' as const;
  maxLength() {
    return 63206;
  }
  dto = FacebookDto;

  override async checkValidity(
    [firstPost]: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    if (settings?.post_type === 'story') {
      if (!firstPost?.length) {
        return 'Story should have at least one media';
      }
    }
    return true;
  }

  override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry';
        value: string;
      }
    | undefined {
    // Access token validation errors - require re-authentication
    if (body.indexOf('Error validating access token') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Please re-authenticate your Facebook account',
      };
    }

    if (body.indexOf('REVOKED_ACCESS_TOKEN') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Access token has been revoked, please re-authenticate',
      };
    }

    // The token is valid but belongs to the user, not to the page - the page
    // was never granted to the app, so only reconnecting can fix it
    if (
      body.indexOf(
        'Unpublished posts must be posted to a page as the page itself'
      ) > -1
    ) {
      return {
        type: 'refresh-token' as const,
        value:
          'Postiz is not authorized to publish as this page, please reconnect the channel',
      };
    }

    if (body.indexOf('(#200)') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Facebook rejected the post due to missing permissions. Make sure your Facebook account has full content access to the Page, then reconnect the channel.',
      };
    }

    if (body.indexOf('1366046') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Photos should be smaller than 4 MB and saved as JPG, PNG',
      };
    }

    // code 368 "Temporarily blocked for policies violations" (subcode
    // 1390008): Meta documents it as temporary, "wait and retry the operation"
    if (body.indexOf('1390008') > -1) {
      return {
        type: 'retry' as const,
        value: 'You are posting too fast, please slow down',
      };
    }

    // Content policy violations
    if (body.indexOf('1346003') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Content flagged as abusive by Facebook',
      };
    }

    if (body.indexOf('1404006') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          "We couldn't post your comment, A security check in facebook required to proceed.",
      };
    }

    if (body.indexOf('2069019') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid file',
      }
    }

    if (body.indexOf('1404102') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Content violates Facebook Community Standards',
      };
    }

    // Permission errors
    if (body.indexOf('1404078') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Page publishing authorization required, please re-authenticate',
      };
    }

    if (body.indexOf('1366051') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'These photos were already posted.',
      };
    }

    if (body.indexOf('1609008') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Cannot post Facebook.com links',
      };
    }

    // Parameter validation errors
    if (body.indexOf('2061006') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid URL format in post content',
      };
    }

    if (body.indexOf('1349125') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid content format',
      };
    }

    if (body.indexOf('1404112') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'For security reasons, your account has limited access to the site for a few days',
      };
    }

    if (body.indexOf('Name parameter too long') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Post content is too long',
      };
    }

    // Service errors - checking specific subcodes first
    if (body.indexOf('1363047') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Facebook service temporarily unavailable',
      };
    }

    if (body.indexOf('1609010') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Facebook service temporarily unavailable',
      };
    }

    if (body.indexOf('4854002') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Confirm your identity before you can publish as this Page. Open the Facebook app on your phone and follow the instructions',
      };
    }
    if (body.indexOf('(#100) No permission to publish the video') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Facebook return: No permission to publish the video',
      };
    }
    if (/"error_subcode":459\b/.test(body)) {
      return {
        type: 'bad-body' as const,
        value:
          'Facebook is asking you to resolve a security check. Log in at facebook.com, complete it, then try again',
      };
    }
    if (/"error_subcode":492\b/.test(body)) {
      return {
        type: 'bad-body' as const,
        value:
          'Your Facebook user no longer has a role on this Page. Ask a Page admin to grant you a role, then reconnect the channel',
      };
    }
    if (body.indexOf('must be granted before impersonating') > -1) {
      return {
        type: 'refresh-token' as const,
        value:
          'Facebook Page permissions are missing, please reconnect the channel and allow all permissions',
      };
    }
    if (
      /"error_subcode":33\b/.test(body) &&
      body.indexOf('does not exist') > -1
    ) {
      return {
        type: 'bad-body' as const,
        value:
          'The Facebook Page or post this was targeting no longer exists, please reconnect the channel and schedule again',
      };
    }
    if (body.indexOf('Sorry, something went wrong') > -1) {
      return {
        type: 'retry' as const,
        value: 'Facebook is temporarily unavailable, please try again later',
      };
    }
    if (body.indexOf('490') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Access token expired, please re-authenticate',
      };
    }

    if (status === 401) {
      return {
        type: 'bad-body' as const,
        value:
          'An unknown error occurred, please try again later or contact support',
      };
    }

    return undefined;
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return {
      url:
        `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth` +
        `?client_id=${process.env.FACEBOOK_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(
          `${process.env.FRONTEND_URL}/integrations/social/facebook`
        )}` +
        `&state=${state}` +
        `&scope=${this.scopes.join(',')}`,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const information = await this.fetchPageInformation(accessToken, {
      page: requiredId,
    });

    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const getAccessToken = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token` +
          `?client_id=${process.env.FACEBOOK_APP_ID}` +
          `&redirect_uri=${encodeURIComponent(
            `${process.env.FRONTEND_URL}/integrations/social/facebook${
              params.refresh ? `?refresh=${params.refresh}` : ''
            }`
          )}` +
          `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
          `&code=${params.code}`
      )
    ).json();

    const { access_token } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token` +
          '?grant_type=fb_exchange_token' +
          `&client_id=${process.env.FACEBOOK_APP_ID}` +
          `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
          `&fb_exchange_token=${getAccessToken.access_token}&fields=access_token,expires_in`
      )
    ).json();

    const { data } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/permissions?access_token=${access_token}`
      )
    ).json();

    const permissions = data
      .filter((d: any) => d.status === 'granted')
      .map((p: any) => p.permission);
    this.checkScopes(this.scopes, permissions);

    const { id, name, picture } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me?fields=id,name,picture&access_token=${access_token}`
      )
    ).json();

    return {
      id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(59, 'days').unix() - dayjs().unix(),
      picture: picture?.data?.url || '',
      username: '',
    };
  }

  @DashboardFunction()
  async pages(accessToken: string) {
    const seenIds = new Set<string>();
    const allPages: any[] = [];

    const fetchPaginated = async (startUrl: string) => {
      let nextUrl: string | undefined = startUrl;
      while (nextUrl) {
        const response = await (await fetch(nextUrl)).json();
        if (response.data) {
          for (const page of response.data) {
            if (!seenIds.has(page.id)) {
              seenIds.add(page.id);
              allPages.push(page);
            }
          }
        }
        nextUrl = response.paging?.next;
      }
    };

    // Fetch pages the user explicitly shared during the OAuth dialog
    await fetchPaginated(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/accounts?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${accessToken}`
    );

    // Also fetch pages via Business Manager API to discover pages
    // not selected during the OAuth page selection step
    try {
      let bizUrl:
        | string
        | undefined = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/businesses?access_token=${accessToken}`;

      while (bizUrl) {
        const bizResponse = await (await fetch(bizUrl)).json();
        if (bizResponse.data) {
          for (const business of bizResponse.data) {
            try {
              await fetchPaginated(
                `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${business.id}/owned_pages?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${accessToken}`
              );
            } catch {
              // Continue with other businesses
            }

            try {
              await fetchPaginated(
                `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${business.id}/client_pages?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${accessToken}`
              );
            } catch {
              // Continue with other businesses
            }
          }
        }
        bizUrl = bizResponse.paging?.next;
      }
    } catch {
      // Business Manager API not available for all users
    }

    return allPages;
  }

  async fetchPageInformation(accessToken: string, data: { page: string }) {
    const pageId = data.page;
    const fields = 'id,username,name,access_token,picture.type(large)';
    let foundWithoutToken = false;

    const searchPaginated = async (startUrl: string) => {
      let url: string | undefined = startUrl;
      while (url) {
        const response = await (await fetch(url)).json();
        if (response.data) {
          const page = response.data.find(
            (p: any) => String(p.id) === String(pageId)
          );
          // A page listed through a business the user has no role on comes
          // back without a page token, keep looking for a listing that has one
          if (page && !page.access_token) {
            foundWithoutToken = true;
          } else if (page) {
            return {
              id: page.id,
              name: page.name,
              access_token: page.access_token,
              picture: page.picture?.data?.url || '',
              username: page.username,
            };
          }
        }
        url = response.paging?.next;
      }
      return null;
    };

    // 1. Check /me/accounts
    const fromAccounts = await searchPaginated(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/accounts?fields=${fields}&limit=100&access_token=${accessToken}`
    );
    if (fromAccounts) return fromAccounts;

    // 2. Check Business Manager owned_pages and client_pages
    try {
      let bizUrl:
        | string
        | undefined = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/businesses?access_token=${accessToken}`;

      while (bizUrl) {
        const bizResponse = await (await fetch(bizUrl)).json();
        if (bizResponse.data) {
          for (const business of bizResponse.data) {
            try {
              const fromOwned = await searchPaginated(
                `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${business.id}/owned_pages?fields=${fields}&limit=100&access_token=${accessToken}`
              );
              if (fromOwned) return fromOwned;
            } catch {
              // Continue with other businesses
            }

            try {
              const fromClient = await searchPaginated(
                `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${business.id}/client_pages?fields=${fields}&limit=100&access_token=${accessToken}`
              );
              if (fromClient) return fromClient;
            } catch {
              // Continue with other businesses
            }
          }
        }
        bizUrl = bizResponse.paging?.next;
      }
    } catch {
      // Business Manager API not available for all users
    }

    if (foundWithoutToken) {
      throw new Error(
        'Your Facebook user has no permission to manage this page. Ask a page admin for full content access, then reconnect the channel'
      );
    }

    throw new Error('Page not found in your accounts');
  }

  // Single, read-only status check of a story video - the polling loop that
  // used to live inside post() is now driven by the post workflow.
  private async fbVideoStatus(videoId: string, accessToken: string) {
    const { status } = await (
      await this.fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${videoId}?fields=status&access_token=${accessToken}`,
        undefined,
        '',
        0,
        true
      )
    ).json();

    const videoStatus = status?.video_status || 'in_progress';

    if (videoStatus === 'error') {
      throw new BadBody(
        this.identifier,
        JSON.stringify({ status }),
        '{}',
        'Video processing failed'
      );
    }

    return videoStatus === 'upload_complete' || videoStatus === 'ready';
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const isStory = firstPost?.settings?.post_type === 'story';

    if (isStory) {
      // Only upload the media here - uploads are invisible until the
      // publish calls, which run one at a time in finalizePost so a failure
      // can never re-publish the stories that already went out.
      const items = [];
      for (const media of firstPost?.media || []) {
        if (hasExtension(media.path, 'mp4')) {
          const { video_id, upload_url } = await (
            await this.fetch(
              `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/video_stories?upload_phase=start&access_token=${accessToken}`,
              {
                method: 'POST',
              },
              'start video story upload'
            )
          ).json();

          await this.fetch(
            upload_url,
            {
              method: 'POST',
              headers: {
                Authorization: `OAuth ${accessToken}`,
                file_url: media.path,
              },
            },
            'upload video story'
          );

          items.push({ kind: 'video', mediaId: video_id });
        } else {
          const { id: photoId } = await (
            await this.fetch(
              `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/photos?access_token=${accessToken}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  url: media.path,
                  published: false,
                }),
              },
              'upload photo story'
            )
          ).json();

          items.push({ kind: 'photo', mediaId: photoId });
        }
      }

      return [
        {
          id: firstPost.id,
          postId: '',
          releaseURL: '',
          status: 'pending',
          pendingData: {
            postType: 'story',
            items,
            publishedCount: 0,
            lastPostId: '',
          },
        },
      ];
    }

    return this.postNonStory(id, accessToken, postDetails);
  }

  override async checkPostStatus(
    accessToken: string,
    pendingData: {
      postType: 'story';
      items: { kind: 'video' | 'photo'; mediaId: string }[];
      publishedCount: number;
      lastPostId: string;
      attempting?: number | null;
      confirmed?: boolean;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    // A confirmed publish attempt died without reporting its result: Facebook
    // has no API to ask whether a story was published, so never publish that
    // item again - stop with an explicit warning instead.
    if (pendingData.attempting != null && pendingData.confirmed) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Facebook may have already published part of the story, please check your page before posting again to avoid duplicates'
      );
    }

    // wait for every not-yet-published video to finish processing, photos are
    // ready as soon as they are uploaded
    for (const item of pendingData.items.slice(pendingData.publishedCount)) {
      if (item.kind !== 'video') {
        continue;
      }

      if (!(await this.fbVideoStatus(item.mediaId, accessToken))) {
        return { status: 'pending', pendingData };
      }
    }

    // witness the armed publish so finalizePost knows the attempt is uniquely
    // accounted for before it mutates anything
    if (pendingData.attempting != null && !pendingData.confirmed) {
      return {
        status: 'ready',
        pendingData: { ...pendingData, confirmed: true },
      };
    }

    return { status: 'ready', pendingData };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: {
      postType: 'story';
      items: { kind: 'video' | 'photo'; mediaId: string }[];
      publishedCount: number;
      lastPostId: string;
      attempting?: number | null;
      confirmed?: boolean;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    // Publish exactly one story per call, with an arm -> confirm -> publish
    // handshake: the publish only runs after checkPostStatus witnessed the
    // intent, so a run that dies mid-publish is detectable and the item is
    // never published twice.
    if (pendingData.attempting == null || !pendingData.confirmed) {
      return {
        status: 'pending',
        pendingData: {
          ...pendingData,
          attempting: pendingData.publishedCount,
          confirmed: false,
        },
      };
    }

    const item = pendingData.items[pendingData.publishedCount];

    const { post_id: storyPostId } = await (
      await this.fetch(
        item.kind === 'video'
          ? `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${integration.internalId}/video_stories?upload_phase=finish&video_id=${item.mediaId}&access_token=${accessToken}`
          : `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${integration.internalId}/photo_stories?photo_id=${item.mediaId}&access_token=${accessToken}`,
        {
          method: 'POST',
        },
        item.kind === 'video'
          ? 'finish video story upload'
          : 'publish photo story'
      )
    ).json();

    const publishedCount = pendingData.publishedCount + 1;

    if (publishedCount < pendingData.items.length) {
      return {
        status: 'pending',
        pendingData: {
          ...pendingData,
          publishedCount,
          lastPostId: storyPostId,
          attempting: null,
          confirmed: false,
        },
      };
    }

    return {
      status: 'completed',
      postId: storyPostId,
      releaseURL: `https://www.facebook.com/stories/${storyPostId}`,
    };
  }

  // Old blocking behavior, kept for workflow versions before v1.0.6 that don't
  // know how to resolve a `pending` response.
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const [response] = await this.postPending(
      id,
      accessToken,
      postDetails,
      integration
    );

    if (response.status !== 'pending') {
      return [response];
    }

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
          'Video processing timed out'
        );
      }

      const check = await this.checkPostStatus(
        accessToken,
        pendingData,
        integration
      );

      if (check.status === 'pending') {
        pendingData = check.pendingData;
        await timer(10000);
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
            releaseURL: result.releaseURL,
            status: 'success',
          },
        ];
      }

      pendingData = result.pendingData;
    }
  }

  private async postNonStory(
    id: string,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[]
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;

    let finalId = '';
    let finalUrl = '';
    if (hasExtension(firstPost?.media?.[0]?.path, 'mp4')) {
      const {
        id: videoId,
        permalink_url,
        ...all
      } = await (
        await this.fetch(
          `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/videos?access_token=${accessToken}&fields=id,permalink_url`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              file_url: firstPost?.media?.[0]?.path!,
              description: firstPost.message,
              ...(firstPost?.settings?.title
                ? { title: firstPost.settings.title }
                : {}),
              published: true,
            }),
          },
          'upload mp4'
        )
      ).json();

      finalUrl = 'https://www.facebook.com/reel/' + videoId;
      finalId = videoId;
    } else {
      const uploadPhotos = !firstPost?.media?.length
        ? []
        : await Promise.all(
            firstPost.media.map(async (media) => {
              const { id: photoId } = await (
                await this.fetch(
                  `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/photos?access_token=${accessToken}`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      url: media.path,
                      published: false,
                    }),
                  },
                  'upload images slides'
                )
              ).json();

              return { media_fbid: photoId };
            })
          );

      // Background presets are only valid on text-only posts (no media) and
      // Facebook caps them at ~130 chars, so we only attach the preset when it
      // can apply.
      const presetId =
        !uploadPhotos?.length &&
        firstPost?.settings?.text_format_preset_id &&
        (firstPost.message?.length || 0) <= FACEBOOK_PRESET_MAX_CHARS
          ? firstPost.settings.text_format_preset_id
          : undefined;

      const publishFeed = async (withPreset: boolean) =>
        (
          await this.fetch(
            `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/feed?access_token=${accessToken}&fields=id,permalink_url`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                ...(uploadPhotos?.length
                  ? { attached_media: uploadPhotos }
                  : {}),
                ...(firstPost?.settings?.url
                  ? { link: firstPost.settings.url }
                  : {}),
                ...(withPreset && presetId
                  ? { text_format_preset_id: presetId }
                  : {}),
                message: firstPost.message,
                published: true,
              }),
            },
            'finalize upload'
          )
        ).json();

      // Facebook exposes no official preset list and adds/retires backgrounds
      // over time, so a stale text_format_preset_id can make FB reject the whole
      // post. Observed Graph API responses for a bad preset:
      //   - malformed id  -> HTTP 400, code 100, message names
      //                      "text_format_preset_id" explicitly
      //   - retired numeric id -> HTTP 500, code 1, generic "unknown error"
      //     (our fetch() retries 500s and then reports it with the body stripped)
      // So retry once without the preset on an explicit preset error or a
      // generic/unknown failure, but never on a recognized auth/token error
      // (dropping the background can't fix that). A retry that only succeeds once
      // the preset is removed confirms the preset was the cause.
      const isPresetRejection = (err: any): boolean => {
        const detail = `${err?.details?.[0]?.json ?? ''} ${err?.message ?? ''}`;
        if (
          /access token|re-authenticate|revoked|"code":\s*190\b/i.test(detail)
        ) {
          return false;
        }
        return (
          /text_format_preset_id/i.test(detail) ||
          /"code":\s*1\b/.test(detail) ||
          String(err?.message) === 'Unknown Error'
        );
      };

      let feedResult: any;
      try {
        feedResult = await publishFeed(!!presetId);
      } catch (err) {
        if (!presetId || !isPresetRejection(err)) {
          throw err;
        }
        // Surface the (recovered) rejection in the logs, since the fallback
        // below makes the activity succeed and Facebook's error would otherwise
        // be swallowed silently.
        console.warn(
          'Facebook rejected text_format_preset_id — dropping the background and publishing as plain text',
          {
            preset: presetId,
            facebook: (err as any)?.details?.[0]?.json,
            message: (err as any)?.message,
          }
        );
        feedResult = await publishFeed(false);
      }

      const { id: postId, permalink_url, ...all } = feedResult;

      finalUrl = permalink_url;
      finalId = postId;
    }

    return [
      {
        id: firstPost.id,
        postId: finalId,
        releaseURL: finalUrl,
        status: 'success',
      },
    ];
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [commentPost] = postDetails;
    const replyToId = lastCommentId || postId;

    const data = await (
      await this.fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${replyToId}/comments?access_token=${accessToken}&fields=id,permalink_url`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...(commentPost.media?.length
              ? { attachment_url: commentPost.media[0].path }
              : {}),
            message: commentPost.message,
          }),
        },
        'add comment'
      )
    ).json();

    return [
      {
        id: commentPost.id,
        postId: data.id,
        releaseURL: data.permalink_url,
        status: 'success',
      },
    ];
  }

  private async fetchFbJson(url: string): Promise<any> {
    const res = await fetch(url);
    const json = await res.json();
    if (json?.error) {
      if (json.error.code === 190) {
        throw new RefreshToken(this.identifier, JSON.stringify(json), '{}');
      }
      throw new Error(json.error.message || 'Facebook Graph API error');
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

    const sumValue = (value: any): number => {
      if (value && typeof value === 'object') {
        return Object.values(value as Record<string, number>).reduce(
          (sum: number, v: number) => sum + (Number(v) || 0),
          0
        );
      }
      return Number(value) || 0;
    };

    // 1. Page overview snapshot (followers_count, fan_count)
    const pageInfo = await safeAnalyticsCall(
      'fb.page.info',
      () =>
        this.fetchFbJson(
          `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}?fields=followers_count,fan_count&access_token=${accessToken}`
        ),
      null
    );

    if (pageInfo?.followers_count !== undefined) {
      result.push({
        label: 'Followers',
        percentageChange: 0,
        aggregation: 'latest',
        unit: 'number',
        category: 'overview',
        data: [{ total: String(pageInfo.followers_count), date: today }],
      });
    }
    if (pageInfo?.fan_count !== undefined) {
      result.push({
        label: 'Page Likes',
        percentageChange: 0,
        aggregation: 'latest',
        unit: 'number',
        category: 'overview',
        data: [{ total: String(pageInfo.fan_count), date: today }],
      });
    }

    // 2. Core Media Views & Engagement metrics (chunked <= 28d)
    const coreMetricNames =
      'page_total_media_view_unique,page_media_view,page_post_engagements,page_daily_follows';

    const fetchCoreSeries = async (winList = windows) => {
      const seriesMap: Record<
        string,
        Array<{ date: string; total: number }>
      > = {};
      const mediaSourceBreakdown: Record<string, number> = {};

      for (const w of winList) {
        const res = await this.fetchFbJson(
          `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/insights?metric=${coreMetricNames}&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
        );
        for (const d of res?.data || []) {
          seriesMap[d.name] = seriesMap[d.name] || [];
          for (const v of d.values || []) {
            seriesMap[d.name].push({
              date: dayjs(v.end_time).format('YYYY-MM-DD'),
              total: sumValue(v.value),
            });
            if (
              d.name === 'page_media_view' &&
              v.value &&
              typeof v.value === 'object'
            ) {
              for (const [k, val] of Object.entries(
                v.value as Record<string, number>
              )) {
                mediaSourceBreakdown[k] =
                  (mediaSourceBreakdown[k] || 0) + (Number(val) || 0);
              }
            }
          }
        }
      }
      return { seriesMap, mediaSourceBreakdown };
    };

    // Throw on core error so checkAnalytics doesn't cache an empty result on fatal Page error
    const currentCore = await fetchCoreSeries(windows);
    const prevCore =
      prevWindows.length > 0
        ? await safeAnalyticsCall(
            'fb.core.prev',
            () => fetchCoreSeries(prevWindows),
            {
              seriesMap: {} as Record<
                string,
                Array<{ date: string; total: number }>
              >,
              mediaSourceBreakdown: {} as Record<string, number>,
            }
          )
        : {
            seriesMap: {} as Record<
              string,
              Array<{ date: string; total: number }>
            >,
            mediaSourceBreakdown: {} as Record<string, number>,
          };

    const labelForCore = (name: string) =>
      name === 'page_total_media_view_unique'
        ? 'Page Impressions'
        : name === 'page_post_engagements'
        ? 'Posts Engagement'
        : name === 'page_daily_follows'
        ? 'Page followers'
        : 'Media views';

    const coreSums: Record<string, number> = {};
    const prevCoreSums: Record<string, number> = {};

    for (const name of [
      'page_total_media_view_unique',
      'page_media_view',
      'page_post_engagements',
      'page_daily_follows',
    ]) {
      const pts = mergeDailyPoints(currentCore.seriesMap[name] || []);
      if (pts.length === 0) continue;
      const curSum = aggregatePoints(pts, 'sum');
      coreSums[name] = curSum;
      const prevPts = mergeDailyPoints(prevCore.seriesMap[name] || []);
      const prevSum =
        prevPts.length > 0 ? aggregatePoints(prevPts, 'sum') : undefined;
      if (prevSum !== undefined) prevCoreSums[name] = prevSum;

      result.push({
        label: labelForCore(name),
        percentageChange:
          prevSum !== undefined
            ? computePercentageChange(curSum, prevSum)
            : computeSeriesTrend(pts, 'sum'),
        aggregation: 'sum',
        unit: 'number',
        category:
          name === 'page_post_engagements' ? 'engagement' : 'overview',
        data: pts,
      });
    }

    // 3. Extended Page metrics (page_views_total, page_daily_unfollows_unique, page_actions_post_reactions_total)
    const [pageViewsPts, unfollowsPts, reactionsData] = await Promise.all([
      safeAnalyticsCall(
        'fb.page_views_total',
        async () => {
          const raw: Array<{ date: string; total: number }> = [];
          for (const w of windows) {
            const res = await this.fetchFbJson(
              `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/insights?metric=page_views_total&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
            );
            for (const v of res?.data?.[0]?.values || []) {
              raw.push({
                date: dayjs(v.end_time).format('YYYY-MM-DD'),
                total: sumValue(v.value),
              });
            }
          }
          return mergeDailyPoints(raw);
        },
        []
      ),
      safeAnalyticsCall(
        'fb.page_daily_unfollows_unique',
        async () => {
          const raw: Array<{ date: string; total: number }> = [];
          for (const w of windows) {
            const res = await this.fetchFbJson(
              `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/insights?metric=page_daily_unfollows_unique&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
            );
            for (const v of res?.data?.[0]?.values || []) {
              raw.push({
                date: dayjs(v.end_time).format('YYYY-MM-DD'),
                total: sumValue(v.value),
              });
            }
          }
          return mergeDailyPoints(raw);
        },
        []
      ),
      safeAnalyticsCall(
        'fb.reactions_total',
        async () => {
          const raw: Array<{ date: string; total: number }> = [];
          const byType: Record<string, number> = {};
          for (const w of windows) {
            const res = await this.fetchFbJson(
              `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/insights?metric=page_actions_post_reactions_total&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
            );
            for (const v of res?.data?.[0]?.values || []) {
              raw.push({
                date: dayjs(v.end_time).format('YYYY-MM-DD'),
                total: sumValue(v.value),
              });
              if (v.value && typeof v.value === 'object') {
                for (const [k, count] of Object.entries(
                  v.value as Record<string, number>
                )) {
                  byType[k] = (byType[k] || 0) + (Number(count) || 0);
                }
              }
            }
          }
          return { points: mergeDailyPoints(raw), byType };
        },
        { points: [], byType: {} as Record<string, number> }
      ),
    ]);

    if (pageViewsPts.length > 0) {
      result.push({
        label: 'Page Views',
        percentageChange: computeSeriesTrend(pageViewsPts, 'sum'),
        aggregation: 'sum',
        unit: 'number',
        category: 'traffic',
        data: pageViewsPts,
      });
    }

    if (unfollowsPts.length > 0) {
      result.push({
        label: 'Page Unfollows',
        percentageChange: computeSeriesTrend(unfollowsPts, 'sum'),
        aggregation: 'sum',
        unit: 'number',
        category: 'overview',
        data: unfollowsPts,
      });
    }

    if (reactionsData.points.length > 0) {
      result.push({
        label: 'Post Reactions',
        percentageChange: computeSeriesTrend(reactionsData.points, 'sum'),
        aggregation: 'sum',
        unit: 'number',
        category: 'engagement',
        data: reactionsData.points,
      });
    }

    // Derived Engagement Rate
    const impSum =
      coreSums.page_total_media_view_unique || coreSums.page_media_view || 0;
    const engSum = coreSums.page_post_engagements || 0;
    if (impSum > 0 && engSum >= 0) {
      const rate = Number(((engSum / impSum) * 100).toFixed(2));
      const prevImp =
        prevCoreSums.page_total_media_view_unique ||
        prevCoreSums.page_media_view ||
        0;
      const prevEng = prevCoreSums.page_post_engagements || 0;
      const prevRate = prevImp > 0 ? (prevEng / prevImp) * 100 : undefined;
      result.push({
        label: 'Engagement Rate',
        average: true,
        unit: 'percent',
        aggregation: 'latest',
        category: 'engagement',
        percentageChange: computePercentageChange(rate, prevRate, true),
        data: [{ total: String(rate), date: today }],
      });
    }

    // Breakdowns: Organic vs Paid media views & Reactions by Type
    const mediaSourceBd = buildBreakdown(currentCore.mediaSourceBreakdown, 6);
    if (mediaSourceBd.length > 0) {
      const sum = mediaSourceBd.reduce((a, b) => a + b.value, 0);
      result.push({
        label: 'Media Views by Source',
        percentageChange: 0,
        category: 'traffic',
        breakdown: mediaSourceBd,
        data: [{ total: String(sum), date: today }],
      });
    }

    const reactionsBd = buildBreakdown(reactionsData.byType, 8);
    if (reactionsBd.length > 0) {
      const sum = reactionsBd.reduce((a, b) => a + b.value, 0);
      result.push({
        label: 'Reactions by Type',
        percentageChange: 0,
        category: 'engagement',
        breakdown: reactionsBd,
        data: [{ total: String(sum), date: today }],
      });
    }

    // 4. Recent Published Posts Leaderboard
    const recentPosts = await safeAnalyticsCall<AnalyticsPostItem[]>(
      'fb.recent_posts',
      async () => {
        const feedRes = await this.fetchFbJson(
          `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${id}/published_posts?fields=id,message,permalink_url,full_picture,created_time,shares&limit=10&access_token=${accessToken}`
        );
        const posts: any[] = feedRes?.data || [];
        return Promise.all(
          posts.map(async (p) => {
            const [insRes, countsRes] = await Promise.all([
              safeAnalyticsCall(
                `fb.post.ins.${p.id}`,
                () =>
                  this.fetchFbJson(
                    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${p.id}/insights?metric=post_total_media_view_unique,post_clicks,post_reactions_by_type_total&access_token=${accessToken}`
                  ),
                null
              ),
              safeAnalyticsCall(
                `fb.post.counts.${p.id}`,
                () =>
                  this.fetchFbJson(
                    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${p.id}?fields=comments.summary(true).limit(0)&access_token=${accessToken}`
                  ),
                null
              ),
            ]);

            let reach: number | undefined;
            let clicks = 0;
            let likes: number | undefined;
            for (const m of insRes?.data || []) {
              const v = m?.values?.[0]?.value;
              if (v === undefined) continue;
              if (m.name === 'post_total_media_view_unique') {
                reach = Number(v) || 0;
              } else if (m.name === 'post_clicks') {
                clicks = Number(v) || 0;
              } else if (m.name === 'post_reactions_by_type_total') {
                likes = sumValue(v);
              }
            }
            const comments =
              countsRes?.comments?.summary?.total_count !== undefined
                ? Number(countsRes.comments.summary.total_count) || 0
                : undefined;
            const shares =
              p?.shares?.count !== undefined
                ? Number(p.shares.count) || 0
                : undefined;
            const interactions =
              (likes || 0) + (comments || 0) + (shares || 0) + clicks;

            return {
              id: String(p.id),
              title: summarizePostTitle(p.message, 'Facebook Post'),
              url: p.permalink_url,
              thumbnail: p.full_picture,
              publishedAt: p.created_time
                ? dayjs(p.created_time).format('YYYY-MM-DD HH:mm')
                : today,
              reach,
              views: reach,
              likes,
              comments,
              shares,
              engagementRate:
                reach && reach > 0
                  ? Number(((interactions / reach) * 100).toFixed(2))
                  : undefined,
            } as AnalyticsPostItem;
          })
        );
      },
      []
    );

    if (recentPosts.length > 0) {
      result.push({
        label: 'Recent Posts Performance',
        percentageChange: 0,
        category: 'posts',
        posts: recentPosts,
        data: [{ total: String(recentPosts.length), date: today }],
      });
    }

    return result;
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');

    // Feed post -> `{pageid}_{postid}`; reel/video -> bare numeric video id
    if (!postId.includes('_')) {
      return this.videoPostAnalytics(accessToken, postId, today);
    }

    try {
      const [insightsRes, nodeRes] = await Promise.all([
        this.fetchFbJson(
          `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${postId}/insights?metric=post_total_media_view_unique,post_reactions_by_type_total,post_clicks,post_clicks_by_type&access_token=${accessToken}`
        ),
        safeAnalyticsCall(
          'fb.post.node',
          () =>
            this.fetchFbJson(
              `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${postId}?fields=shares,comments.summary(true).limit(0)&access_token=${accessToken}`
            ),
          null
        ),
      ]);

      const data = insightsRes?.data || [];
      const result: AnalyticsData[] = [];
      let impressions = 0;
      let reactions = 0;
      let clicks = 0;

      for (const metric of data) {
        const value = metric.values?.[0]?.value;
        if (value === undefined) continue;

        if (metric.name === 'post_total_media_view_unique') {
          impressions = Number(value) || 0;
          result.push({
            label: 'Impressions',
            percentageChange: 0,
            unit: 'number',
            aggregation: 'latest',
            category: 'overview',
            data: [{ total: String(impressions), date: today }],
          });
        } else if (metric.name === 'post_clicks') {
          clicks = Number(value) || 0;
          result.push({
            label: 'Clicks',
            percentageChange: 0,
            unit: 'number',
            aggregation: 'latest',
            category: 'traffic',
            data: [{ total: String(clicks), date: today }],
          });
        } else if (
          metric.name === 'post_clicks_by_type' &&
          typeof value === 'object'
        ) {
          const bd = buildBreakdown(value as Record<string, number>, 10);
          const totalClicks = Object.values(
            value as Record<string, number>
          ).reduce((sum: number, v: number) => sum + (Number(v) || 0), 0);
          result.push({
            label: 'Clicks by Type',
            percentageChange: 0,
            unit: 'number',
            aggregation: 'latest',
            category: 'traffic',
            breakdown: bd,
            data: [{ total: String(totalClicks), date: today }],
          });
        } else if (
          metric.name === 'post_reactions_by_type_total' &&
          typeof value === 'object'
        ) {
          const bd = buildBreakdown(value as Record<string, number>, 10);
          reactions = Object.values(value as Record<string, number>).reduce(
            (sum: number, v: number) => sum + (Number(v) || 0),
            0
          );
          result.push({
            label: 'Reactions',
            percentageChange: 0,
            unit: 'number',
            aggregation: 'latest',
            category: 'engagement',
            breakdown: bd,
            data: [{ total: String(reactions), date: today }],
          });
        }
      }

      const commentsCount = nodeRes?.comments?.summary?.total_count;
      const sharesCount = nodeRes?.shares?.count;

      if (commentsCount !== undefined) {
        result.push({
          label: 'Comments',
          percentageChange: 0,
          unit: 'number',
          aggregation: 'latest',
          category: 'engagement',
          data: [{ total: String(Number(commentsCount) || 0), date: today }],
        });
      }

      if (sharesCount !== undefined) {
        result.push({
          label: 'Shares',
          percentageChange: 0,
          unit: 'number',
          aggregation: 'latest',
          category: 'engagement',
          data: [{ total: String(Number(sharesCount) || 0), date: today }],
        });
      }

      const totalEng =
        reactions +
        clicks +
        (Number(commentsCount) || 0) +
        (Number(sharesCount) || 0);
      if (impressions > 0 && totalEng >= 0) {
        result.push({
          label: 'Engagement Rate',
          percentageChange: 0,
          average: true,
          unit: 'percent',
          aggregation: 'latest',
          category: 'engagement',
          data: [
            {
              total: String(Number(((totalEng / impressions) * 100).toFixed(2))),
              date: today,
            },
          ],
        });
      }

      return result;
    } catch (err) {
      if (err instanceof RefreshToken || err instanceof Disconnect) {
        throw err;
      }
      console.error('Error fetching Facebook post analytics:', err);
      return [];
    }
  }

  private async videoPostAnalytics(
    accessToken: string,
    videoId: string,
    today: string
  ): Promise<AnalyticsData[]> {
    try {
      const [coreVideoRes, retentionRes] = await Promise.all([
        fetch(
          `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${videoId}/video_insights?metric=total_video_views,total_video_reactions_by_type_total,fb_reels_total_plays,post_video_likes_by_reaction_type,post_video_social_actions&access_token=${accessToken}`
        ).then((r) => r.json()),
        safeAnalyticsCall(
          'fb.video.retention',
          async () => {
            const r = await fetch(
              `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${videoId}/video_insights?metric=total_video_avg_time_watched,total_video_view_total_time,fb_reels_avg_watch_time&access_token=${accessToken}`
            );
            return r.json();
          },
          null
        ),
      ]);

      const { data, error } = coreVideoRes || {};
      if (error) {
        if (error.code === 190) {
          throw new RefreshToken(
            this.identifier,
            JSON.stringify(coreVideoRes),
            '{}'
          );
        }
        if (!/nonexisting field/i.test(error.message || '')) {
          console.warn('Facebook video_insights returned an error:', {
            videoId,
            error,
          });
        }
        return [];
      }

      const allMetrics = [
        ...(data || []),
        ...(retentionRes?.error ? [] : retentionRes?.data || []),
      ];
      if (allMetrics.length === 0) {
        return [];
      }

      const result: AnalyticsData[] = [];
      let playsOrViews = 0;
      let totalReactions = 0;
      let totalActions = 0;

      for (const metric of allMetrics) {
        const value = metric.values?.[0]?.value;
        if (value === undefined) continue;

        switch (metric.name) {
          case 'total_video_views':
            playsOrViews = playsOrViews || Number(value) || 0;
            result.push({
              label: 'Views',
              percentageChange: 0,
              unit: 'number',
              aggregation: 'latest',
              category: 'overview',
              data: [{ total: String(value), date: today }],
            });
            break;
          case 'fb_reels_total_plays':
            playsOrViews = Number(value) || playsOrViews;
            result.push({
              label: 'Plays',
              percentageChange: 0,
              unit: 'number',
              aggregation: 'latest',
              category: 'overview',
              data: [{ total: String(value), date: today }],
            });
            break;
          case 'total_video_reactions_by_type_total':
          case 'post_video_likes_by_reaction_type':
            if (typeof value === 'object' && !result.some((r) => r.label === 'Reactions')) {
              const bd = buildBreakdown(value as Record<string, number>, 10);
              totalReactions = Object.values(
                value as Record<string, number>
              ).reduce((sum: number, v: number) => sum + (Number(v) || 0), 0);
              result.push({
                label: 'Reactions',
                percentageChange: 0,
                unit: 'number',
                aggregation: 'latest',
                category: 'engagement',
                breakdown: bd,
                data: [{ total: String(totalReactions), date: today }],
              });
            }
            break;
          case 'post_video_social_actions':
            if (typeof value === 'object') {
              const bd = buildBreakdown(value as Record<string, number>, 10);
              totalActions = Object.values(
                value as Record<string, number>
              ).reduce((sum: number, v: number) => sum + (Number(v) || 0), 0);
              result.push({
                label: 'Engagement',
                percentageChange: 0,
                unit: 'number',
                aggregation: 'latest',
                category: 'engagement',
                breakdown: bd,
                data: [{ total: String(totalActions), date: today }],
              });
              const obj = value as Record<string, number>;
              if (obj.COMMENT !== undefined || obj.comment !== undefined) {
                result.push({
                  label: 'Comments',
                  percentageChange: 0,
                  unit: 'number',
                  aggregation: 'latest',
                  category: 'engagement',
                  data: [
                    {
                      total: String(Number(obj.COMMENT ?? obj.comment) || 0),
                      date: today,
                    },
                  ],
                });
              }
              if (obj.SHARE !== undefined || obj.share !== undefined) {
                result.push({
                  label: 'Shares',
                  percentageChange: 0,
                  unit: 'number',
                  aggregation: 'latest',
                  category: 'engagement',
                  data: [
                    {
                      total: String(Number(obj.SHARE ?? obj.share) || 0),
                      date: today,
                    },
                  ],
                });
              }
            }
            break;
          case 'total_video_avg_time_watched':
          case 'fb_reels_avg_watch_time':
            if (
              typeof value === 'number' &&
              value > 0 &&
              !result.some((r) => r.label === 'Average Watch Time')
            ) {
              result.push({
                label: 'Average Watch Time',
                percentageChange: 0,
                unit: 'seconds',
                aggregation: 'latest',
                category: 'retention',
                data: [
                  {
                    total: String(Number((value / 1000).toFixed(2))),
                    date: today,
                  },
                ],
              });
            }
            break;
          case 'total_video_view_total_time':
            if (typeof value === 'number' && value > 0) {
              result.push({
                label: 'Total Watch Time',
                percentageChange: 0,
                unit: 'minutes',
                aggregation: 'latest',
                category: 'retention',
                data: [
                  {
                    total: String(Number((value / 60000).toFixed(2))),
                    date: today,
                  },
                ],
              });
            }
            break;
        }
      }

      if (playsOrViews > 0 && (totalReactions > 0 || totalActions > 0)) {
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
                Number(
                  (((totalReactions + totalActions) / playsOrViews) * 100).toFixed(
                    2
                  )
                )
              ),
              date: today,
            },
          ],
        });
      }

      return result;
    } catch (err) {
      if (err instanceof RefreshToken || err instanceof Disconnect) {
        throw err;
      }
      console.error('Error fetching Facebook video post analytics:', err);
      return [];
    }
  }
}
