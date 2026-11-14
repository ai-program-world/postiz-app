import {
  AnalyticsData,
  AnalyticsPostItem,
  AnalyticsSnapshotData,
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
  StoryInsightData,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { timer } from '@gitroom/helpers/utils/timer';
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
import { InstagramDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/instagram.dto';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';
import { DashboardFunction } from '@gitroom/nestjs-libraries/integrations/dashboard.function.decorator';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';

@Rules(
  "Instagram should have at least one attachment, if it's a story, it can have only one picture"
)
export class InstagramProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'instagram';
  name = 'Instagram\n(Facebook Business)';
  isBetweenSteps = true;
  toolTip = 'Instagram must be business and connected to a Facebook page';
  scopes = [
    'instagram_basic',
    'pages_show_list',
    'pages_read_engagement',
    'business_management',
    'instagram_content_publish',
    'instagram_manage_comments',
    'instagram_manage_insights',
  ];
  override maxConcurrentJob = 400;
  editor = 'normal' as const;
  dto = InstagramDto;
  maxLength() {
    return 2200;
  }

  override async checkValidity(
    [firstPost]: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    if (!firstPost?.length) {
      return 'Should have at least one media';
    }
    if (firstPost.length > 20) {
      return 'Instagram carousel only supports up to 20 media attachments';
    }
    if (this.assetBoolean(settings?.is_trial_reel)) {
      if ((firstPost?.length ?? 0) > 1) {
        return 'Trial Reels can only have one video';
      }
      const hasVideo = firstPost?.some(
        (f) => (f?.path?.indexOf?.('mp4') ?? -1) > -1
      );
      if (!hasVideo) {
        return 'Trial Reels must be a video';
      }
    }
    if (firstPost?.some((f) => (f?.alt?.length ?? 0) > 1000)) {
      return 'Instagram alt text can be up to 1000 characters';
    }
    if (settings?.audio?.id) {
      if (settings?.post_type === 'story') {
        return 'Audio can only be added to Reels, not to Stories';
      }
      if ((firstPost?.length ?? 0) > 1) {
        return 'Audio can only be added to a single video Reel';
      }
      const hasVideo = firstPost?.some(
        (f) => (f?.path?.indexOf?.('mp4') ?? -1) > -1
      );
      if (!hasVideo) {
        return 'Audio can only be added to a video Reel';
      }
    }
    return true;
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

  public override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
        value: string;
      }
    | undefined {
    if (body.indexOf('An unknown error occurred') > -1) {
      return {
        type: 'retry' as const,
        value: 'An unknown error occurred, please try again later',
      };
    }
    if (body.indexOf('2207081') > -1) {
      return {
        type: 'bad-body' as const,
        value: "This account doesn't support Trial Reels",
      };
    }
    if (body.indexOf('2207078') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Instagram Trial Reel publish limit reached for this account, please try again later or publish the post as a regular Reel',
      };
    }

    if (
      body.indexOf('REVOKED_ACCESS_TOKEN') > -1 ||
      body.indexOf('"error_subcode":33') > -1
    ) {
      return {
        type: 'refresh-token' as const,
        value:
          'Something is wrong with your connected user, please re-authenticate',
      };
    }

    if (
      body.toLowerCase().indexOf('the user is not an instagram business') > -1
    ) {
      return {
        type: 'refresh-token' as const,
        value:
          'Your Instagram account is not a business account, please convert it to a business account',
      };
    }

    if (body.toLowerCase().indexOf('session has been invalidated') > -1) {
      return {
        type: 'refresh-token' as const,
        value:
          'You session has been invalidated, this can usually happen from frequent posting, please re-authenticate, and wait 1-2 days before posting again',
      };
    }

    if (body.indexOf('2207050') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Instagram user is restricted',
      };
    }

    // Media download/upload errors
    if (body.indexOf('2207003') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Timeout downloading media, please try again',
      };
    }

    if (body.indexOf('2207020') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Media expired, please upload again',
      };
    }

    if (body.indexOf('2207032') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Failed to create media, please try again',
      };
    }

    if (body.indexOf('2207053') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          "Instagram failed to upload the video. If it exceeds Instagram's limits (300MB, 1920px width, 25Mbps bitrate), export a smaller version and try again",
      };
    }

    if (body.indexOf('2207052') > -1) {
      return {
        type: 'retry' as const,
        value: 'Media fetch failed, please try again',
      };
    }

    if (body.indexOf('2207057') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid thumbnail offset for video',
      };
    }

    if (body.indexOf('2207026') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Unsupported video format',
      };
    }

    if (body.indexOf('2207023') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Unknown media type',
      };
    }

    if (body.indexOf('2207006') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Media not found, please upload again',
      };
    }

    if (body.indexOf('2207008') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Media builder expired, please try again',
      };
    }

    // Content validation errors
    if (body.indexOf('2207028') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Carousel validation failed',
      };
    }

    if (body.indexOf('2207010') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Caption is too long',
      };
    }

    // Product tagging errors
    if (body.indexOf('2207035') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Product tag positions not supported for videos',
      };
    }

    if (body.indexOf('2207036') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Product tag positions required for photos',
      };
    }

    if (body.indexOf('2207037') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Product tag validation failed',
      };
    }

    if (body.indexOf('2207040') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Too many product tags',
      };
    }

    // Image format/size errors
    if (body.indexOf('2207004') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Image is too large',
      };
    }

    if (body.indexOf('2207005') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Unsupported image format',
      };
    }

    if (body.indexOf('2207009') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Aspect ratio not supported, must be between 4:5 to 1.91:1',
      };
    }

    if (body.indexOf('Page request limit reached') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Page posting for today is limited, please try again tomorrow',
      };
    }

    if (body.indexOf('2207042') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'You have reached the maximum of 25 posts per day, allowed for your account',
      };
    }

    if (body.indexOf('(#200)') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Facebook rejected the post due to missing permissions. Make sure your Facebook account has full content access to the Page linked to this Instagram account, then reconnect the channel.',
      };
    }

    if (body.indexOf('Not enough permissions to post') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Not enough permissions to post',
      };
    }

    if (body.indexOf('36003') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Aspect ratio not supported, must be between 4:5 to 1.91:1',
      };
    }

    // Meta put the account behind a checkpoint: the token is still valid, so a
    // refresh cannot help and every post fails until the user logs in on
    // Instagram and re-connects the channel.
    if (
      body.indexOf('You cannot access the app till you log in to') > -1 ||
      body.indexOf('Session key is malformed') > -1
    ) {
      return {
        type: 'disconnect' as const,
        value:
          'Instagram requires you to log in at instagram.com and follow its instructions before posting can resume. After that, please reconnect this channel.',
      };
    }

    if (body.indexOf('190,') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'The account is missing some permissions to perform this action, please re-add the account and allow all permissions',
      };
    }

    if (body.indexOf('36001') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid Instagram image resolution max: 1920x1080px',
      };
    }

    if (body.indexOf('2207051') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Instagram blocked your request',
      };
    }

    if (body.indexOf('2207001') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Instagram detected that your post is spam, please try again with different content',
      };
    }

    if (body.indexOf('1772107') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Instagram did not add the comment, the post itself was published. Please try again with different comment text',
      };
    }

    if (body.indexOf('2207082') > -1) {
      return {
        type: 'retry' as const,
        value:
          'Instagram could not process this video. If you attached audio to a video that has no sound track, set the original video volume to 0 and try again',
      };
    }

    if (body.indexOf('2207085') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Instagram could not process the video, please check the video format, duration and resolution and try again',
      };
    }

    if (body.indexOf('2207077') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Instagram Video download failed',
      };
    }

    if (body.indexOf('too little or too many attachments') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Instagram carousel should have between 2 and 20 media attachments',
      }
    }

    if (body.indexOf('2207027') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Unknown error, please try again later or contact support',
      };
    }

    if (body.indexOf('2207018') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          "One of the collaborators could not be tagged, please check the username is correct, the account is public, and that it allows collaborator invites",
      };
    }

    if (body.indexOf('param collaborators is not allowed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Collaborators are not allowed for carousel',
      };
    }

    return undefined;
  }

  async reConnect(
    id: string,
    requiredId: string,
    token: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const [accessToken, userToken] = token.split('___');
    const findPage = (await this.pages(accessToken)).find(
      (p) => p.id === requiredId
    );

    const information = await this.fetchPageInformation(accessToken, {
      id: requiredId,
      pageId: findPage?.pageId!,
    });

    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return {
      url:
        `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth` +
        `?client_id=${process.env.FACEBOOK_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(
          `${process.env.FRONTEND_URL}/integrations/social/instagram`
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
    refresh: string;
  }) {
    const getAccessToken = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token` +
          `?client_id=${process.env.FACEBOOK_APP_ID}` +
          `&redirect_uri=${encodeURIComponent(
            `${process.env.FRONTEND_URL}/integrations/social/instagram${
              params.refresh ? `?refresh=${params.refresh}` : ''
            }`
          )}` +
          `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
          `&code=${params.code}`
      )
    ).json();

    const { access_token, expires_in, ...all } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token` +
          '?grant_type=fb_exchange_token' +
          `&client_id=${process.env.FACEBOOK_APP_ID}` +
          `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
          `&fb_exchange_token=${getAccessToken.access_token}`
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
  async pages(token: string) {
    const [accessToken, userToken] = token.split('___');
    const seenPageIds = new Set<string>();
    const allFacebookPages: any[] = [];

    const fetchPaginated = async (startUrl: string) => {
      let nextUrl: string | undefined = startUrl;
      while (nextUrl) {
        const response = await (await fetch(nextUrl)).json();
        if (response.data) {
          for (const page of response.data) {
            if (!seenPageIds.has(page.id)) {
              seenPageIds.add(page.id);
              allFacebookPages.push(page);
            }
          }
        }
        nextUrl = response.paging?.next;
      }
    };

    // Fetch pages the user explicitly shared during the OAuth dialog
    await fetchPaginated(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/accounts?fields=id,instagram_business_account,username,name,picture.type(large)&limit=100&access_token=${accessToken}`
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
                `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${business.id}/owned_pages?fields=id,instagram_business_account,username,name,picture.type(large)&limit=100&access_token=${accessToken}`
              );
            } catch {
              // Continue with other businesses
            }

            try {
              await fetchPaginated(
                `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${business.id}/client_pages?fields=id,instagram_business_account,username,name,picture.type(large)&limit=100&access_token=${accessToken}`
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

    const onlyConnectedAccounts = await Promise.all(
      allFacebookPages
        .filter((f: any) => f.instagram_business_account)
        .map(async (p: any) => {
          return {
            pageId: p.id,
            ...(await (
              await fetch(
                `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${p.instagram_business_account.id}?fields=name,profile_picture_url&access_token=${accessToken}`
              )
            ).json()),
            id: p.instagram_business_account.id,
          };
        })
    );

    return onlyConnectedAccounts.map((p: any) => ({
      pageId: p.pageId,
      id: p.id,
      name: p.name,
      picture: { data: { url: p.profile_picture_url } },
    }));
  }

  async fetchPageInformation(
    token: string,
    data: { pageId: string; id: string }
  ) {
    const [accessToken, userToken] = token.split('___');
    const { access_token, ...all } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${data.pageId}?fields=access_token,name,picture.type(large)&access_token=${accessToken}`
      )
    ).json();

    const { id, name, profile_picture_url, username } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${data.id}?fields=username,name,profile_picture_url&access_token=${accessToken}`
      )
    ).json();

    return {
      id,
      name,
      picture: profile_picture_url,
      access_token: access_token + '___' + accessToken,
      username,
    };
  }

  // Instagram rejects collaborator handles that carry a leading @ with
  // error_subcode 2207018, and the tag input stores whatever the user typed.
  private stripHandle(handle: string) {
    return handle.replace(/^@+/, '');
  }

  // Single, read-only status check of a media container - the polling loops
  // that used to live inside post() are now driven by the post workflow.
  private async igContainerStatus(
    containerId: string,
    checkToken: string,
    type: string
  ): Promise<string> {
    const { status_code, status } = await (
      await this.fetch(
        `https://${type}/${META_GRAPH_API_VERSION}/${containerId}?access_token=${checkToken}&fields=status_code,status`,
        undefined,
        '',
        0,
        true
      )
    ).json();

    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      const handleError = this.handleErrors(status || '', 200);
      if (handleError?.type === 'disconnect') {
        throw new Disconnect(
          this.identifier,
          JSON.stringify({ status_code, status }),
          '{}',
          handleError?.value
        );
      }
      throw new BadBody(
        this.identifier,
        JSON.stringify({ status_code, status }),
        '{}',
        handleError?.value ||
          (status !== status_code && status) ||
          'Instagram could not process the media'
      );
    }

    return status_code;
  }

  // After a rejected media_publish: the id of the media Instagram created from
  // the container if it reports it as published, '' if it did not publish.
  private async igPublishedMediaId(
    containerId: string,
    igId: string,
    checkToken: string,
    type: string
  ): Promise<string> {
    try {
      const status = await this.igContainerStatus(
        containerId,
        checkToken,
        type
      );
      const { data } =
        status === 'PUBLISHED'
          ? await (
              await this.fetch(
                `https://${type}/${META_GRAPH_API_VERSION}/${igId}/media?fields=id&limit=1&access_token=${checkToken}`,
                undefined,
                '',
                0,
                true
              )
            ).json()
          : { data: [] };
      const mediaId = data?.[0]?.id || '';
      console.log(
        `Instagram blocked media_publish for container ${containerId}: status ${status}, media ${mediaId || 'none'}`
      );
      return mediaId;
    } catch (e) {
      console.error(
        `Instagram blocked media_publish for container ${containerId}: status probe failed`,
        e
      );
      return '';
    }
  }

  // The post is live, the permalink is only cosmetic: never fail (and risk
  // re-publishing) a live post over it.
  private async igPermalink(
    mediaId: string,
    checkToken: string,
    type: string,
    integration: Integration
  ): Promise<string> {
    try {
      const { permalink } = await (
        await this.fetch(
          `https://${type}/${META_GRAPH_API_VERSION}/${mediaId}?fields=permalink&access_token=${checkToken}`
        )
      ).json();
      return permalink;
    } catch (err) {
      return `https://www.instagram.com/${integration.profile}`;
    }
  }

  async postPending(
    id: string,
    token: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration,
    type = 'graph.facebook.com'
  ): Promise<PostResponse[]> {
    const [accessToken] = token.split('___');
    const [firstPost] = postDetails;
    const isStory = firstPost.settings.post_type === 'story';
    const collaborators =
      firstPost?.settings?.collaborators?.length && !isStory
        ? `&collaborators=${encodeURIComponent(
            JSON.stringify(
              firstPost?.settings?.collaborators.map((p) =>
                this.stripHandle(p.label)
              )
            )
          )}`
        : ``;
    const isTrialReel = this.assetBoolean(firstPost.settings.is_trial_reel);
    const medias = await Promise.all(
      firstPost?.media?.map(async (m) => {
        const caption =
          firstPost.media?.length === 1
            ? `&caption=${encodeURIComponent(firstPost.message)}`
            : ``;
        const isCarousel =
          (firstPost?.media?.length || 0) > 1 && !isStory
            ? `&is_carousel_item=true`
            : ``;
        const mediaType = hasExtension(m.path, 'mp4')
          ? firstPost?.media?.length === 1
            ? isStory
              ? `video_url=${m.path}&media_type=STORIES`
              : m?.thumbnail
              ? `video_url=${m.path}&media_type=REELS&cover_url=${encodeURIComponent(
                  m.thumbnail
                )}`
              : `video_url=${m.path}&media_type=REELS&thumb_offset=${
                  m?.thumbnailTimestamp || 0
                }`
            : isStory
            ? `video_url=${m.path}&media_type=STORIES`
            : `video_url=${m.path}&media_type=VIDEO&thumb_offset=${
                m?.thumbnailTimestamp || 0
              }`
          : isStory
          ? `image_url=${m.path}&media_type=STORIES`
          : `image_url=${m.path}`;

        // alt_text is only supported on images (single or carousel item),
        // not on videos or stories
        const altText =
          m.alt && !isStory && !hasExtension(m.path, 'mp4')
            ? `&alt_text=${encodeURIComponent(m.alt)}`
            : ``;

        const trialParams = isTrialReel
          ? `&trial_params=${encodeURIComponent(
              JSON.stringify({
                graduation_strategy:
                  firstPost.settings.graduation_strategy || 'MANUAL',
              })
            )}`
          : ``;

        // collaborators are not allowed on carousel child items,
        // they go on the carousel container instead
        const itemCollaborators =
          firstPost?.media?.length === 1 ? collaborators : ``;

        // share_to_feed is only supported for Reels (single video, not a story),
        // and only sent when the user explicitly turned it off (Meta defaults to true)
        const shareToFeed =
          typeof firstPost?.settings?.share_to_feed !== 'undefined' &&
          firstPost?.settings?.share_to_feed !== null &&
          !this.assetBoolean(firstPost.settings.share_to_feed) &&
          !isStory &&
          firstPost?.media?.length === 1 &&
          hasExtension(m.path, 'mp4')
            ? `&share_to_feed=false`
            : ``;

        // audio_configuration is only supported for Reels (single video, not a story)
        // and only with Facebook Login (not Instagram Login / graph.instagram.com)
        const audioConfiguration =
          firstPost?.settings?.audio?.id &&
          type === 'graph.facebook.com' &&
          !isStory &&
          firstPost?.media?.length === 1 &&
          hasExtension(m.path, 'mp4')
            ? `&audio_configuration=${encodeURIComponent(
                JSON.stringify({
                  audio_id: firstPost.settings.audio.id,
                  ...(typeof firstPost.settings.audio.audio_volume !==
                  'undefined'
                    ? { audio_volume: +firstPost.settings.audio.audio_volume }
                    : {}),
                  ...(typeof firstPost.settings.audio.video_volume !==
                  'undefined'
                    ? { video_volume: +firstPost.settings.audio.video_volume }
                    : {}),
                })
              )}`
            : ``;

        const { id: photoId } = await (
          await this.fetch(
            `https://${type}/${META_GRAPH_API_VERSION}/${id}/media?${mediaType}${altText}${isCarousel}${itemCollaborators}${trialParams}${audioConfiguration}${shareToFeed}&access_token=${accessToken}${caption}`,
            {
              method: 'POST',
            }
          )
        ).json();

        return photoId;
      }) || []
    );

    // Containers are invisible until media_publish runs: the processing wait
    // and the publish itself move to checkPostStatus / finalizePost so a
    // failure there can never re-create (and re-publish) the whole post.
    return [
      {
        id: firstPost.id,
        postId: '',
        releaseURL: '',
        status: 'pending',
        pendingData: {
          type,
          postType:
            isStory && medias.length > 1
              ? 'stories'
              : medias.length === 1
              ? 'single'
              : 'carousel',
          containers: medias,
          message: firstPost?.message || '',
          ...(collaborators
            ? {
                collaborators: firstPost.settings.collaborators!.map((p) =>
                  this.stripHandle(p.label)
                ),
              }
            : {}),
        },
      },
    ];
  }

  override async checkPostStatus(
    token: string,
    pendingData: {
      type: string;
      postType: 'stories' | 'single' | 'carousel';
      containers: string[];
      message?: string;
      carouselId?: string;
      collaborators?: string[];
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    const [accessToken, userToken] = token.split('___');
    const checkToken = userToken || accessToken;

    // the carousel container was already created: wait for it
    if (pendingData.carouselId) {
      const status = await this.igContainerStatus(
        pendingData.carouselId,
        checkToken,
        pendingData.type
      );

      if (status === 'IN_PROGRESS') {
        return { status: 'pending', pendingData };
      }

      // a previous finalizePost published but died before reporting: the post
      // is live, never publish again
      if (status === 'PUBLISHED') {
        return {
          status: 'completed',
          postId: pendingData.carouselId,
          releaseURL: `https://www.instagram.com/${integration.profile}`,
        };
      }

      return { status: 'ready', pendingData };
    }

    for (const containerId of pendingData.containers) {
      const status = await this.igContainerStatus(
        containerId,
        checkToken,
        pendingData.type
      );

      if (status === 'IN_PROGRESS') {
        return { status: 'pending', pendingData };
      }

      if (status === 'PUBLISHED') {
        // a previous finalizePost died mid-way: a single post is fully live,
        // stories are resumed by finalizePost (it skips published containers)
        if (pendingData.postType === 'single') {
          return {
            status: 'completed',
            postId: containerId,
            releaseURL: `https://www.instagram.com/${integration.profile}`,
          };
        }
      }
    }

    return { status: 'ready', pendingData };
  }

  override async finalizePost(
    token: string,
    pendingData: {
      type: string;
      postType: 'stories' | 'single' | 'carousel';
      containers: string[];
      message?: string;
      carouselId?: string;
      collaborators?: string[];
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    const [accessToken, userToken] = token.split('___');
    const checkToken = userToken || accessToken;
    const igId = integration.internalId;

    if (pendingData.postType === 'stories') {
      // Stories don't support carousels - publish each media as a separate
      // story, skipping containers a previous (crashed) run already published
      let lastMediaId = '';
      for (const mediaCreationId of pendingData.containers) {
        const status = await this.igContainerStatus(
          mediaCreationId,
          checkToken,
          pendingData.type
        );
        if (status === 'PUBLISHED') {
          continue;
        }

        const { id: mediaId } = await (
          await this.fetch(
            `https://${pendingData.type}/${META_GRAPH_API_VERSION}/${igId}/media_publish?creation_id=${mediaCreationId}&access_token=${accessToken}&field=id`,
            {
              method: 'POST',
            }
          )
        ).json();
        lastMediaId = mediaId;
      }

      return {
        status: 'completed',
        postId: lastMediaId || pendingData.containers.at(-1)!,
        releaseURL: !lastMediaId
          ? `https://www.instagram.com/${integration.profile}`
          : await this.igPermalink(
              lastMediaId,
              checkToken,
              pendingData.type,
              integration
            ),
      };
    }

    if (pendingData.postType === 'carousel' && !pendingData.carouselId) {
      // create the carousel container and hand back to the workflow to wait
      // for it (an orphan container from a crashed run is invisible, so
      // re-running this is safe)
      const { id: containerId } = await (
        await this.fetch(
          `https://${pendingData.type}/${META_GRAPH_API_VERSION}/${igId}/media?caption=${encodeURIComponent(
            pendingData.message || ''
          )}&media_type=CAROUSEL&children=${encodeURIComponent(
            pendingData.containers.join(',')
          )}${
            pendingData.collaborators?.length
              ? `&collaborators=${encodeURIComponent(
                  JSON.stringify(pendingData.collaborators)
                )}`
              : ``
          }&access_token=${accessToken}`,
          {
            method: 'POST',
          }
        )
      ).json();

      return {
        status: 'pending',
        pendingData: { ...pendingData, carouselId: containerId },
      };
    }

    const creationId =
      pendingData.postType === 'carousel'
        ? pendingData.carouselId
        : pendingData.containers[0];

    let mediaId: string;
    try {
      ({ id: mediaId } = await (
        await this.fetch(
          `https://${pendingData.type}/${META_GRAPH_API_VERSION}/${igId}/media_publish?creation_id=${creationId}&access_token=${accessToken}&field=id`,
          {
            method: 'POST',
          }
        )
      ).json());
    } catch (err) {
      // Instagram sometimes answers media_publish with 2207051 ("action is
      // blocked") and still publishes the container: ask Instagram before
      // failing a post that may already be live.
      if (!(err instanceof BadBody) || !err.message.includes('blocked')) {
        throw err;
      }

      mediaId = await this.igPublishedMediaId(
        creationId!,
        igId,
        checkToken,
        pendingData.type
      );
      if (!mediaId) {
        throw err;
      }
    }

    return {
      status: 'completed',
      postId: mediaId,
      releaseURL: await this.igPermalink(
        mediaId,
        checkToken,
        pendingData.type,
        integration
      ),
    };
  }

  // Old blocking behavior, kept for workflow versions before v1.0.6 that don't
  // know how to resolve a `pending` response.
  async post(
    id: string,
    token: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration,
    type = 'graph.facebook.com'
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const [response] = await this.postPending(
      id,
      token,
      postDetails,
      integration,
      type
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
          'Media processing timed out'
        );
      }

      const check = await this.checkPostStatus(token, pendingData, integration);

      if (check.status === 'pending') {
        pendingData = check.pendingData;
        await timer(30000);
        continue;
      }

      const result =
        check.status === 'ready'
          ? await this.finalizePost(token, check.pendingData, integration)
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
      await timer(30000);
    }
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    token: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration,
    type = 'graph.facebook.com'
  ): Promise<PostResponse[]> {
    const [accessToken, userToken] = token.split('___');
    const [commentPost] = postDetails;

    const { id: commentId } = await (
      await this.fetch(
        `https://${type}/${META_GRAPH_API_VERSION}/${postId}/comments?message=${encodeURIComponent(
          commentPost.message
        )}&access_token=${accessToken}`,
        {
          method: 'POST',
        }
      )
    ).json();

    // Get the permalink from the parent post
    const { permalink } = await (
      await this.fetch(
        `https://${type}/${META_GRAPH_API_VERSION}/${postId}?fields=permalink&access_token=${
          userToken || accessToken
        }`
      )
    ).json();

    return [
      {
        id: commentPost.id,
        postId: commentId,
        releaseURL: permalink,
        status: 'success',
      },
    ];
  }

  private setTitle(name: string) {
    switch (name) {
      case 'likes':
        return 'Likes';
      case 'followers':
        return 'Followers';
      case 'reach':
        return 'Reach';
      case 'follower_count':
        return 'Follower Count';
      case 'views':
        return 'Views';
      case 'comments':
        return 'Comments';
      case 'shares':
        return 'Shares';
      case 'saves':
        return 'Saves';
      case 'replies':
        // IG account-level `replies` only counts replies to Stories, not post comments
        return 'Story Replies';
      case 'accounts_engaged':
        return 'Accounts Engaged';
      case 'total_interactions':
        return 'Total Interactions';
      case 'profile_views':
        return 'Profile Views';
      case 'website_clicks':
        return 'Website Clicks';
      case 'profile_links_taps':
        return 'Profile Link Taps';
    }

    return '';
  }

  private async fetchIgJson(url: string): Promise<any> {
    const res = await fetch(url);
    const json = await res.json();
    if (json?.error) {
      if (json.error.code === 190) {
        throw new RefreshToken(this.identifier, JSON.stringify(json), '{}');
      }
      throw new Error(json.error.message || 'Instagram Graph API error');
    }
    return json;
  }

  async analytics(
    id: string,
    token: string,
    date: number,
    type = 'graph.facebook.com'
  ): Promise<AnalyticsData[]> {
    const [accessToken] = token.split('___');
    const today = dayjs().format('YYYY-MM-DD');
    const windows = splitDateWindows(date, 28);
    const prevWindows = date <= 30 ? previousDateWindows(date, 28) : [];
    const analytics: AnalyticsData[] = [];

    // 1. Account overview snapshot (followers_count, media_count)
    const profileOverview = await safeAnalyticsCall(
      'ig.profile',
      () =>
        this.fetchIgJson(
          `https://${type}/${META_GRAPH_API_VERSION}/${id}?fields=followers_count,follows_count,media_count&access_token=${accessToken}`
        ),
      null
    );

    if (profileOverview?.followers_count !== undefined) {
      analytics.push({
        label: 'Followers',
        percentageChange: 0,
        aggregation: 'latest',
        unit: 'number',
        category: 'overview',
        data: [{ total: String(profileOverview.followers_count), date: today }],
      });
    }
    if (profileOverview?.media_count !== undefined) {
      analytics.push({
        label: 'Published Media',
        percentageChange: 0,
        aggregation: 'latest',
        unit: 'number',
        category: 'overview',
        data: [{ total: String(profileOverview.media_count), date: today }],
      });
    }

    // 2. Daily Reach across full date range (chunked <= 28d) + prior window comparison
    const reachPointsRaw: Array<{ date: string; total: number }> = [];
    await safeAnalyticsCall(
      'ig.reach',
      async () => {
        for (const w of windows) {
          const res = await this.fetchIgJson(
            `https://${type}/${META_GRAPH_API_VERSION}/${id}/insights?metric=reach&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
          );
          const values = res?.data?.[0]?.values || [];
          for (const v of values) {
            reachPointsRaw.push({
              date: dayjs(v.end_time).format('YYYY-MM-DD'),
              total: Number(v.value) || 0,
            });
          }
        }
      },
      undefined
    );

    let prevReachTotal: number | undefined;
    if (prevWindows.length > 0 && reachPointsRaw.length > 0) {
      prevReachTotal = await safeAnalyticsCall(
        'ig.reach.prev',
        async () => {
          let sum = 0;
          for (const w of prevWindows) {
            const res = await this.fetchIgJson(
              `https://${type}/${META_GRAPH_API_VERSION}/${id}/insights?metric=reach&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
            );
            for (const v of res?.data?.[0]?.values || []) {
              sum += Number(v.value) || 0;
            }
          }
          return sum;
        },
        undefined
      );
    }

    const reachPoints = mergeDailyPoints(reachPointsRaw);
    const reachSum = aggregatePoints(reachPoints, 'sum');
    if (reachPoints.length > 0) {
      analytics.push({
        label: 'Reach',
        percentageChange:
          prevReachTotal !== undefined
            ? computePercentageChange(reachSum, prevReachTotal)
            : computeSeriesTrend(reachPoints, 'sum'),
        aggregation: 'sum',
        unit: 'number',
        category: 'overview',
        data: reachPoints,
      });
    }

    // 3. Daily Follower Count (Meta restricts follower_count to the past 30 days)
    const followerDays = Math.min(date, 28);
    const followerWindow = splitDateWindows(followerDays, 28)[0];
    if (followerWindow) {
      const followerPoints = await safeAnalyticsCall(
        'ig.follower_count',
        async () => {
          const res = await this.fetchIgJson(
            `https://${type}/${META_GRAPH_API_VERSION}/${id}/insights?metric=follower_count&period=day&since=${followerWindow.since}&until=${followerWindow.until}&access_token=${accessToken}`
          );
          const values = res?.data?.[0]?.values || [];
          return mergeDailyPoints(
            values.map((v: any) => ({
              date: dayjs(v.end_time).format('YYYY-MM-DD'),
              total: Number(v.value) || 0,
            }))
          );
        },
        []
      );
      if (followerPoints.length > 0) {
        analytics.push({
          label: 'Follower Count',
          percentageChange: computeSeriesTrend(followerPoints, 'sum'),
          aggregation: 'sum',
          unit: 'number',
          category: 'overview',
          data: followerPoints,
        });
      }
    }

    // 4. Period total_value metrics (chunked <= 28d and summed)
    const sumTotalValueMetrics = async (
      metricList: string[],
      winList = windows
    ): Promise<Record<string, number>> => {
      const acc: Record<string, number> = {};
      for (const w of winList) {
        const res = await this.fetchIgJson(
          `https://${type}/${META_GRAPH_API_VERSION}/${id}/insights?metric_type=total_value&metric=${metricList.join(
            ','
          )}&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
        );
        for (const item of res?.data || []) {
          acc[item.name] =
            (acc[item.name] || 0) + (Number(item?.total_value?.value) || 0);
        }
      }
      return acc;
    };

    const coreMetrics = [
      'views',
      'likes',
      'comments',
      'shares',
      'saves',
      'replies',
    ];
    const extendedMetrics = [
      'accounts_engaged',
      'total_interactions',
      'profile_views',
      'website_clicks',
    ];

    const [
      coreTotals,
      prevCoreTotals,
      extendedTotals,
      prevExtendedTotals,
      linkTapsTotal,
    ] = await Promise.all([
      safeAnalyticsCall(
        'ig.coreTotals',
        () => sumTotalValueMetrics(coreMetrics),
        {} as Record<string, number>
      ),
      prevWindows.length > 0
        ? safeAnalyticsCall(
            'ig.coreTotals.prev',
            () => sumTotalValueMetrics(coreMetrics, prevWindows),
            {} as Record<string, number>
          )
        : Promise.resolve({} as Record<string, number>),
      safeAnalyticsCall(
        'ig.extendedTotals',
        () => sumTotalValueMetrics(extendedMetrics),
        {} as Record<string, number>
      ),
      prevWindows.length > 0
        ? safeAnalyticsCall(
            'ig.extendedTotals.prev',
            () => sumTotalValueMetrics(extendedMetrics, prevWindows),
            {} as Record<string, number>
          )
        : Promise.resolve({} as Record<string, number>),
      safeAnalyticsCall(
        'ig.profile_links_taps',
        () => sumTotalValueMetrics(['profile_links_taps']),
        {} as Record<string, number>
      ),
    ]);

    const mergedTotals = {
      ...coreTotals,
      ...extendedTotals,
      ...linkTapsTotal,
    };
    const mergedPrevTotals = {
      ...prevCoreTotals,
      ...prevExtendedTotals,
    };

    for (const metricName of [
      ...coreMetrics,
      ...extendedMetrics,
      'profile_links_taps',
    ]) {
      if (mergedTotals[metricName] === undefined) continue;
      const label = this.setTitle(metricName);
      if (!label) continue;
      const val = mergedTotals[metricName];
      const prevVal = mergedPrevTotals[metricName];
      analytics.push({
        label,
        percentageChange: computePercentageChange(val, prevVal),
        aggregation: 'sum',
        unit: 'number',
        category:
          metricName === 'views' ||
          metricName === 'profile_views' ||
          metricName === 'website_clicks' ||
          metricName === 'profile_links_taps'
            ? 'overview'
            : 'engagement',
        data: [{ total: String(val), date: today }],
      });
    }

    // Derived Engagement Rate
    const totalInteractions =
      mergedTotals.total_interactions ??
      (mergedTotals.likes || 0) +
        (mergedTotals.comments || 0) +
        (mergedTotals.shares || 0) +
        (mergedTotals.saves || 0);
    const denominator = reachSum || mergedTotals.views || 0;
    if (denominator > 0 && totalInteractions >= 0) {
      const engRate = Number(((totalInteractions / denominator) * 100).toFixed(2));
      const prevInteractions =
        mergedPrevTotals.total_interactions ??
        (mergedPrevTotals.likes || 0) +
          (mergedPrevTotals.comments || 0) +
          (mergedPrevTotals.shares || 0) +
          (mergedPrevTotals.saves || 0);
      const prevDenom = prevReachTotal || mergedPrevTotals.views || 0;
      const prevEngRate =
        prevDenom > 0 ? (prevInteractions / prevDenom) * 100 : undefined;

      analytics.push({
        label: 'Engagement Rate',
        average: true,
        unit: 'percent',
        aggregation: 'latest',
        category: 'engagement',
        percentageChange: computePercentageChange(engRate, prevEngRate, true),
        data: [{ total: String(engRate), date: today }],
      });
    }

    // 5. Breakdowns & Demographics (all isolated via safeAnalyticsCall)
    const fetchTotalBreakdown = async (
      metric: string,
      breakdownKey: string
    ): Promise<Record<string, number>> => {
      const map: Record<string, number> = {};
      for (const w of windows) {
        const res = await this.fetchIgJson(
          `https://${type}/${META_GRAPH_API_VERSION}/${id}/insights?metric=${metric}&metric_type=total_value&breakdown=${breakdownKey}&period=day&since=${w.since}&until=${w.until}&access_token=${accessToken}`
        );
        const results =
          res?.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
        for (const row of results) {
          const dim = (row.dimension_values || []).join(' / ');
          if (!dim) continue;
          map[dim] = (map[dim] || 0) + (Number(row.value) || 0);
        }
      }
      return map;
    };

    // engaged_audience_demographics only accepts this_week / this_month
    const fetchDemographic = async (
      breakdownKey: 'country' | 'city' | 'age' | 'gender',
      metric: 'follower_demographics' | 'engaged_audience_demographics' = 'follower_demographics'
    ): Promise<Record<string, number>> => {
      const timeframe =
        metric === 'engaged_audience_demographics' ? '&timeframe=this_month' : '';
      const res = await this.fetchIgJson(
        `https://${type}/${META_GRAPH_API_VERSION}/${id}/insights?metric=${metric}&period=lifetime${timeframe}&metric_type=total_value&breakdown=${breakdownKey}&access_token=${accessToken}`
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

    const [
      formatViewsMap,
      audienceTypeViewsMap,
      followsUnfollowsMap,
      countryMap,
      cityMap,
      ageMap,
      genderMap,
      onlineHours,
      reachAudienceTypeMap,
      engagedCountryMap,
      engagedCityMap,
      engagedAgeMap,
      engagedGenderMap,
    ] = await Promise.all([
      safeAnalyticsCall(
        'ig.views_by_format',
        () => fetchTotalBreakdown('views', 'media_product_type'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.views_by_follow_type',
        () => fetchTotalBreakdown('views', 'follow_type'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.follows_and_unfollows',
        () => fetchTotalBreakdown('follows_and_unfollows', 'follow_type'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.demo.country',
        () => fetchDemographic('country'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.demo.city',
        () => fetchDemographic('city'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.demo.age',
        () => fetchDemographic('age'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.demo.gender',
        () => fetchDemographic('gender'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.online_followers',
        async () => {
          const oUntil = dayjs().startOf('day').unix();
          const oSince = dayjs().subtract(3, 'day').startOf('day').unix();
          const res = await this.fetchIgJson(
            `https://${type}/${META_GRAPH_API_VERSION}/${id}/insights?metric=online_followers&period=lifetime&since=${oSince}&until=${oUntil}&access_token=${accessToken}`
          );
          const values = res?.data?.[0]?.values || [];
          const latestObj = values[values.length - 1]?.value;
          if (!latestObj || typeof latestObj !== 'object') return [];
          const entries: Array<{ label: string; value: number }> = [];
          for (let h = 0; h < 24; h++) {
            const val = Number(latestObj[String(h)] ?? 0) || 0;
            entries.push({
              label: `${String(h).padStart(2, '0')}:00`,
              value: val,
            });
          }
          return buildBreakdown(entries, 24, true);
        },
        []
      ),
      safeAnalyticsCall(
        'ig.reach_by_follow_type',
        () => fetchTotalBreakdown('reach', 'follow_type'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.engaged.country',
        () => fetchDemographic('country', 'engaged_audience_demographics'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.engaged.city',
        () => fetchDemographic('city', 'engaged_audience_demographics'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.engaged.age',
        () => fetchDemographic('age', 'engaged_audience_demographics'),
        {} as Record<string, number>
      ),
      safeAnalyticsCall(
        'ig.engaged.gender',
        () => fetchDemographic('gender', 'engaged_audience_demographics'),
        {} as Record<string, number>
      ),
    ]);

    const formatBreakdown = buildBreakdown(formatViewsMap, 8);
    if (formatBreakdown.length > 0) {
      const sum = formatBreakdown.reduce((a, b) => a + b.value, 0);
      analytics.push({
        label: 'Views by Format',
        percentageChange: 0,
        category: 'traffic',
        breakdown: formatBreakdown,
        data: [{ total: String(sum), date: today }],
      });
    }

    const audienceTypeBreakdown = buildBreakdown(audienceTypeViewsMap, 6);
    if (audienceTypeBreakdown.length > 0) {
      const sum = audienceTypeBreakdown.reduce((a, b) => a + b.value, 0);
      analytics.push({
        label: 'Views by Audience Type',
        percentageChange: 0,
        category: 'audience',
        breakdown: audienceTypeBreakdown,
        data: [{ total: String(sum), date: today }],
      });
    }

    const reachAudienceTypeBreakdown = buildBreakdown(reachAudienceTypeMap, 6);
    if (reachAudienceTypeBreakdown.length > 0) {
      const sum = reachAudienceTypeBreakdown.reduce((a, b) => a + b.value, 0);
      analytics.push({
        label: 'Reach by Audience Type',
        percentageChange: 0,
        category: 'audience',
        breakdown: reachAudienceTypeBreakdown,
        data: [{ total: String(sum), date: today }],
        // reach is unique per window, so ranges over 28 days add up window totals
        note:
          windows.length > 1
            ? 'Summed across 28-day windows, may count a person more than once.'
            : undefined,
      });
    }

    const followBreakdown = buildBreakdown(followsUnfollowsMap, 6);
    if (followBreakdown.length > 0) {
      const net =
        (followsUnfollowsMap.FOLLOWER || 0) -
        (followsUnfollowsMap.NON_FOLLOWER || 0);
      analytics.push({
        label: 'Follows & Unfollows',
        percentageChange: 0,
        category: 'overview',
        breakdown: followBreakdown,
        data: [{ total: String(net), date: today }],
      });
    }

    const addDemoCard = (
      title: string,
      rawMap: Record<string, number>,
      limit = 10,
      note?: string
    ) => {
      const bd = buildBreakdown(rawMap, limit);
      if (bd.length > 0) {
        const sum = bd.reduce((a, b) => a + b.value, 0);
        analytics.push({
          label: title,
          percentageChange: 0,
          category: 'audience',
          breakdown: bd,
          data: [{ total: String(sum), date: today }],
          note,
        });
      }
    };

    addDemoCard('Audience by Country', countryMap, 10);
    addDemoCard('Audience by City', cityMap, 10);
    addDemoCard('Audience by Age', ageMap, 10);
    addDemoCard('Audience by Gender', genderMap, 6);
    const engagedNote = 'This month so far, independent of the selected range.';
    addDemoCard('Engaged Audience by Country', engagedCountryMap, 10, engagedNote);
    addDemoCard('Engaged Audience by City', engagedCityMap, 10, engagedNote);
    addDemoCard('Engaged Audience by Age', engagedAgeMap, 10, engagedNote);
    addDemoCard('Engaged Audience by Gender', engagedGenderMap, 6, engagedNote);

    if (onlineHours.length > 0) {
      const peak = onlineHours.reduce(
        (max, cur) => (cur.value > max ? cur.value : max),
        0
      );
      analytics.push({
        label: 'Active Followers by Hour',
        percentageChange: 0,
        category: 'audience',
        aggregation: 'latest',
        breakdown: onlineHours,
        data: [{ total: String(peak), date: today }],
      });
    }

    // 6. Recent Posts Performance Leaderboard
    const recentPosts = await safeAnalyticsCall<AnalyticsPostItem[]>(
      'ig.recent_posts',
      async () => {
        const mediaRes = await this.fetchIgJson(
          `https://${type}/${META_GRAPH_API_VERSION}/${id}/media?fields=id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count&limit=12&access_token=${accessToken}`
        );
        const items: any[] = mediaRes?.data || [];
        const enriched = await Promise.all(
          items.map(async (m) => {
            const [ins, reelIns] = await Promise.all([
              safeAnalyticsCall(
                `ig.media_insight.${m.id}`,
                () =>
                  this.fetchIgJson(
                    `https://${type}/${META_GRAPH_API_VERSION}/${m.id}/insights?metric=views,reach,saved,shares&access_token=${accessToken}`
                  ),
                null
              ),
              m.media_product_type === 'REELS'
                ? safeAnalyticsCall(
                    `ig.media_watch_time.${m.id}`,
                    () =>
                      this.fetchIgJson(
                        `https://${type}/${META_GRAPH_API_VERSION}/${m.id}/insights?metric=ig_reels_avg_watch_time&access_token=${accessToken}`
                      ),
                    null
                  )
                : Promise.resolve(null),
            ]);
            const avgWatchMs = reelIns?.data?.[0]?.values?.[0]?.value;
            const map: Record<string, number> = {};
            for (const row of ins?.data || []) {
              const v = row?.values?.[0]?.value ?? row?.total_value?.value;
              if (v !== undefined) map[row.name] = Number(v) || 0;
            }
            const likes = Number(m.like_count) || 0;
            const comments = Number(m.comments_count) || 0;
            const shares = map.shares;
            const saves = map.saved;
            const views = map.views;
            const reach = map.reach;
            const denom = reach || views || 0;
            const interactions =
              likes + comments + (shares || 0) + (saves || 0);
            return {
              id: String(m.id),
              title: summarizePostTitle(m.caption, m.media_product_type || m.media_type || 'Post'),
              url: m.permalink,
              thumbnail: m.thumbnail_url || (m.media_type === 'IMAGE' ? m.media_url : undefined),
              publishedAt: m.timestamp
                ? dayjs(m.timestamp).format('YYYY-MM-DD HH:mm')
                : today,
              mediaType: m.media_product_type || m.media_type,
              views,
              reach,
              likes,
              comments,
              shares,
              saves,
              engagementRate:
                denom > 0
                  ? Number(((interactions / denom) * 100).toFixed(2))
                  : undefined,
              avgWatchTimeSeconds:
                avgWatchMs !== undefined
                  ? Number(((Number(avgWatchMs) || 0) / 1000).toFixed(1))
                  : undefined,
            } as AnalyticsPostItem;
          })
        );
        return enriched;
      },
      []
    );

    if (recentPosts.length > 0) {
      analytics.push({
        label: 'Recent Posts Performance',
        percentageChange: 0,
        category: 'posts',
        posts: recentPosts,
        data: [{ total: String(recentPosts.length), date: today }],
      });
    }

    return analytics;
  }

  music(accessToken: string, data: { q: string }) {
    return this.fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/music/search?q=${encodeURIComponent(
        data.q
      )}&access_token=${accessToken}`
    );
  }

  // https://developers.facebook.com/docs/instagram-platform/content-publishing/audio-api/
  // empty search_query returns trending audio
  @Tool({
    description:
      'Search audio (music or original sounds) to attach to a Reel via the "audio" setting, an empty query returns trending audio',
    dataSchema: [
      {
        key: 'q',
        type: 'string',
        description: 'Search query, leave empty for trending audio',
      },
      {
        key: 'type',
        type: 'string',
        description: 'Either "music" or "original_sound", defaults to "music"',
      },
    ],
  })
  async audioSearch(
    token: string,
    data: { q?: string; type?: 'music' | 'original_sound' },
    internalId?: string
  ) {
    const [accessToken, userToken] = token.split('___');
    const audioType =
      data?.type === 'original_sound' ? 'original_sound' : 'music';

    const { audio } = await (
      await this.fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/ig_audio?audio_type=${audioType}&user_id=${internalId}${
          data?.q ? `&search_query=${encodeURIComponent(data.q)}` : ''
        }&access_token=${userToken || accessToken}`
      )
    ).json();

    return (audio || []).map((audio: any) => ({
      id: audio.audio_id,
      title: audio.title || '',
      artist: audio.display_artist || audio.ig_username || '',
      image:
        audio.cover_artwork_thumbnail_uri ||
        audio.cover_artwork_thumbnail_url ||
        audio.profile_picture_url ||
        '',
      duration: audio.duration_in_ms || 0,
      previewUrl: audio.download_url || '',
    }));
  }

  async postAnalytics(
    integrationId: string,
    token: string,
    postId: string,
    date: number,
    type = 'graph.facebook.com'
  ): Promise<AnalyticsData[]> {
    const [accessToken] = token.split('___');
    const today = dayjs().format('YYYY-MM-DD');

    try {
      const [metaInfo, coreData, extraData, reelData] = await Promise.all([
        safeAnalyticsCall(
          'ig.post.meta',
          () =>
            this.fetchIgJson(
              `https://${type}/${META_GRAPH_API_VERSION}/${postId}?fields=id,media_type,media_product_type,like_count,comments_count&access_token=${accessToken}`
            ),
          null
        ),
        safeAnalyticsCall(
          'ig.post.core',
          () =>
            this.fetchIgJson(
              `https://${type}/${META_GRAPH_API_VERSION}/${postId}/insights?metric=views,reach,saved,likes,comments,shares&access_token=${accessToken}`
            ),
          null
        ),
        safeAnalyticsCall(
          'ig.post.extra',
          () =>
            this.fetchIgJson(
              `https://${type}/${META_GRAPH_API_VERSION}/${postId}/insights?metric=total_interactions,follows,profile_visits,profile_activity&access_token=${accessToken}`
            ),
          null
        ),
        safeAnalyticsCall(
          'ig.post.reels',
          () =>
            this.fetchIgJson(
              `https://${type}/${META_GRAPH_API_VERSION}/${postId}/insights?metric=ig_reels_avg_watch_time,ig_reels_video_view_total_time&access_token=${accessToken}`
            ),
          null
        ),
      ]);

      const metricsMap = new Map<string, number>();
      for (const batch of [coreData?.data, extraData?.data, reelData?.data]) {
        for (const metric of batch || []) {
          const val =
            metric?.values?.[0]?.value ?? metric?.total_value?.value;
          if (val !== undefined && typeof val === 'number') {
            metricsMap.set(metric.name, val);
          }
        }
      }

      if (metricsMap.get('likes') === undefined && metaInfo?.like_count !== undefined) {
        metricsMap.set('likes', Number(metaInfo.like_count) || 0);
      }
      if (metricsMap.get('comments') === undefined && metaInfo?.comments_count !== undefined) {
        metricsMap.set('comments', Number(metaInfo.comments_count) || 0);
      }

      const result: AnalyticsData[] = [];
      const pushMetric = (
        key: string,
        label: string,
        category: AnalyticsData['category'] = 'engagement',
        unit: AnalyticsData['unit'] = 'number',
        transform = (v: number) => v
      ) => {
        const raw = metricsMap.get(key);
        if (raw === undefined) return;
        const formatted = transform(raw);
        result.push({
          label,
          percentageChange: 0,
          unit,
          aggregation: 'latest',
          category,
          data: [
            {
              total: String(
                Number.isInteger(formatted)
                  ? formatted
                  : Number(formatted.toFixed(2))
              ),
              date: today,
            },
          ],
        });
      };

      pushMetric('views', 'Views', 'overview');
      pushMetric('reach', 'Reach', 'overview');
      pushMetric('likes', 'Likes', 'engagement');
      pushMetric('comments', 'Comments', 'engagement');
      pushMetric('shares', 'Shares', 'engagement');
      pushMetric('saved', 'Saves', 'engagement');
      pushMetric('total_interactions', 'Total Interactions', 'engagement');
      pushMetric('profile_visits', 'Profile Visits', 'traffic');
      pushMetric('follows', 'Follows', 'overview');
      pushMetric(
        'ig_reels_avg_watch_time',
        'Average Watch Time',
        'retention',
        'seconds',
        (ms) => ms / 1000
      );
      pushMetric(
        'ig_reels_video_view_total_time',
        'Total Watch Time',
        'retention',
        'minutes',
        (ms) => ms / 60000
      );

      // breakdown is only valid for profile_activity, and Meta rejects it on
      // Reels, so it runs on its own once the media type is known
      const profileActivityData =
        metaInfo && metaInfo.media_product_type !== 'REELS'
          ? await safeAnalyticsCall(
              'ig.post.profile_activity',
              () =>
                this.fetchIgJson(
                  `https://${type}/${META_GRAPH_API_VERSION}/${postId}/insights?metric=profile_activity&breakdown=action_type&access_token=${accessToken}`
                ),
              null
            )
          : null;

      const profileActivityBreakdown = buildBreakdown(
        (
          profileActivityData?.data?.[0]?.total_value?.breakdowns?.[0]
            ?.results || []
        ).map((row: any) => ({
          label: (row.dimension_values || []).join(' / '),
          value: Number(row.value) || 0,
        })),
        8
      );
      if (profileActivityBreakdown.length > 0) {
        const sum = profileActivityBreakdown.reduce((a, b) => a + b.value, 0);
        result.push({
          label: 'Profile Activity',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'traffic',
          breakdown: profileActivityBreakdown,
          data: [{ total: String(sum), date: today }],
        });
      }

      const denom = metricsMap.get('reach') || metricsMap.get('views') || 0;
      const interactions =
        metricsMap.get('total_interactions') ??
        (metricsMap.get('likes') || 0) +
          (metricsMap.get('comments') || 0) +
          (metricsMap.get('shares') || 0) +
          (metricsMap.get('saved') || 0);
      if (denom > 0 && interactions >= 0) {
        result.push({
          label: 'Engagement Rate',
          percentageChange: 0,
          average: true,
          unit: 'percent',
          aggregation: 'latest',
          category: 'engagement',
          data: [
            {
              total: String(Number(((interactions / denom) * 100).toFixed(2))),
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
      console.error('Error fetching Instagram post analytics:', err);
      return [];
    }
  }

  async analyticsSnapshot(
    id: string,
    token: string,
    type = 'graph.facebook.com'
  ): Promise<AnalyticsSnapshotData | undefined> {
    const [accessToken] = token.split('___');
    const profile = await this.fetchIgJson(
      `https://${type}/${META_GRAPH_API_VERSION}/${id}?fields=followers_count&access_token=${accessToken}`
    );

    const demographics: Record<string, Record<string, number>> = {};
    for (const breakdown of ['country', 'city', 'age', 'gender']) {
      const res = await safeAnalyticsCall(
        `ig.snapshot.${breakdown}`,
        () =>
          this.fetchIgJson(
            `https://${type}/${META_GRAPH_API_VERSION}/${id}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=${breakdown}&access_token=${accessToken}`
          ),
        null
      );
      const map: Record<string, number> = {};
      for (const row of res?.data?.[0]?.total_value?.breakdowns?.[0]
        ?.results || []) {
        const dim = (row.dimension_values || []).join(' ');
        if (dim) {
          map[dim] = (map[dim] || 0) + (Number(row.value) || 0);
        }
      }
      if (Object.keys(map).length > 0) {
        demographics[breakdown] = map;
      }
    }

    return {
      followers:
        profile?.followers_count !== undefined
          ? Number(profile.followers_count) || 0
          : undefined,
      demographics:
        Object.keys(demographics).length > 0 ? demographics : undefined,
    };
  }

  async storyInsights(
    id: string,
    token: string,
    type = 'graph.facebook.com'
  ): Promise<StoryInsightData[]> {
    const [accessToken] = token.split('___');
    const stories = await this.fetchIgJson(
      `https://${type}/${META_GRAPH_API_VERSION}/${id}/stories?fields=id,media_type,permalink,thumbnail_url,media_url,timestamp&access_token=${accessToken}`
    );

    const result: StoryInsightData[] = [];
    for (const story of stories?.data || []) {
      // navigation only accepts its own breakdown, so it gets its own call
      const [core, navigation] = await Promise.all([
        safeAnalyticsCall(
          'ig.story.core',
          () =>
            this.fetchIgJson(
              `https://${type}/${META_GRAPH_API_VERSION}/${story.id}/insights?metric=reach,views,replies,shares,total_interactions,follows,profile_visits&access_token=${accessToken}`
            ),
          null
        ),
        safeAnalyticsCall(
          'ig.story.navigation',
          () =>
            this.fetchIgJson(
              `https://${type}/${META_GRAPH_API_VERSION}/${story.id}/insights?metric=navigation&breakdown=story_navigation_action_type&access_token=${accessToken}`
            ),
          null
        ),
      ]);

      const metrics: Record<string, number> = {};
      for (const metric of core?.data || []) {
        const val = metric?.values?.[0]?.value ?? metric?.total_value?.value;
        if (typeof val === 'number') {
          metrics[metric.name] = val;
        }
      }
      for (const row of navigation?.data?.[0]?.total_value?.breakdowns?.[0]
        ?.results || []) {
        const action = String(row.dimension_values?.[0] || '').toLowerCase();
        if (action) {
          metrics[`navigation_${action}`] = Number(row.value) || 0;
        }
      }

      result.push({
        id: String(story.id),
        permalink: story.permalink,
        thumbnail: story.thumbnail_url || story.media_url,
        mediaType: story.media_type,
        publishedAt: story.timestamp,
        metrics,
      });
    }

    return result;
  }
}
