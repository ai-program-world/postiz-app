import {
  AnalyticsData,
  AnalyticsPostItem,
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import dayjs from 'dayjs';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
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
  mergeDailyPoints,
  safeAnalyticsCall,
  splitDateWindows,
  summarizePostTitle,
} from '@gitroom/nestjs-libraries/integrations/social/analytics.helper';
import { TikTokDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/tiktok.dto';
import { timer } from '@gitroom/helpers/utils/timer';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';

@Rules(
  [
    'TikTok Business can have one video or one picture or multiple pictures (up to 35), it cannot be without an attachment.',
    'content_posting_method=DIRECT_POST publishes the post to the account. content_posting_method=UPLOAD does NOT publish: it only saves the media as a draft in the user inbox of the TikTok app, where the user must manually complete and publish it. Use DIRECT_POST unless the user explicitly asks to review or edit the post inside the TikTok app first.',
    'With content_posting_method=UPLOAD, TikTok ignores every setting except the title / post content. Never tell the user that video_made_with_ai, privacy_level, duet, stitch, comment, autoAddMusic, brand_content_toggle or brand_organic_toggle will be applied in UPLOAD mode - they are silently discarded. If the user asks for any of those settings, tell them it requires DIRECT_POST.',
    'video_made_with_ai, duet and stitch apply to video posts only. privacy_level and autoAddMusic apply to photo posts only - the TikTok Business API has no privacy field for video posts, so those settings are discarded when the attachment is a video.',
    'The music setting attaches a commercial music library track (found via the musicSearch function) to a video or photo post, and the location setting tags the post with a location (found via the locationSearch function). Both apply only with content_posting_method=DIRECT_POST. music.audio_volume / music.video_volume (0-100, default 50) apply to video posts only. For photos, autoAddMusic=yes attaches a RANDOM commercial music library track and overrides any music selection - use autoAddMusic=no when the user wants a specific track.',
    'Media is pulled by TikTok from its URL, so the media must be uploaded to Postiz and the media domain must be a verified URL property of the TikTok Business app.',
  ].join(' ')
)
export class TiktokBusinessProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'tiktok-business';
  name = 'TikTok';
  isBetweenSteps = false;
  convertToJPEG = true;
  scopes = [
    'user.info.basic',
    'user.info.username',
    'user.info.stats',
    'video.list',
    'video.upload',
    'video.publish',
  ];
  override maxConcurrentJob = 10000;
  dto = TikTokDto;
  editor = 'normal' as const;
  maxLength() {
    // Business API caption limit for videos (photos allow 4,000)
    return 2200;
  }

  private baseUrl = 'https://business-api.tiktok.com/open_api/v1.3';

  // The TikTok developer portal only accepts redirect URLs that end with "/"
  // for Business apps, so the trailing slash here is not cosmetic - the
  // redirect_uri sent on the token exchange must match the registered one.
  private redirectUri() {
    return `${
      process?.env?.FRONTEND_URL?.indexOf('https') === -1
        ? 'https://redirectmeto.com/'
        : ''
    }${process?.env?.FRONTEND_URL}/integrations/social/tiktok-business/`;
  }

  override async checkValidity(
    items: Array<ValidityMedia[]>
  ): Promise<string | true> {
    const [firstItems] = items ?? [];
    if ((firstItems?.length ?? 0) === 0) {
      return 'No video / images selected';
    }
    if (
      (firstItems?.length ?? 0) > 1 &&
      firstItems?.some((p) => (p?.path?.indexOf?.('mp4') ?? -1) > -1)
    ) {
      return 'Only pictures are supported when selecting multiple items';
    } else if (
      firstItems?.length !== 1 &&
      (firstItems?.[0]?.path?.indexOf?.('mp4') ?? -1) > -1
    ) {
      return 'You need one media';
    }
    if ((firstItems?.length ?? 0) > 35) {
      return 'You can select up to 35 pictures';
    }

    // TikTok fails the whole photo post when a single image is oversized, and
    // the status only says `picture_size_check_failed` without naming it.
    if (firstItems?.every((p) => (p?.path?.indexOf?.('mp4') ?? -1) === -1)) {
      const dimensions = await Promise.all(
        firstItems?.map((p) => this.getImageDimensions(p?.path)) ?? []
      );
      const tooBig = dimensions.findIndex(
        (p) => Math.min(p?.width ?? 0, p?.height ?? 0) > 1080
      );
      if (tooBig > -1) {
        return `Image ${tooBig + 1} is ${dimensions[tooBig]?.width}x${
          dimensions[tooBig]?.height
        }, TikTok allows a maximum of 1080px on the shorter side`;
      }
    }
    return true;
  }

  override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body' | 'disconnect';
        value: string;
      }
    | undefined {
    // Authentication/Authorization errors - require re-authentication.
    // The Business API answers HTTP 200 with a non-zero `code`, so token
    // problems are detected from the body, not the status code.
    if (
      body.indexOf('access_token_invalid') > -1 ||
      body.indexOf('Access token is incorrect') > -1 ||
      body.indexOf('Access token has expired') > -1 ||
      // code 40000 wording seen on /business/video/publish/
      body.indexOf('The access token is invalid') > -1 ||
      body.indexOf('auth_removed') > -1
    ) {
      return {
        type: 'refresh-token' as const,
        value:
          'Access token invalid, please re-authenticate your TikTok account',
      };
    }

    // Rate limiting errors
    if (
      body.indexOf('rate_limit_exceeded') > -1 ||
      body.indexOf('Too many requests') > -1
    ) {
      return {
        type: 'bad-body' as const,
        value: 'TikTok API rate limit exceeded, please try again later',
      };
    }

    if (body.indexOf('file_format_check_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'File format is invalid, please check video specifications',
      };
    }

    if (body.indexOf('duration_check_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Video duration is invalid, please check video specifications',
      };
    }

    if (body.indexOf('frame_rate_check_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Video frame rate is invalid, please check video specifications',
      };
    }

    if (body.indexOf('video_pull_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Failed to pull video from URL, please check the URL',
      };
    }

    if (body.indexOf('photo_pull_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Failed to pull photo from URL, please check the URL',
      };
    }

    if (body.indexOf('spam_risk_user_banned_from_posting') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Account banned from posting, please check TikTok account status',
      };
    }

    if (body.indexOf('spam_risk_text') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'TikTok detected potential spam in the post text',
      };
    }

    if (body.indexOf('spam_risk_too_many_posts') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'TikTok says your daily post limit reached, please try again tomorrow',
      };
    }

    if (body.indexOf('spam_risk') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'TikTok detected potential spam',
      };
    }

    // Unlike the legacy app there is no migration target configured for this
    // provider, so the cap stays a failed post (re-connecting cannot reset a
    // daily quota) - if this app is ever migrated too, switch to 'disconnect'.
    if (body.indexOf('reached_active_user_cap') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'TikTok daily user limit reached, please try again tomorrow',
      };
    }

    if (body.indexOf('url_ownership_unverified') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'The media domain is not a verified URL property of the TikTok app',
      };
    }

    if (body.indexOf('publish_cancelled') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'TikTok cancelled the upload, please try again',
      };
    }

    if (body.indexOf('picture_size_check_failed') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Media size not supported by TikTok: images up to 1080px on the shorter side, videos at least 360px on both sides',
      };
    }

    // Content/Format validation errors
    if (body.indexOf('invalid_params') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid request parameters, please check content format',
      };
    }

    // Server errors
    if (body.indexOf('internal') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'There is a problem with TikTok servers, please try again later',
      };
    }

    if (body.indexOf('TikTok API error') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'TikTok API error, please try again',
      };
    }

    // Fall back to parent class error handling
    return undefined;
  }

  // Every Business API endpoint (except OAuth) authenticates with the
  // `Access-Token` header and wraps the payload in {code, message, data} -
  // errors come back as HTTP 200 with a non-zero code.
  private async fetchUserInformation(accessToken: string, businessId: string) {
    const information = await (
      await this.fetch(
        `${this.baseUrl}/business/get/?business_id=${encodeURIComponent(
          businessId
        )}&fields=${encodeURIComponent(
          JSON.stringify(['username', 'display_name', 'profile_image'])
        )}`,
        {
          method: 'GET',
          headers: {
            'Access-Token': accessToken,
          },
        }
      )
    ).json();

    // A non-zero code arrives as HTTP 200: without this check the auth flow
    // would "succeed" with an undefined name/picture/profile and create a
    // broken channel.
    if (information?.code !== 0) {
      const asString = JSON.stringify(information);
      const handleError = this.handleErrors(asString);
      throw new BadBody(
        'tiktok-business',
        asString,
        Buffer.from('{}'),
        handleError?.value ||
          information?.message ||
          'Could not load the TikTok business account'
      );
    }

    return {
      display_name: information.data?.display_name,
      profile_image: information.data?.profile_image,
      username: information.data?.username,
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const response = await (
      await fetch(`${this.baseUrl}/tt_user/oauth2/refresh_token/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: process.env.TIKTOK_BUSINESS_CLIENT_ID!,
          client_secret: process.env.TIKTOK_BUSINESS_CLIENT_SECRET!,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      })
    ).json();

    // OAuth failures also arrive as HTTP 200 with a non-zero code and no data -
    // without this check the destructure below throws an unclassified TypeError.
    if (response?.code !== 0 || !response?.data?.access_token) {
      const asString = JSON.stringify(response);
      const handleError = this.handleErrors(asString);
      throw new BadBody(
        'tiktok-business',
        asString,
        Buffer.from('{}'),
        handleError?.value ||
          response?.message ||
          'Could not refresh the TikTok access token'
      );
    }

    const { access_token, refresh_token, open_id } = response.data;

    const { display_name, profile_image, username } =
      await this.fetchUserInformation(access_token, open_id);

    return {
      refreshToken: refresh_token,
      expiresIn: dayjs().add(23, 'hours').unix() - dayjs().unix(),
      accessToken: access_token,
      // open_id is stored verbatim: it doubles as the business_id parameter of
      // every Business API call, so it must not be normalized.
      id: open_id,
      name: display_name,
      picture: profile_image || '',
      username: username,
    };
  }

  async generateAuthUrl() {
    const state = makeSecureId(16);

    return {
      url:
        'https://www.tiktok.com/v2/auth/authorize/' +
        `?client_key=${process.env.TIKTOK_BUSINESS_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(this.redirectUri())}` +
        `&state=${state}` +
        `&response_type=code` +
        `&disable_auto_auth=1` +
        `&scope=${encodeURIComponent(this.scopes.join(','))}`,
      codeVerifier: state,
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    // A redirect without an auth_code (consent declined or TikTok-side error)
    // otherwise reaches the token endpoint and fails as 40002 "Please provide
    // the auth_code", which hides the real cause in the logs.
    if (!params.code) {
      throw new BadBody(
        'tiktok-business',
        JSON.stringify({ reason: 'no auth_code in the redirect' }),
        Buffer.from('{}'),
        'TikTok did not return an authorization code, the authorization was not completed'
      );
    }

    const response = await (
      await fetch(`${this.baseUrl}/tt_user/oauth2/token/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: process.env.TIKTOK_BUSINESS_CLIENT_ID!,
          client_secret: process.env.TIKTOK_BUSINESS_CLIENT_SECRET!,
          grant_type: 'authorization_code',
          auth_code: params.code,
          redirect_uri: this.redirectUri(),
        }),
      })
    ).json();

    // Same HTTP 200 + non-zero code envelope as the refresh call: an expired
    // auth_code or mismatched redirect_uri must surface TikTok's reason instead
    // of a TypeError on the destructure.
    if (response?.code !== 0 || !response?.data?.access_token) {
      const asString = JSON.stringify(response);
      const handleError = this.handleErrors(asString);
      throw new BadBody(
        'tiktok-business',
        asString,
        Buffer.from('{}'),
        handleError?.value ||
          response?.message ||
          'Could not authenticate the TikTok business account'
      );
    }

    const { access_token, refresh_token, scope, open_id } = response.data;

    this.checkScopes(this.scopes, scope);

    const { display_name, profile_image, username } =
      await this.fetchUserInformation(access_token, open_id);

    return {
      id: open_id,
      name: display_name,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: dayjs().add(23, 'hours').unix() - dayjs().unix(),
      picture: profile_image || '',
      username: username,
    };
  }

  // Single status check for a publish_id, no loops and no timers: `post` returns
  // a `pending` PostResponse right after the publish call, and the post workflow
  // polls this method with durable timers, so a stuck/retried check can never
  // re-run the publish and duplicate the post.
  override async checkPostStatus(
    accessToken: string,
    pendingData: { publishId: string },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    let body: string;
    let post: any;
    try {
      body = await (
        await this.fetch(
          `${this.baseUrl}/business/publish/status/?business_id=${encodeURIComponent(
            integration.internalId
          )}&publish_id=${encodeURIComponent(pendingData.publishId)}`,
          {
            method: 'GET',
            headers: {
              'Access-Token': accessToken,
            },
          },
          '',
          0,
          true
        )
      ).text();
      post = JSON.parse(body);
    } catch (err) {
      if (err instanceof RefreshToken || err instanceof Disconnect) {
        throw err;
      }

      // Transient API error while checking the status: the post may already
      // be live, so keep polling instead of failing it - if the API stays
      // broken the caller exhausts its checks and warns the user properly.
      return { status: 'pending', pendingData };
    }

    // Errors arrive as HTTP 200 with a non-zero code, invisible to this.fetch:
    // a token error must surface as RefreshToken, anything else is treated as
    // transient and keeps polling (same rationale as the catch above).
    if (post?.code !== 0) {
      const asString = JSON.stringify(post);
      const handleError = this.handleErrors(asString);
      if (handleError?.type === 'refresh-token') {
        throw new RefreshToken('tiktok-business', asString, '{}', handleError.value);
      }
      if (handleError?.type === 'disconnect') {
        throw new Disconnect('tiktok-business', asString, '{}', handleError.value);
      }
      return { status: 'pending', pendingData };
    }

    const { status, reason } = post?.data || {};

    if (status === 'SEND_TO_USER_INBOX') {
      // the id stays 'missing' until the user publishes the draft - the
      // share id rides in the URL fragment so resolveReleaseId can ask later
      return {
        status: 'completed',
        releaseURL: `https://www.tiktok.com/messages?lang=en#${pendingData.publishId}`,
        postId: 'missing',
      };
    }

    if (status === 'PUBLISH_COMPLETE') {
      // post_ids can lag up to 3 minutes behind PUBLISH_COMPLETE, and never
      // shows up at all for non-public posts - fall back to the profile URL
      // and keep the share_id (resolveReleaseId fixes it later).
      const publicPostId = this.publicPostId(body);

      return {
        status: 'completed',
        releaseURL: !publicPostId
          ? `https://www.tiktok.com/@${integration.profile}`
          : this.postUrl(integration, pendingData.publishId, publicPostId),
        postId: !publicPostId ? pendingData.publishId : publicPostId,
      };
    }

    if (status === 'FAILED') {
      const handleError = this.handleErrors(
        `${reason || ''} ${JSON.stringify(post)}`
      );
      throw new BadBody(
        'tiktok-business-error-upload',
        JSON.stringify(post),
        Buffer.from(JSON.stringify(post)),
        handleError?.value || ''
      );
    }

    return { status: 'pending', pendingData };
  }

  // UPLOAD does not publish - it only drops the media into the user's TikTok
  // inbox as a draft - so only an explicit UPLOAD selects it. A missing value
  // (drafts, or any caller that skipped the setting) publishes instead of
  // silently landing in the inbox.
  private contentPostingMethod(
    firstPost: PostDetails<TikTokDto>
  ): TikTokDto['content_posting_method'] {
    return firstPost?.settings?.content_posting_method === 'UPLOAD'
      ? 'UPLOAD'
      : 'DIRECT_POST';
  }

  // The Business API is PULL_FROM_URL only: TikTok downloads the media from its
  // URL, there is no FILE_UPLOAD / chunked upload variant of these endpoints.
  private buildVideoBody(businessId: string, firstPost: PostDetails<TikTokDto>) {
    const isDraft = this.contentPostingMethod(firstPost) === 'UPLOAD';

    return {
      business_id: businessId,
      video_url: firstPost?.media?.[0]?.path!,
      ...(firstPost?.media?.[0]?.thumbnail
        ? { custom_thumbnail_url: firstPost?.media?.[0]?.thumbnail }
        : firstPost?.media?.[0]?.thumbnailTimestamp
        ? { thumbnail_offset: firstPost?.media?.[0]?.thumbnailTimestamp }
        : {}),
      post_info: {
        ...(firstPost.message ? { caption: firstPost.message } : {}),
        // The video endpoint has no privacy_level field - unlike photos,
        // videos publish with the account default.
        is_brand_organic: this.assetBoolean(
          firstPost.settings.brand_organic_toggle
        ),
        is_branded_content: this.assetBoolean(
          firstPost.settings.brand_content_toggle
        ),
        ...(isDraft
          ? { upload_to_draft: true }
          : {
              disable_comment: !this.assetBoolean(firstPost.settings.comment),
              disable_duet: !this.assetBoolean(firstPost.settings.duet),
              disable_stitch: !this.assetBoolean(firstPost.settings.stitch),
              is_ai_generated: this.assetBoolean(
                firstPost.settings.video_made_with_ai
              ),
              ...(firstPost.settings.location?.id
                ? {
                    location_id: firstPost.settings.location.id,
                    location_name: firstPost.settings.location.name,
                  }
                : {}),
              // The API defaults both volumes to 0 (muted) - the TikTok app
              // defaults to 50, so a selected track without explicit volumes
              // follows the app behavior instead of publishing a silent post.
              ...(firstPost.settings.music?.id
                ? {
                    music_sound_info: {
                      music_sound_id: firstPost.settings.music.id,
                      music_sound_volume:
                        typeof firstPost.settings.music.audio_volume !==
                        'undefined'
                          ? +firstPost.settings.music.audio_volume
                          : 50,
                      video_original_sound_volume:
                        typeof firstPost.settings.music.video_volume !==
                        'undefined'
                          ? +firstPost.settings.music.video_volume
                          : 50,
                    },
                  }
                : {}),
            }),
      },
    };
  }

  // autoAddMusic picks a random commercial-library track instead of TikTok's
  // auto_add_music flag, so the attached music is chosen by Postiz rather than
  // silently by TikTok. Returns undefined when the trending list is empty or
  // unavailable - the photo body then falls back to auto_add_music.
  private async pickRandomMusicId(
    accessToken: string,
    businessId: string
  ): Promise<string | undefined> {
    const tracks = await this.musicSearch(accessToken, {}, businessId);
    if (!tracks.length) {
      return undefined;
    }
    return tracks[Math.floor(Math.random() * tracks.length)].id;
  }

  private async buildPhotoBody(
    businessId: string,
    firstPost: PostDetails<TikTokDto>,
    accessToken: string
  ) {
    const isDraft = this.contentPostingMethod(firstPost) === 'UPLOAD';

    // Random music wins over an explicitly selected track: the UI hides the
    // music selector while "add random music" is on, so a stale selection must
    // not silently override it.
    const musicId =
      firstPost.settings.autoAddMusic === 'yes'
        ? !isDraft
          ? await this.pickRandomMusicId(accessToken, businessId)
          : undefined
        : firstPost.settings.music?.id;

    return {
      business_id: businessId,
      photo_images: firstPost.media?.map((p) => p.path),
      photo_cover_index: 0,
      post_info: {
        ...(firstPost.settings.title
          ? { title: firstPost.settings.title.slice(0, 90) }
          : {}),
        ...(firstPost.message ? { caption: firstPost.message } : {}),
        is_brand_organic: this.assetBoolean(
          firstPost.settings.brand_organic_toggle
        ),
        is_branded_content: this.assetBoolean(
          firstPost.settings.brand_content_toggle
        ),
        ...(isDraft
          ? { is_draft: true }
          : {
              privacy_level:
                firstPost.settings.privacy_level || 'PUBLIC_TO_EVERYONE',
              disable_comment: !this.assetBoolean(firstPost.settings.comment),
              // TikTok's own recommended-music flag is only a fallback for
              // when no track could be picked from the trending list.
              auto_add_music:
                !musicId && firstPost.settings.autoAddMusic === 'yes',
              ...(firstPost.settings.location?.id
                ? {
                    location_id: firstPost.settings.location.id,
                    location_name: firstPost.settings.location.name,
                  }
                : {}),
              // Unlike videos, the photo music_sound_info has no volume fields.
              ...(musicId
                ? {
                    music_sound_info: {
                      music_sound_id: musicId,
                    },
                  }
                : {}),
            }),
      },
    };
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<TikTokDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const isPhoto = !hasExtension(firstPost?.media?.[0]?.path, 'mp4');

    const body = isPhoto
      ? await this.buildPhotoBody(id, firstPost, accessToken)
      : this.buildVideoBody(id, firstPost);

    const publish = await (
      await this.fetch(
        `${this.baseUrl}${
          isPhoto ? '/business/photo/publish/' : '/business/video/publish/'
        }`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Access-Token': accessToken,
          },
          body: JSON.stringify(body),
        }
      )
    ).json();

    // The Business API reports failures as HTTP 200 with a non-zero code, so
    // this.fetch cannot catch them - classify the body here.
    if (publish?.code !== 0 || !publish?.data?.share_id) {
      const asString = JSON.stringify(publish);
      const handleError = this.handleErrors(asString);
      if (handleError?.type === 'refresh-token') {
        throw new RefreshToken(
          'tiktok-business',
          asString,
          JSON.stringify(body),
          handleError.value
        );
      }
      if (handleError?.type === 'disconnect') {
        throw new Disconnect(
          'tiktok-business',
          asString,
          JSON.stringify(body),
          handleError.value
        );
      }
      throw new BadBody(
        'tiktok-business-error-upload',
        asString,
        Buffer.from(JSON.stringify(body)),
        handleError?.value || publish?.message || 'TikTok refused the post'
      );
    }

    // The publish is now irreversible on TikTok's side: return `pending` so the
    // workflow polls checkPostStatus instead of blocking (and possibly timing
    // out and re-posting) inside this activity.
    return [
      {
        id: firstPost.id,
        releaseURL: '',
        postId: '',
        status: 'pending',
        pendingData: { publishId: publish.data.share_id },
      },
    ];
  }

  // Old blocking behavior, kept for workflow versions before v1.0.6 that still
  // run and don't know how to resolve a `pending` response - they keep polling
  // inside the activity exactly like before.
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<TikTokDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [response] = await this.postPending(
      id,
      accessToken,
      postDetails,
      integration
    );

    const started = Date.now();

    for (const _ of Array(27).keys()) {
      // ~9 minutes at 20s interval
      const check = await this.checkPostStatus(
        accessToken,
        response.pendingData,
        integration
      );

      if (check.status === 'completed') {
        return [
          {
            id: response.id,
            releaseURL: check.releaseURL,
            postId: String(check.postId),
            status: 'success',
          },
        ];
      }

      // Cap below the 10-minute activity timeout of the old workflows using
      // this method: failing here (non-retryable) is safe, timing the activity
      // out is not - a retried activity would publish the post again.
      if (Date.now() - started > 8 * 60 * 1000) {
        break;
      }

      await timer(20000);
    }

    throw new BadBody(
      'tiktok-business-error-upload',
      JSON.stringify({}),
      Buffer.from(JSON.stringify({})),
      'TikTok refused to publish your post'
    );
  }

  // The trending list has no text search parameter - genre / country / date
  // range are the only filters - so the UI filters the returned list locally.
  @Tool({
    description:
      'Load commercial music library tracks that can be attached to a post via the "music" setting',
    dataSchema: [
      {
        key: 'genre',
        type: 'string',
        description:
          'Genre to filter the tracks by (for example POP, ROCK, ELECTRONIC), leave empty for all genres',
      },
    ],
  })
  async musicSearch(
    accessToken: string,
    data: { genre?: string },
    id: string
  ) {
    const music = await (
      await this.fetch(
        `${this.baseUrl}/discovery/cml/trending_list/?business_id=${encodeURIComponent(
          id
        )}${data?.genre ? `&genre=${encodeURIComponent(data.genre)}` : ''}`,
        {
          method: 'GET',
          headers: {
            'Access-Token': accessToken,
          },
        }
      )
    ).json();

    // Errors arrive as HTTP 200 with a non-zero code, invisible to this.fetch:
    // a token error must surface as RefreshToken so the function endpoint
    // refreshes and retries, anything else just returns no tracks.
    if (music?.code !== 0) {
      const asString = JSON.stringify(music);
      const handleError = this.handleErrors(asString);
      if (handleError?.type === 'refresh-token') {
        throw new RefreshToken('tiktok-business', asString, '{}', handleError.value);
      }
      return [];
    }

    return (music?.data?.list || [])
      .map((track: any) => ({
        // music_sound_id only accepts a song_clip_id: the publish endpoints
        // reject a commercial_music_id with the generic 51065 "Something is
        // wrong" error (verified against the live API). Chart tracks sometimes
        // have no full_duration_song_clip - their 30-day trending clip is the
        // only publishable id (tracks with neither are filtered out below).
        id:
          track?.full_duration_song_clip?.song_clip_id ||
          track?.trending_song_clip?.song_clip_id,
        title: track?.commercial_music_name || '',
        artist: track?.artist || '',
        image: track?.thumbnail_url || '',
        duration:
          (track?.duration || track?.trending_song_clip?.duration || 0) * 1000,
        previewUrl:
          track?.preview_url || track?.trending_song_clip?.preview_url || '',
      }))
      .filter((track: { id?: string }) => track.id);
  }

  @Tool({
    description:
      'Search location tags that can be attached to a post via the "location" setting',
    dataSchema: [
      {
        key: 'q',
        type: 'string',
        description: 'Search query for the location',
      },
    ],
  })
  async locationSearch(accessToken: string, data: { q: string }, id: string) {
    if (!data?.q) {
      return [];
    }

    const locations = await (
      await this.fetch(
        `${this.baseUrl}/business/publish/location/?business_id=${encodeURIComponent(
          id
        )}&search_query=${encodeURIComponent(data.q.slice(0, 100))}`,
        {
          method: 'GET',
          headers: {
            'Access-Token': accessToken,
          },
        }
      )
    ).json();

    // Same HTTP 200 + non-zero code envelope as musicSearch.
    if (locations?.code !== 0) {
      const asString = JSON.stringify(locations);
      const handleError = this.handleErrors(asString);
      if (handleError?.type === 'refresh-token') {
        throw new RefreshToken('tiktok-business', asString, '{}', handleError.value);
      }
      return [];
    }

    return (locations?.data?.locations || []).map((location: any) => ({
      id: location?.location_id,
      name: location?.location_name || '',
      address: location?.location_address || '',
    }));
  }

  private async loadVideoList(
    accessToken: string,
    businessId: string,
    fields: string[],
    stopBeforeUnix?: number,
    maxPages = 1
  ) {
    const allVideos: any[] = [];
    let cursor: number | string | undefined = undefined;

    for (let page = 0; page < maxPages; page++) {
      const cursorParam =
        cursor !== undefined && cursor !== null
          ? `&cursor=${encodeURIComponent(String(cursor))}`
          : '';
      const videoListData = await (
        await this.fetch(
          `${this.baseUrl}/business/video/list/?business_id=${encodeURIComponent(
            businessId
          )}&fields=${encodeURIComponent(
            JSON.stringify(fields)
          )}&max_count=20${cursorParam}`,
          {
            method: 'GET',
            headers: {
              'Access-Token': accessToken,
            },
          }
        )
      ).json();

      // Same HTTP 200 + non-zero code envelope: a token error must surface as
      // RefreshToken so the analytics/missing callers refresh and retry instead
      // of silently showing empty data until the user reconnects.
      this.throwIfTokenError(videoListData);

      if (videoListData?.code && videoListData.code !== 0) {
        if (page === 0) {
          throw new Error(
            videoListData?.message ||
              `TikTok Business video/list error (${videoListData.code})`
          );
        }
        break;
      }

      const batch: any[] = videoListData?.data?.videos || [];
      if (!batch.length) {
        break;
      }

      allVideos.push(...batch);

      const oldestInBatch = batch.reduce((min, v) => {
        const ts = Number(v.create_time) || 0;
        return ts > 0 && ts < min ? ts : min;
      }, Number.MAX_SAFE_INTEGER);

      if (
        !videoListData?.data?.has_more ||
        videoListData?.data?.cursor === undefined ||
        (stopBeforeUnix !== undefined &&
          oldestInBatch < Number.MAX_SAFE_INTEGER &&
          oldestInBatch < stopBeforeUnix)
      ) {
        break;
      }
      cursor = videoListData.data.cursor;
    }

    return allVideos;
  }

  private normalizePercentRate(raw: any): number {
    const val = Number(raw);
    if (!Number.isFinite(val) || val < 0) return 0;
    return val <= 1 ? Number((val * 100).toFixed(2)) : Number(val.toFixed(2));
  }

  // photo posts (p_pub_... / p_inbox_...) live under /photo/, TikTok rejects
  // /video/ for them
  private postUrl(integration: Integration, publishId: string, postId: string) {
    return `https://www.tiktok.com/@${integration.profile}/${
      publishId.indexOf('p_') === 0 ? 'photo' : 'video'
    }/${postId}`;
  }

  // post_ids holds int64 ids that exceed Number.MAX_SAFE_INTEGER, so the id
  // must be read from the raw body instead of the parsed JSON
  private publicPostId(body: string) {
    return body.match(/"post_ids"\s*:\s*\[\s*"?(\d+)"?/)?.[1];
  }

  private throwIfTokenError(body: { code?: number }) {
    if (body?.code === 0) {
      return;
    }
    const asString = JSON.stringify(body);
    const handleError = this.handleErrors(asString);
    if (handleError?.type === 'refresh-token') {
      throw new RefreshToken('tiktok-business', asString, '{}', handleError.value);
    }
    if (handleError?.type === 'disconnect') {
      throw new Disconnect('tiktok-business', asString, '{}', handleError.value);
    }
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const safeDays = Math.max(1, Math.min(365, Math.floor(date || 7)));
    const today = dayjs().format('YYYY-MM-DD');
    const sinceUnix = dayjs().subtract(safeDays, 'day').startOf('day').unix();
    const prevSinceUnix = dayjs()
      .subtract(safeDays * 2, 'day')
      .startOf('day')
      .unix();

    try {
      // 1. Core real-time account stats (always available with user.info.stats)
      const userStatsData = await (
        await this.fetch(
          `${this.baseUrl}/business/get/?business_id=${encodeURIComponent(
            id
          )}&fields=${encodeURIComponent(
            JSON.stringify([
              'followers_count',
              'following_count',
              'total_likes',
              'videos_count',
            ])
          )}`,
          {
            method: 'GET',
            headers: {
              'Access-Token': accessToken,
            },
          }
        )
      ).json();

      this.throwIfTokenError(userStatsData);

      const userStats = userStatsData?.data;
      const result: AnalyticsData[] = [];

      // 2. Optional Business Account daily metrics & audience demographics (chunked <= 58 days)
      const insightsBundle = await safeAnalyticsCall(
        'tiktok.business.get.insights',
        async () => {
          const windows = splitDateWindows(safeDays, 58);
          const dailyMetrics: any[] = [];
          let audienceCountries: any[] = [];
          let audienceGenders: any[] = [];

          for (const win of windows) {
            // TikTok Business insights lag ~24-48h; cap end_date at yesterday if needed
            const sDate = dayjs.unix(win.since).format('YYYY-MM-DD');
            const eDate = dayjs.unix(win.until).format('YYYY-MM-DD');
            const insData = await (
              await this.fetch(
                `${this.baseUrl}/business/get/?business_id=${encodeURIComponent(
                  id
                )}&start_date=${sDate}&end_date=${eDate}&fields=${encodeURIComponent(
                  JSON.stringify([
                    'metrics',
                    'audience_countries',
                    'audience_genders',
                  ])
                )}`,
                {
                  method: 'GET',
                  headers: {
                    'Access-Token': accessToken,
                  },
                }
              )
            ).json();
            this.throwIfTokenError(insData);
            if (insData?.code === 0 && insData?.data) {
              if (Array.isArray(insData.data.metrics)) {
                dailyMetrics.push(...insData.data.metrics);
              }
              if (Array.isArray(insData.data.audience_countries)) {
                audienceCountries = insData.data.audience_countries;
              }
              if (Array.isArray(insData.data.audience_genders)) {
                audienceGenders = insData.data.audience_genders;
              }
            }
          }
          return { dailyMetrics, audienceCountries, audienceGenders };
        },
        { dailyMetrics: [], audienceCountries: [], audienceGenders: [] }
      );

      if (userStats) {
        if (userStats.followers_count !== undefined) {
          result.push({
            label: 'Followers',
            percentageChange: 0,
            aggregation: 'latest',
            category: 'overview',
            data: [{ total: String(userStats.followers_count), date: today }],
          });
        }

        if (userStats.following_count !== undefined) {
          result.push({
            label: 'Following',
            percentageChange: 0,
            aggregation: 'latest',
            category: 'audience',
            data: [{ total: String(userStats.following_count), date: today }],
          });
        }

        if (userStats.total_likes !== undefined) {
          result.push({
            label: 'Total Likes',
            percentageChange: 0,
            aggregation: 'latest',
            category: 'engagement',
            data: [{ total: String(userStats.total_likes), date: today }],
          });
        }

        if (userStats.videos_count !== undefined) {
          result.push({
            label: 'Videos',
            percentageChange: 0,
            aggregation: 'latest',
            category: 'overview',
            data: [{ total: String(userStats.videos_count), date: today }],
          });
        }
      }

      if (insightsBundle.dailyMetrics.length > 0) {
        const pushBizDaily = (
          label: string,
          field: string,
          category: AnalyticsData['category'] = 'overview'
        ) => {
          const pts = mergeDailyPoints(
            insightsBundle.dailyMetrics
              .filter((m) => m?.date && m[field] !== undefined)
              .map((m) => ({
                date: String(m.date),
                total: Number(m[field]) || 0,
              }))
          );
          if (pts.length > 0) {
            result.push({
              label,
              percentageChange: 0,
              aggregation: 'sum',
              category,
              data: pts,
            });
          }
        };

        pushBizDaily('Profile Views', 'profile_views', 'overview');
        pushBizDaily('Engaged Audience', 'engaged_audience', 'audience');
      }

      // 3. Paginated video list with rich fields (falling back gracefully if extended fields fail)
      const loadRichVideos = async () => {
        try {
          return await this.loadVideoList(
            accessToken,
            id,
            [
              'item_id',
              'caption',
              'create_time',
              'thumbnail_url',
              'share_url',
              'video_duration',
              'likes',
              'comments',
              'shares',
              'video_views',
              'reach',
              'full_video_watched_rate',
              'average_time_watched',
            ],
            prevSinceUnix,
            5
          );
        } catch (err) {
          if (err instanceof RefreshToken || err instanceof Disconnect) {
            throw err;
          }
          try {
            return await this.loadVideoList(
              accessToken,
              id,
              [
                'item_id',
                'caption',
                'create_time',
                'thumbnail_url',
                'share_url',
                'likes',
                'comments',
                'shares',
                'video_views',
              ],
              prevSinceUnix,
              5
            );
          } catch (innerErr) {
            if (
              innerErr instanceof RefreshToken ||
              innerErr instanceof Disconnect
            ) {
              throw innerErr;
            }
            return await this.loadVideoList(
              accessToken,
              id,
              ['item_id', 'likes', 'comments', 'shares', 'video_views'],
              undefined,
              1
            );
          }
        }
      };

      const allVideos = await safeAnalyticsCall(
        'tiktok.business.video.list',
        loadRichVideos,
        []
      );

      if (allVideos && allVideos.length > 0) {
        const hasTimestamps = allVideos.some((v) => Number(v.create_time) > 0);
        const windowVideos = hasTimestamps
          ? allVideos.filter((v) => Number(v.create_time) >= sinceUnix)
          : allVideos;
        const prevWindowVideos = hasTimestamps
          ? allVideos.filter(
              (v) =>
                Number(v.create_time) >= prevSinceUnix &&
                Number(v.create_time) < sinceUnix
            )
          : [];

        const usingFallbackLatest =
          hasTimestamps && windowVideos.length === 0 && allVideos.length > 0;
        const activeVideos = usingFallbackLatest
          ? allVideos.slice(0, 20)
          : windowVideos;
        const fallbackNote = usingFallbackLatest
          ? `No new videos published in the last ${safeDays} days; showing latest ${activeVideos.length} videos`
          : undefined;

        const sumStats = (list: any[]) =>
          list.reduce(
            (acc, v) => {
              acc.views += Number(v.video_views) || 0;
              acc.reach += Number(v.reach) || 0;
              acc.likes += Number(v.likes) || 0;
              acc.comments += Number(v.comments) || 0;
              acc.shares += Number(v.shares) || 0;
              if (v.average_time_watched !== undefined) {
                acc.watchSum += Number(v.average_time_watched) || 0;
                acc.watchCount += 1;
              }
              if (v.full_video_watched_rate !== undefined) {
                acc.completionSum += this.normalizePercentRate(
                  v.full_video_watched_rate
                );
                acc.completionCount += 1;
              }
              return acc;
            },
            {
              views: 0,
              reach: 0,
              likes: 0,
              comments: 0,
              shares: 0,
              watchSum: 0,
              watchCount: 0,
              completionSum: 0,
              completionCount: 0,
            }
          );

        const currTotals = sumStats(activeVideos);
        const prevTotals =
          !usingFallbackLatest && prevWindowVideos.length > 0
            ? sumStats(prevWindowVideos)
            : undefined;

        const groupDaily = (list: any[], field: string) => {
          if (!list.length || usingFallbackLatest || !hasTimestamps) {
            return null;
          }
          const map = new Map<string, number>();
          for (const v of list) {
            const ts = Number(v.create_time) || 0;
            if (!ts) continue;
            const d = dayjs.unix(ts).format('YYYY-MM-DD');
            map.set(d, (map.get(d) || 0) + (Number(v[field]) || 0));
          }
          const pts = mergeDailyPoints(
            Array.from(map.entries()).map(([d, total]) => ({
              date: d,
              total,
            }))
          );
          return pts.length > 0 ? pts : null;
        };

        const bizDailyViews =
          insightsBundle.dailyMetrics.length > 0
            ? mergeDailyPoints(
                insightsBundle.dailyMetrics
                  .filter((m) => m?.date && m.video_views !== undefined)
                  .map((m) => ({
                    date: String(m.date),
                    total: Number(m.video_views) || 0,
                  }))
              )
            : [];

        result.push({
          label: 'Views',
          percentageChange: computePercentageChange(
            bizDailyViews.length > 0
              ? aggregatePoints(bizDailyViews, 'sum')
              : currTotals.views,
            prevTotals?.views
          ),
          aggregation: 'sum',
          category: 'overview',
          note: bizDailyViews.length > 0 ? undefined : fallbackNote,
          data:
            bizDailyViews.length > 0
              ? bizDailyViews
              : groupDaily(activeVideos, 'video_views') || [
                  { total: String(currTotals.views), date: today },
                ],
        });

        if (currTotals.reach > 0) {
          result.push({
            label: 'Reach',
            percentageChange: computePercentageChange(
              currTotals.reach,
              prevTotals?.reach
            ),
            aggregation: 'sum',
            category: 'overview',
            note: fallbackNote,
            data: groupDaily(activeVideos, 'reach') || [
              { total: String(currTotals.reach), date: today },
            ],
          });
        }

        result.push({
          label: 'Videos in Period',
          percentageChange: hasTimestamps
            ? computePercentageChange(
                windowVideos.length,
                prevWindowVideos.length || undefined
              )
            : 0,
          aggregation: 'latest',
          category: 'overview',
          data: [{ total: String(windowVideos.length), date: today }],
        });

        result.push({
          label: 'Recent Likes',
          percentageChange: computePercentageChange(
            currTotals.likes,
            prevTotals?.likes
          ),
          aggregation: 'sum',
          category: 'engagement',
          note: fallbackNote,
          data: groupDaily(activeVideos, 'likes') || [
            { total: String(currTotals.likes), date: today },
          ],
        });

        result.push({
          label: 'Recent Comments',
          percentageChange: computePercentageChange(
            currTotals.comments,
            prevTotals?.comments
          ),
          aggregation: 'sum',
          category: 'engagement',
          note: fallbackNote,
          data: groupDaily(activeVideos, 'comments') || [
            { total: String(currTotals.comments), date: today },
          ],
        });

        result.push({
          label: 'Recent Shares',
          percentageChange: computePercentageChange(
            currTotals.shares,
            prevTotals?.shares
          ),
          aggregation: 'sum',
          category: 'engagement',
          note: fallbackNote,
          data: groupDaily(activeVideos, 'shares') || [
            { total: String(currTotals.shares), date: today },
          ],
        });

        const currInteractions =
          currTotals.likes + currTotals.comments + currTotals.shares;
        const currEr =
          currTotals.views > 0
            ? Number(((currInteractions / currTotals.views) * 100).toFixed(2))
            : 0;
        const prevEr =
          prevTotals && prevTotals.views > 0
            ? Number(
                (
                  ((prevTotals.likes +
                    prevTotals.comments +
                    prevTotals.shares) /
                    prevTotals.views) *
                  100
                ).toFixed(2)
              )
            : undefined;

        result.push({
          label: 'Engagement Rate',
          average: true,
          unit: 'percent',
          aggregation: 'latest',
          category: 'engagement',
          note: fallbackNote,
          percentageChange: computePercentageChange(currEr, prevEr, true),
          data: [{ total: String(currEr), date: today }],
        });

        if (currTotals.watchCount > 0) {
          const avgWatch = Number(
            (currTotals.watchSum / currTotals.watchCount).toFixed(1)
          );
          const prevAvgWatch =
            prevTotals && prevTotals.watchCount > 0
              ? Number((prevTotals.watchSum / prevTotals.watchCount).toFixed(1))
              : undefined;
          result.push({
            label: 'Average Watch Time',
            average: true,
            unit: 'seconds',
            aggregation: 'latest',
            category: 'retention',
            note: fallbackNote,
            percentageChange: computePercentageChange(avgWatch, prevAvgWatch),
            data: [{ total: String(avgWatch), date: today }],
          });
        }

        if (currTotals.completionCount > 0) {
          const avgComp = Number(
            (currTotals.completionSum / currTotals.completionCount).toFixed(2)
          );
          const prevAvgComp =
            prevTotals && prevTotals.completionCount > 0
              ? Number(
                  (
                    prevTotals.completionSum / prevTotals.completionCount
                  ).toFixed(2)
                )
              : undefined;
          result.push({
            label: 'Completion Rate',
            average: true,
            unit: 'percent',
            aggregation: 'latest',
            category: 'retention',
            note: fallbackNote,
            percentageChange: computePercentageChange(
              avgComp,
              prevAvgComp,
              true
            ),
            data: [{ total: String(avgComp), date: today }],
          });
        }

        const postItems: AnalyticsPostItem[] = activeVideos
          .slice(0, 15)
          .map((v) => {
            const views = Number(v.video_views) || 0;
            const reach =
              v.reach !== undefined ? Number(v.reach) || 0 : undefined;
            const likes = Number(v.likes) || 0;
            const comments = Number(v.comments) || 0;
            const shares = Number(v.shares) || 0;
            const er =
              views > 0
                ? Number(
                    (((likes + comments + shares) / views) * 100).toFixed(2)
                  )
                : 0;
            const pubIso =
              Number(v.create_time) > 0
                ? dayjs.unix(Number(v.create_time)).toISOString()
                : today;

            return {
              id: String(v.item_id),
              title: summarizePostTitle(v.caption, `TikTok ${v.item_id}`),
              url: v.share_url ? String(v.share_url).split('?')[0] : undefined,
              thumbnail: v.thumbnail_url || undefined,
              publishedAt: pubIso,
              mediaType: 'VIDEO',
              views,
              reach,
              likes,
              comments,
              shares,
              engagementRate: er,
              avgWatchTimeSeconds:
                v.average_time_watched !== undefined
                  ? Number(Number(v.average_time_watched).toFixed(1))
                  : undefined,
            };
          });

        if (postItems.length > 0) {
          result.push({
            label: 'Recent Posts Performance',
            percentageChange: 0,
            category: 'posts',
            note: fallbackNote,
            posts: postItems,
            data: [{ total: String(currTotals.views), date: today }],
          });
        }
      }

      if (insightsBundle.audienceCountries.length > 0) {
        const breakdown = buildBreakdown(
          insightsBundle.audienceCountries.map((c: any) => ({
            label: String(c.country || ''),
            value: this.normalizePercentRate(c.percentage),
          })),
          10
        );
        if (breakdown.length > 0) {
          result.push({
            label: 'Followers by Country',
            percentageChange: 0,
            unit: 'percent',
            category: 'audience',
            breakdown,
            data: [{ total: '100', date: today }],
          });
        }
      }

      if (insightsBundle.audienceGenders.length > 0) {
        const breakdown = buildBreakdown(
          insightsBundle.audienceGenders.map((g: any) => ({
            label: String(g.gender || ''),
            value: this.normalizePercentRate(g.percentage),
          })),
          6
        );
        if (breakdown.length > 0) {
          result.push({
            label: 'Followers by Gender',
            percentageChange: 0,
            unit: 'percent',
            category: 'audience',
            breakdown,
            data: [{ total: '100', date: today }],
          });
        }
      }

      return result;
    } catch (err) {
      // The callers catch RefreshToken and retry with a refreshed token -
      // swallowing it here would leave the panel empty until a manual reconnect.
      if (err instanceof RefreshToken || err instanceof Disconnect) {
        throw err;
      }
      console.error('Error fetching TikTok Business analytics:', err);
      return [];
    }
  }

  async missing(
    id: string,
    accessToken: string
  ): Promise<{ id: string; url: string }[]> {
    try {
      const videos = await this.loadVideoList(accessToken, id, [
        'item_id',
        'thumbnail_url',
      ]);

      if (!videos || videos.length === 0) {
        return [];
      }

      return videos.map((v: { item_id: string; thumbnail_url: string }) => ({
        id: String(v.item_id),
        url: v.thumbnail_url,
      }));
    } catch (err) {
      if (err instanceof RefreshToken || err instanceof Disconnect) {
        throw err;
      }
      console.error('Error fetching TikTok Business missing content:', err);
      return [];
    }
  }

  // Posts saved before post_ids became available keep their share_id
  // (v_pub_... / p_pub_...) as releaseId - resolve it to the public post id
  async resolveReleaseId(
    accessToken: string,
    releaseId: string,
    integration: Integration,
    settings: any,
    releaseURL: string
  ) {
    // a draft sent to the inbox (UPLOAD) is stored as 'missing' with its
    // share id in the URL fragment
    const draft = releaseId === 'missing';
    const publishId = draft ? releaseURL?.split('#')[1] || '' : releaseId;
    if (
      publishId.indexOf('_pub_') === -1 &&
      publishId.indexOf('_inbox_') === -1
    ) {
      return undefined;
    }

    // privacy_level only applies to photo posts here (and not to a draft, the
    // user picks it in the app), and TikTok only gives a post id to posts
    // published for public viewership
    if (
      !draft &&
      publishId.indexOf('p_pub_') === 0 &&
      ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS'].includes(settings?.privacy_level)
    ) {
      return { unavailable: true as const };
    }

    const body = await (
      await this.fetch(
        `${this.baseUrl}/business/publish/status/?business_id=${encodeURIComponent(
          integration.internalId
        )}&publish_id=${encodeURIComponent(publishId)}`,
        {
          method: 'GET',
          headers: {
            'Access-Token': accessToken,
          },
        }
      )
    ).text();

    this.throwIfTokenError(JSON.parse(body));

    const publicPostId = this.publicPostId(body);
    if (!publicPostId) {
      // a draft with no public post (not published yet, or published as
      // non-public) keeps opening the inbox instead of asking to retry
      return draft ? undefined : { pending: true as const };
    }

    return {
      postId: publicPostId,
      releaseURL: this.postUrl(integration, publishId, publicPostId),
    };
  }

  // a post connected by hand: /video/<id> also reaches photo posts, TikTok
  // redirects it to /photo/<id>
  async releaseUrl(
    accessToken: string,
    releaseId: string,
    integration: Integration
  ) {
    return `https://www.tiktok.com/@${integration.profile}/video/${releaseId}`;
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    fromDate: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');

    try {
      const fetchSingleVideo = async (fields: string[]) => {
        const videoQueryData = await (
          await this.fetch(
            `${this.baseUrl}/business/video/list/?business_id=${encodeURIComponent(
              integrationId
            )}&fields=${encodeURIComponent(
              JSON.stringify(fields)
            )}&filters=${encodeURIComponent(
              JSON.stringify({ video_ids: [postId] })
            )}`,
            {
              method: 'GET',
              headers: {
                'Access-Token': accessToken,
              },
            }
          )
        ).json();
        this.throwIfTokenError(videoQueryData);
        return videoQueryData;
      };

      let videoQueryData = await fetchSingleVideo([
        'item_id',
        'caption',
        'create_time',
        'video_duration',
        'likes',
        'comments',
        'shares',
        'video_views',
        'reach',
        'full_video_watched_rate',
        'average_time_watched',
        'total_time_watched',
        'new_followers',
        'profile_views',
        'impression_sources',
      ]);

      if (videoQueryData?.code && videoQueryData.code !== 0) {
        videoQueryData = await fetchSingleVideo([
          'item_id',
          'likes',
          'comments',
          'shares',
          'video_views',
        ]);
      }

      const video = videoQueryData?.data?.videos?.[0];

      if (!video) {
        return [];
      }

      const result: AnalyticsData[] = [];
      const views = Number(video.video_views) || 0;
      const likes = Number(video.likes) || 0;
      const comments = Number(video.comments) || 0;
      const shares = Number(video.shares) || 0;
      const totalInteractions = likes + comments + shares;

      if (video.video_views !== undefined) {
        result.push({
          label: 'Views',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'overview',
          data: [{ total: String(video.video_views), date: today }],
        });
      }

      if (video.reach !== undefined) {
        result.push({
          label: 'Reach',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'overview',
          data: [{ total: String(video.reach), date: today }],
        });
      }

      if (video.likes !== undefined) {
        result.push({
          label: 'Likes',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'engagement',
          data: [{ total: String(video.likes), date: today }],
        });
      }

      if (video.comments !== undefined) {
        result.push({
          label: 'Comments',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'engagement',
          data: [{ total: String(video.comments), date: today }],
        });
      }

      if (video.shares !== undefined) {
        result.push({
          label: 'Shares',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'engagement',
          data: [{ total: String(video.shares), date: today }],
        });
      }

      result.push({
        label: 'Total Interactions',
        percentageChange: 0,
        aggregation: 'latest',
        category: 'engagement',
        data: [{ total: String(totalInteractions), date: today }],
      });

      if (views > 0) {
        const er = Number(((totalInteractions / views) * 100).toFixed(2));
        result.push({
          label: 'Engagement Rate',
          average: true,
          unit: 'percent',
          aggregation: 'latest',
          category: 'engagement',
          percentageChange: 0,
          data: [{ total: String(er), date: today }],
        });
      }

      if (video.average_time_watched !== undefined) {
        result.push({
          label: 'Average Watch Time',
          average: true,
          unit: 'seconds',
          aggregation: 'latest',
          category: 'retention',
          percentageChange: 0,
          data: [
            {
              total: String(
                Number((Number(video.average_time_watched) || 0).toFixed(1))
              ),
              date: today,
            },
          ],
        });
      }

      if (
        video.total_time_watched !== undefined &&
        Number(video.total_time_watched) > 0
      ) {
        const totalMin = Number(
          ((Number(video.total_time_watched) || 0) / 60).toFixed(2)
        );
        result.push({
          label: 'Total Watch Time',
          unit: 'minutes',
          aggregation: 'latest',
          category: 'retention',
          percentageChange: 0,
          data: [{ total: String(totalMin), date: today }],
        });
      }

      if (video.full_video_watched_rate !== undefined) {
        const completionPct = this.normalizePercentRate(
          video.full_video_watched_rate
        );
        result.push({
          label: 'Completion Rate',
          average: true,
          unit: 'percent',
          aggregation: 'latest',
          category: 'retention',
          percentageChange: 0,
          data: [{ total: String(completionPct), date: today }],
        });
      }

      if (video.new_followers !== undefined) {
        result.push({
          label: 'New Followers',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'audience',
          data: [{ total: String(video.new_followers), date: today }],
        });
      }

      if (video.profile_views !== undefined) {
        result.push({
          label: 'Profile Views',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'overview',
          data: [{ total: String(video.profile_views), date: today }],
        });
      }

      if (
        Array.isArray(video.impression_sources) &&
        video.impression_sources.length > 0
      ) {
        const breakdown = buildBreakdown(
          video.impression_sources.map((src: any) => ({
            label: String(src.impression_source || src.source || ''),
            value: this.normalizePercentRate(src.percentage),
          })),
          10
        );
        if (breakdown.length > 0) {
          result.push({
            label: 'Traffic Sources',
            percentageChange: 0,
            unit: 'percent',
            category: 'traffic',
            breakdown,
            data: [{ total: '100', date: today }],
          });
        }
      }

      return result;
    } catch (err: any) {
      if (err instanceof RefreshToken || err instanceof Disconnect) {
        throw err;
      }
      console.error(
        'Error fetching TikTok Business post analytics:',
        err?.cause?.code || err?.message || err
      );
      return [];
    }
  }
}
