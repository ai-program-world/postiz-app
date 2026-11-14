import {
  AnalyticsData,
  AnalyticsPostItem,
  AnalyticsSnapshotData,
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { Integration } from '@prisma/client';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library/build/src/auth/oauth2client';
import { YoutubeSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.settings.dto';
import {
  BadBody,
  Disconnect,
  PublishedWithError,
  RefreshToken,
  SocialAbstract,
  ValidityMedia,
  rangeReadFailure,
  stripQuery,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  aggregatePoints,
  buildBreakdown,
  computePercentageChange,
  safeAnalyticsCall,
  summarizePostTitle,
} from '@gitroom/nestjs-libraries/integrations/social/analytics.helper';
import * as process from 'node:process';
import dayjs from 'dayjs';
import { createReadStream, statSync } from 'fs';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { setHeartbeatDetails } from '@gitroom/nestjs-libraries/temporal/temporal.heartbeat';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { DashboardFunction } from '@gitroom/nestjs-libraries/integrations/dashboard.function.decorator';

const clientAndYoutube = () => {
  const client = new google.auth.OAuth2({
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri: `${process.env.FRONTEND_URL}/integrations/social/youtube`,
  });

  const youtube = (newClient: OAuth2Client) =>
    google.youtube({
      version: 'v3',
      auth: newClient,
    });

  const youtubeAnalytics = (newClient: OAuth2Client) =>
    google.youtubeAnalytics({
      version: 'v2',
      auth: newClient,
    });

  const oauth2 = (newClient: OAuth2Client) =>
    google.oauth2({
      version: 'v2',
      auth: newClient,
    });

  return { client, youtube, oauth2, youtubeAnalytics };
};

@Rules('YouTube must have on video attachment, it cannot be empty')
export class YoutubeProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 200; // YouTube has strict upload quotas
  identifier = 'youtube';
  name = 'YouTube';
  isBetweenSteps = true;
  dto = YoutubeSettingsDto;
  scopes = [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtubepartner',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
  ];

  editor = 'normal' as const;
  maxLength() {
    return 5000;
  }

  override async checkValidity(
    items: Array<ValidityMedia[]>
  ): Promise<string | true> {
    const [firstItems] = items ?? [];
    if (items?.[0]?.length !== 1) {
      return 'You need one media';
    }
    if ((firstItems?.[0]?.path?.indexOf?.('mp4') ?? -1) === -1) {
      return 'Item must be a video';
    }
    return true;
  }

  override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body';
        value: string;
      }
    | undefined {
    if (body.includes('invalidTags')) {
      return {
        type: 'bad-body',
        value: 'The maximum allowed is 500 characters in total.',
      };
    }

    if (body.includes('invalidTitle')) {
      return {
        type: 'bad-body',
        value:
          'We have uploaded your video but we could not set the title. Title is too long.',
      };
    }

    if (body.includes('invalidDescription')) {
      return {
        type: 'bad-body',
        value:
          'Your video description is invalid, it may contain disallowed characters such as < or >.',
      };
    }

    if (body.includes('invalidCategoryId')) {
      return {
        type: 'bad-body',
        value: 'The selected video category is invalid.',
      };
    }

    if (body.includes('invalidPublishAt')) {
      return {
        type: 'bad-body',
        value: 'The scheduled publishing time is invalid.',
      };
    }

    if (body.includes('invalidRecordingDetails')) {
      return {
        type: 'bad-body',
        value: 'The recording details for the video are invalid.',
      };
    }

    if (body.includes('invalidVideoGameRating')) {
      return {
        type: 'bad-body',
        value: 'The video game rating is invalid.',
      };
    }

    if (body.includes('invalidFilename')) {
      return {
        type: 'bad-body',
        value: 'The video file name is invalid.',
      };
    }

    if (body.includes('defaultLanguageNotSet')) {
      return {
        type: 'bad-body',
        value:
          'We could not set the localized video details because no default language is set.',
      };
    }

    if (body.includes('invalidVideoMetadata')) {
      return {
        type: 'bad-body',
        value:
          'Some of the video details are invalid, please review the title, description and tags.',
      };
    }

    if (body.includes('mediaBodyRequired')) {
      return {
        type: 'bad-body',
        value:
          'The video file is missing or could not be read, please re-upload the video.',
      };
    }

    if (body.includes('imageFormatUnsupported')) {
      return {
        type: 'bad-body',
        value:
          'We have uploaded your video but the thumbnail format is not supported, please use JPEG or PNG.',
      };
    }

    if (body.includes('imageTooTall')) {
      return {
        type: 'bad-body',
        value:
          'We have uploaded your video but the thumbnail image is too tall.',
      };
    }

    if (body.includes('imageTooWide')) {
      return {
        type: 'bad-body',
        value:
          'We have uploaded your video but the thumbnail image is too wide.',
      };
    }

    if (body.includes('defaultVideoInsertPerDayPerProject')) {
      return {
        type: 'bad-body',
        value:
          "YouTube's daily upload quota is exhausted for today, please reschedule this post for a later time.",
      };
    }

    if (body.includes('rateLimitExceeded')) {
      return {
        type: 'bad-body',
        value:
          'You are sending requests too quickly, please wait a little while and try again.',
      };
    }

    if (body.includes('failedPrecondition')) {
      return {
        type: 'bad-body',
        value:
          'We have uploaded your video but we could not set the thumbnail. Thumbnail size is too large.',
      };
    }

    if (body.includes('uploadLimitExceeded')) {
      return {
        type: 'bad-body',
        value:
          'You have reached your daily upload limit, please try again tomorrow.',
      };
    }

    if (body.includes('youtubeSignupRequired')) {
      return {
        type: 'bad-body',
        value:
          'You have to link your youtube account to your google account first.',
      };
    }

    if (body.includes('youtube.thumbnail')) {
      return {
        type: 'bad-body',
        value:
          'Your video was uploaded to YouTube successfully, but we could not set the thumbnail: custom thumbnails require a phone-verified YouTube channel. Verify your channel at youtube.com/verify, and set this video\'s thumbnail manually in YouTube Studio.',
      };
    }

    if (body.includes('Unauthorized')) {
      return {
        type: 'refresh-token',
        value:
          'Token expired or invalid, please reconnect your YouTube account.',
      };
    }

    if (body.includes('UNAUTHENTICATED') || body.includes('invalid_grant')) {
      return {
        type: 'refresh-token',
        value: 'Please re-authenticate your YouTube account',
      };
    }

    return undefined;
  }

  refreshErrorMessage(err: any): string | undefined {
    const data = err?.response?.data || {};
    const text = `${data.error_subtype || ''} ${data.error_description || ''} ${
      err?.message || ''
    }`;

    if (text.includes('invalid_rapt')) {
      return `because your organization's Google Workspace session policy invalidated its access. Ask your Google Workspace admin to mark Postiz as a trusted app and turn on "Exempt trusted apps" (https://support.google.com/a/answer/9368756) to prevent this from happening again`;
    }

    return undefined;
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    const { client, oauth2 } = clientAndYoutube();
    client.setCredentials({ refresh_token });
    const { credentials } = await client.refreshAccessToken();
    const user = oauth2(client);
    const expiryDate = new Date(credentials.expiry_date!);
    const unixTimestamp =
      Math.floor(expiryDate.getTime() / 1000) -
      Math.floor(new Date().getTime() / 1000);

    const { data } = await user.userinfo.get();

    return {
      accessToken: credentials.access_token!,
      expiresIn: unixTimestamp!,
      refreshToken: credentials.refresh_token ?? refresh_token,
      id: data.id!,
      name: data.name!,
      picture: data?.picture || '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeSecureId(7);
    const { client } = clientAndYoutube();
    return {
      url: client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        state,
        redirect_uri: `${process.env.FRONTEND_URL}/integrations/social/youtube`,
        scope: this.scopes.slice(0),
      }),
      codeVerifier: makeSecureId(11),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const { client, oauth2 } = clientAndYoutube();
    const { tokens } = await client.getToken(params.code);
    client.setCredentials(tokens);
    const { scopes } = await client.getTokenInfo(tokens.access_token!);
    this.checkScopes(this.scopes, scopes);

    const user = oauth2(client);
    const { data } = await user.userinfo.get();

    const expiryDate = new Date(tokens.expiry_date!);
    const unixTimestamp =
      Math.floor(expiryDate.getTime() / 1000) -
      Math.floor(new Date().getTime() / 1000);

    return {
      accessToken: tokens.access_token!,
      expiresIn: unixTimestamp,
      refreshToken: tokens.refresh_token!,
      id: data.id!,
      name: data.name!,
      picture: data?.picture || '',
      username: '',
    };
  }

  @DashboardFunction()
  async pages(accessToken: string) {
    const { client, youtube } = clientAndYoutube();
    client.setCredentials({ access_token: accessToken });
    const youtubeClient = youtube(client);

    try {
      // Get all channels the user has access to
      const response = await youtubeClient.channels.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        mine: true,
      });

      const channels = response.data.items || [];

      return channels.map((channel) => ({
        id: channel.id!,
        name: channel.snippet?.title || 'Unnamed Channel',
        picture: {
          data: {
            url: channel.snippet?.thumbnails?.default?.url || '',
          },
        },
        username: channel.snippet?.customUrl || '',
        subscriberCount: channel.statistics?.subscriberCount || '0',
      }));
    } catch (error) {
      console.error('Failed to fetch YouTube channels:', error);
      return [];
    }
  }

  async fetchPageInformation(accessToken: string, data: { id: string }) {
    const { client, youtube } = clientAndYoutube();
    client.setCredentials({ access_token: accessToken });
    const youtubeClient = youtube(client);

    try {
      const response = await youtubeClient.channels.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        id: [data.id],
      });

      const channel = response.data.items?.[0];

      if (!channel) {
        throw new Error('Channel not found');
      }

      return {
        id: channel.id!,
        name: channel.snippet?.title || 'Unnamed Channel',
        access_token: accessToken,
        picture: channel.snippet?.thumbnails?.default?.url || '',
        username: channel.snippet?.customUrl || '',
      };
    } catch (error) {
      console.error('Failed to fetch YouTube channel information:', error);
      throw error;
    }
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const { client, youtube } = clientAndYoutube();
    client.setCredentials({ access_token: accessToken });

    // don't go through pages() here, it swallows the real Google error and an
    // empty list would be reported as a missing channel
    const { data } = await youtube(client).channels.list({
      part: ['id'],
      mine: true,
    });

    if (!(data.items || []).some((p) => p.id === requiredId)) {
      throw new Error('Channel not found');
    }

    const information = await this.fetchPageInformation(accessToken, {
      id: requiredId,
    });

    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  // ---------------------------------------------------------------------------
  // RESUMABLE UPLOAD (no more videos.insert): YouTube only creates the video
  // resource when the final byte of the session is received, so a failed or
  // retried upload can never leave a video behind - and the session URI can
  // always be asked whether the video was created (the "unknown outcome" cure).
  // ---------------------------------------------------------------------------
  // YouTube requires chunk sizes to be a multiple of 256KB (except the last).
  private static readonly YOUTUBE_CHUNK_SIZE = 8 * 1024 * 1024;
  // Keep each upload batch well below the 10-minute activity timeout, the
  // workflow calls finalizePost again for the remaining bytes.
  private static readonly YOUTUBE_UPLOAD_BATCH_MS = 4 * 60 * 1000;

  // Resolves the total byte size of the media without loading it into memory:
  // a HEAD request for remote URLs, statSync for local files.
  private async youtubeMediaSize(path: string): Promise<number> {
    if (path.indexOf('http') === 0) {
      // the media path is user-influenced, keep the SSRF-safe dispatcher that
      // this.fetch applies to every other outbound request. identity encoding
      // so content-length matches the bytes a later GET actually streams
      // (fetch transparently decompresses encoded bodies).
      setHeartbeatDetails(`youtube: media size ${stripQuery(path)}`);
      const head = await fetch(path, {
        method: 'HEAD',
        headers: { 'accept-encoding': 'identity' },
        dispatcher: getSsrfSafeDispatcher(),
      } as any);
      const length = head.headers.get('content-length');
      if (!length) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          'Could not determine the video size for the YouTube upload'
        );
      }
      return Number(length);
    }

    return statSync(this.localMediaPath(path, this.identifier)).size;
  }

  // Returns a streaming body for the [start, end] byte range of the media so we
  // never hold the whole file in memory: a ranged GET for remote URLs, a ranged
  // read stream for local files.
  private async youtubeChunkStream(path: string, start: number, end: number) {
    if (path.indexOf('http') === 0) {
      // identity encoding so the store keeps content-length and can answer
      // with the requested range: a transformed (compressed) response loses
      // its length, and a length-less object is answered with the full body.
      setHeartbeatDetails(
        `youtube: read media ${start}-${end} ${stripQuery(path)}`
      );
      const response = await fetch(path, {
        headers: {
          Range: `bytes=${start}-${end}`,
          'accept-encoding': 'identity',
        },
        dispatcher: getSsrfSafeDispatcher(),
      } as any);

      // A store that ignores Range (200 with the full file) or answers with an
      // error page would corrupt the upload at this offset.
      if (response.status !== 206) {
        await response.body?.cancel().catch(() => {});
        throw new BadBody(
          this.identifier,
          rangeReadFailure(response),
          '{}',
          'The media storage did not return the requested byte range, please try again'
        );
      }

      return response.body;
    }

    return createReadStream(this.localMediaPath(path, this.identifier), {
      start,
      end,
    });
  }

  // Asks the upload session for the truth: the created video when the upload
  // completed, or the exact byte offset to resume from. We use the global fetch
  // because the probe answers with 308 (Resume Incomplete), which this.fetch
  // would treat as an error.
  private async probeUploadSession(
    accessToken: string,
    uploadUri: string,
    videoSize: number
  ): Promise<{ videoId: string } | { uploadedBytes: number }> {
    setHeartbeatDetails('youtube: probe resumable session');
    const probe = await fetch(uploadUri, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Range': `bytes */${videoSize}`,
      },
    });

    if (probe.status === 200 || probe.status === 201) {
      const { id } = await probe.json();
      return { videoId: String(id) };
    }

    if (probe.status === 308) {
      const range = probe.headers.get('range');
      return {
        uploadedBytes: range ? Number(range.split('-')[1]) + 1 : 0,
      };
    }

    const text = await probe.text().catch(() => '{}');

    // Transient Google-side errors: the session stays resumable, so throw a
    // plain error - the caller treats it as "probe again later" instead of
    // permanently failing a resumable upload.
    if (probe.status === 429 || probe.status >= 500) {
      throw new Error(
        `YouTube upload status check failed with ${probe.status}`
      );
    }

    const handleError = this.handleErrors(text);

    // this.fetch has the same 401 fallback: Google 401 bodies don't always
    // match the handleErrors strings
    if (probe.status === 401 || handleError?.type === 'refresh-token') {
      throw new RefreshToken(this.identifier, text, '{}');
    }

    throw new BadBody(
      this.identifier,
      text,
      '{}',
      probe.status === 404 || probe.status === 410
        ? 'The upload session expired before the video was uploaded, please post again'
        : handleError?.value || 'Failed to check the video upload status'
    );
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost, ...comments] = postDetails;

    const { settings }: { settings: YoutubeSettingsDto } = firstPost;
    const path = firstPost?.media?.[0]?.path!;
    const videoSize = await this.youtubeMediaSize(path);

    // Start a resumable upload session: nothing exists on the channel until
    // the final byte is received, so nothing here is irreversible yet - the
    // bytes themselves are streamed by finalizePost, outside this activity.
    const session = await this.fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=id,snippet,status&notifySubscribers=true',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(videoSize),
        },
        body: JSON.stringify({
          snippet: {
            title: settings.title,
            description: firstPost?.message,
            ...(settings?.tags?.length
              ? { tags: settings.tags.map((p) => p.label) }
              : {}),
          },
          status: {
            privacyStatus: settings.type,
            selfDeclaredMadeForKids: settings.selfDeclaredMadeForKids === 'yes',
          },
        }),
      }
    );

    const uploadUri = session.headers.get('location');
    if (!uploadUri) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Could not start the video upload, please try again'
      );
    }

    return [
      {
        id: firstPost.id,
        releaseURL: '',
        postId: '',
        status: 'pending',
        pendingData: {
          uploadUri,
          videoSize,
          path,
          uploadedBytes: 0,
          // the YouTube setting wins, so posts that set both keep publishing
          // with the one they always had
          thumbnail:
            settings?.thumbnail?.path || firstPost?.media?.[0]?.thumbnail || '',
          postDbId: firstPost.id,
        },
      },
    ];
  }

  override async checkPostStatus(
    accessToken: string,
    pendingData: {
      uploadUri: string;
      videoSize: number;
      path: string;
      uploadedBytes: number;
      thumbnail: string;
      videoId?: string;
      postDbId?: string;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    let probe: { videoId: string } | { uploadedBytes: number };
    try {
      probe = await this.probeUploadSession(
        accessToken,
        pendingData.uploadUri,
        pendingData.videoSize
      );
    } catch (err) {
      if (err instanceof RefreshToken || err instanceof BadBody) {
        throw err;
      }

      // transient network error, the workflow will check again
      return { status: 'pending', pendingData };
    }

    // the upload completed: the video exists, only the thumbnail may be left
    if ('videoId' in probe) {
      if (pendingData.thumbnail) {
        return {
          status: 'ready',
          pendingData: { ...pendingData, videoId: probe.videoId },
        };
      }

      return {
        status: 'completed',
        postId: probe.videoId,
        releaseURL: `https://www.youtube.com/watch?v=${probe.videoId}`,
      };
    }

    // bytes are still missing, finalizePost resumes from the exact offset
    return {
      status: 'ready',
      pendingData: { ...pendingData, uploadedBytes: probe.uploadedBytes },
    };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: {
      uploadUri: string;
      videoSize: number;
      path: string;
      uploadedBytes: number;
      thumbnail: string;
      videoId?: string;
      postDbId?: string;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    let videoId = pendingData.videoId;

    if (!videoId) {
      // ask the session for the truth before sending anything - a previous
      // run may have died mid-chunk, or even completed without us knowing
      const probe = await this.probeUploadSession(
        accessToken,
        pendingData.uploadUri,
        pendingData.videoSize
      );

      if ('uploadedBytes' in probe) {
        const started = Date.now();
        let uploaded = probe.uploadedBytes;

        while (uploaded < pendingData.videoSize) {
          // batch budget exhausted: hand back to the workflow, the next
          // finalizePost resumes from the offset the session reports
          if (Date.now() - started > YoutubeProvider.YOUTUBE_UPLOAD_BATCH_MS) {
            return {
              status: 'pending',
              pendingData: { ...pendingData, uploadedBytes: uploaded },
            };
          }

          const end =
            Math.min(
              uploaded + YoutubeProvider.YOUTUBE_CHUNK_SIZE,
              pendingData.videoSize
            ) - 1;
          const body = await this.youtubeChunkStream(
            pendingData.path,
            uploaded,
            end
          );

          setHeartbeatDetails('youtube: upload chunk to google');
          const upload = await fetch(pendingData.uploadUri, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'video/mp4',
              'Content-Length': String(end - uploaded + 1),
              'Content-Range': `bytes ${uploaded}-${end}/${pendingData.videoSize}`,
            },
            body,
            // Required by undici when streaming a request body.
            duplex: 'half',
          } as any);

          // more bytes expected, resume from the offset the session reports
          if (upload.status === 308) {
            const range = upload.headers.get('range');
            if (!range) {
              // no committed range reported: don't guess the offset, let the
              // next probe find the truth
              return {
                status: 'pending',
                pendingData: { ...pendingData, uploadedBytes: uploaded },
              };
            }
            uploaded = Number(range.split('-')[1]) + 1;
            continue;
          }

          // final chunk received: the video now exists on the channel
          if (upload.status === 200 || upload.status === 201) {
            const { id } = await upload.json();
            videoId = String(id);
            break;
          }

          const text = await upload.text().catch(() => '{}');

          // Transient Google-side errors: the session stays resumable, a plain
          // error makes the workflow probe and resume instead of failing the
          // whole upload.
          if (upload.status === 429 || upload.status >= 500) {
            throw new Error(
              `YouTube chunk upload failed with ${upload.status}`
            );
          }

          const handleError = this.handleErrors(text);

          if (upload.status === 401 || handleError?.type === 'refresh-token') {
            throw new RefreshToken(this.identifier, text, '{}');
          }

          throw new BadBody(
            this.identifier,
            text,
            '{}',
            handleError?.value || 'Failed to upload the video to YouTube'
          );
        }

        if (!videoId) {
          // all bytes sent without a confirmation, the next check asks the session
          return {
            status: 'pending',
            pendingData: { ...pendingData, uploadedBytes: uploaded },
          };
        }
      } else {
        videoId = probe.videoId;
      }
    }

    const releaseURL = `https://www.youtube.com/watch?v=${videoId}`;

    if (pendingData.thumbnail) {
      const { client, youtube } = clientAndYoutube();
      client.setCredentials({ access_token: accessToken });
      const youtubeClient = youtube(client);

      try {
        await this.runInConcurrent(async () =>
          youtubeClient.thumbnails.set({
            videoId,
            media: {
              body: (
                await this.getSsrfSafeAxios()({
                  url: pendingData.thumbnail,
                  method: 'GET',
                  responseType: 'stream',
                })
              ).data,
            },
          })
        );
      } catch (err) {
        // the video is already live: a rejected thumbnail must not lose its id
        // and URL (a token problem is left to the refresh + retry path, the
        // thumbnail call is idempotent)
        if (err instanceof BadBody && pendingData.postDbId) {
          throw new PublishedWithError(
            this.identifier,
            pendingData.postDbId,
            videoId,
            releaseURL,
            err.message
          );
        }
        throw err;
      }
    }

    return {
      status: 'completed',
      postId: videoId,
      releaseURL,
    };
  }

  // Old blocking behavior, kept for workflow versions before v1.0.6 that still
  // run and don't know how to resolve a `pending` response - they upload and
  // set the thumbnail inside the activity like before.
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
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
      // this method, leaving room for one more full upload batch: failing here
      // is safe (no video exists until the upload completes and the abandoned
      // session just expires), timing the activity out is not.
      if (
        Date.now() - started >
        8 * 60 * 1000 - YoutubeProvider.YOUTUBE_UPLOAD_BATCH_MS
      ) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          'The video upload took too long, please try a smaller video'
        );
      }

      const finalize = await this.finalizePost(
        accessToken,
        pendingData,
        integration
      );

      if (finalize.status === 'completed') {
        return [
          {
            id: response.id,
            releaseURL: finalize.releaseURL,
            postId: finalize.postId,
            status: 'success',
          },
        ];
      }

      pendingData = finalize.pendingData;
    }
  }

  private rethrowYoutubeAuthError(err: any) {
    if (err instanceof RefreshToken || err instanceof Disconnect) {
      throw err;
    }
    const status = err?.response?.status ?? err?.code;
    if (status === 401) {
      throw new RefreshToken(
        this.identifier,
        JSON.stringify(err?.response?.data || {}),
        '{}'
      );
    }
  }

  private formatYoutubeTrafficSource(source: string): string {
    const labels: Record<string, string> = {
      YT_SEARCH: 'YouTube Search',
      SHORTS: 'Shorts Feed',
      SUBSCRIBER: 'Browse / Subscriptions',
      RELATED_VIDEO: 'Suggested Videos',
      EXT_URL: 'External',
      YT_CHANNEL: 'Channel Pages',
      YT_OTHER_PAGE: 'Other YouTube Features',
      NO_LINK_OTHER: 'Direct or Unknown',
      PLAYLIST: 'Playlists',
      NOTIFICATION: 'Notifications',
      END_SCREEN: 'End Screens',
      INFO_CARDS: 'Cards & Annotations',
      ADVERTISING: 'YouTube Advertising',
      HASHTAGS: 'Hashtag Pages',
      SOUND_PAGE: 'Sound Pages',
    };
    return labels[source] || source;
  }

  private formatYoutubeDimension(value: string): string {
    const labels: Record<string, string> = {
      SHORTS: 'Shorts',
      VIDEO_ON_DEMAND: 'Videos',
      LIVE_STREAM: 'Live',
      STORY: 'Stories',
      UNSPECIFIED: 'Unspecified',
      SUBSCRIBED: 'Subscribed',
      UNSUBSCRIBED: 'Not Subscribed',
      MOBILE: 'Mobile',
      DESKTOP: 'Desktop',
      TABLET: 'Tablet',
      TV: 'TV',
      GAME_CONSOLE: 'Game Console',
      UNKNOWN_PLATFORM: 'Unknown',
    };
    return labels[value] || value;
  }

  private mapYoutubeRows(data: any): Record<string, any>[] {
    const columns: string[] =
      data?.columnHeaders?.map((p: any) => String(p.name || '')) || [];
    if (!columns.length || !Array.isArray(data?.rows)) {
      return [];
    }
    return data.rows.map((row: any[]) =>
      columns.reduce((acc, curr, index) => {
        acc[curr] = row[index];
        return acc;
      }, {} as Record<string, any>)
    );
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    try {
      const safeDays = Math.max(1, Math.min(365, Math.floor(date || 7)));
      const endDate = dayjs().format('YYYY-MM-DD');
      const startDate = dayjs().subtract(safeDays, 'day').format('YYYY-MM-DD');
      const prevEndDate = dayjs()
        .subtract(safeDays + 1, 'day')
        .format('YYYY-MM-DD');
      const prevStartDate = dayjs()
        .subtract(safeDays * 2 + 1, 'day')
        .format('YYYY-MM-DD');

      const { client, youtube, youtubeAnalytics } = clientAndYoutube();
      client.setCredentials({ access_token: accessToken });

      const ytDataClient = youtube(client);
      const ytAnalyticsClient = youtubeAnalytics(client);

      const queryDailyMetrics = async (sDate: string, eDate: string) => {
        const primaryMetrics =
          'views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares';
        const fallbackMetrics =
          'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares';

        try {
          const { data } = await ytAnalyticsClient.reports.query({
            ids: 'channel==MINE',
            startDate: sDate,
            endDate: eDate,
            metrics: primaryMetrics,
            dimensions: 'day',
            sort: 'day',
          });
          return this.mapYoutubeRows(data);
        } catch (err: any) {
          this.rethrowYoutubeAuthError(err);
          const { data } = await ytAnalyticsClient.reports.query({
            ids: 'channel==MINE',
            startDate: sDate,
            endDate: eDate,
            metrics: fallbackMetrics,
            dimensions: 'day',
            sort: 'day',
          });
          return this.mapYoutubeRows(data);
        }
      };

      // views split by a single dimension, for breakdown cards
      const queryViewsBy = async (params: {
        dimensions: string;
        sort: string;
        filters?: string;
        maxResults?: number;
      }) => {
        try {
          const { data } = await ytAnalyticsClient.reports.query({
            ids: 'channel==MINE',
            startDate,
            endDate,
            metrics: 'views',
            ...params,
          });
          return this.mapYoutubeRows(data);
        } catch (err) {
          this.rethrowYoutubeAuthError(err);
          throw err;
        }
      };

      const [
        channelInfo,
        mappedData,
        prevMappedData,
        trafficRows,
        countryRows,
        demoRows,
        topVideoRows,
        contentTypeRows,
        subscribedStatusRows,
        deviceRows,
        searchTermRows,
      ] = await Promise.all([
        safeAnalyticsCall(
          'youtube.channels.list',
          async () => {
            try {
              const res = await ytDataClient.channels.list({
                part: ['statistics', 'snippet'],
                mine: true,
              });
              return res.data.items?.[0] || null;
            } catch (err) {
              this.rethrowYoutubeAuthError(err);
              throw err;
            }
          },
          null
        ),
        queryDailyMetrics(startDate, endDate),
        safeAnalyticsCall(
          'youtube.prevDaily',
          () => queryDailyMetrics(prevStartDate, prevEndDate),
          []
        ),
        safeAnalyticsCall(
          'youtube.trafficSources',
          async () => {
            try {
              const { data } = await ytAnalyticsClient.reports.query({
                ids: 'channel==MINE',
                startDate,
                endDate,
                metrics: 'views',
                dimensions: 'insightTrafficSourceType',
                sort: '-views',
              });
              return this.mapYoutubeRows(data);
            } catch (err) {
              this.rethrowYoutubeAuthError(err);
              throw err;
            }
          },
          []
        ),
        safeAnalyticsCall(
          'youtube.countries',
          async () => {
            try {
              const { data } = await ytAnalyticsClient.reports.query({
                ids: 'channel==MINE',
                startDate,
                endDate,
                metrics: 'views',
                dimensions: 'country',
                sort: '-views',
                maxResults: 10,
              });
              return this.mapYoutubeRows(data);
            } catch (err) {
              this.rethrowYoutubeAuthError(err);
              throw err;
            }
          },
          []
        ),
        safeAnalyticsCall(
          'youtube.demographics',
          async () => {
            try {
              const { data } = await ytAnalyticsClient.reports.query({
                ids: 'channel==MINE',
                startDate,
                endDate,
                metrics: 'viewerPercentage',
                dimensions: 'ageGroup,gender',
                sort: '-viewerPercentage',
              });
              return this.mapYoutubeRows(data);
            } catch (err) {
              this.rethrowYoutubeAuthError(err);
              throw err;
            }
          },
          []
        ),
        safeAnalyticsCall(
          'youtube.topVideos',
          async () => {
            try {
              const { data } = await ytAnalyticsClient.reports.query({
                ids: 'channel==MINE',
                startDate,
                endDate,
                metrics:
                  'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares',
                dimensions: 'video',
                sort: '-views',
                maxResults: 10,
              });
              return this.mapYoutubeRows(data);
            } catch (err) {
              this.rethrowYoutubeAuthError(err);
              throw err;
            }
          },
          []
        ),
        safeAnalyticsCall(
          'youtube.contentType',
          () =>
            queryViewsBy({ dimensions: 'creatorContentType', sort: '-views' }),
          []
        ),
        safeAnalyticsCall(
          'youtube.subscribedStatus',
          () =>
            queryViewsBy({ dimensions: 'subscribedStatus', sort: '-views' }),
          []
        ),
        safeAnalyticsCall(
          'youtube.deviceType',
          () => queryViewsBy({ dimensions: 'deviceType', sort: '-views' }),
          []
        ),
        safeAnalyticsCall(
          'youtube.searchTerms',
          () =>
            queryViewsBy({
              dimensions: 'insightTrafficSourceDetail',
              filters: 'insightTrafficSourceType==YT_SEARCH',
              sort: '-views',
              maxResults: 10,
            }),
          []
        ),
      ]);

      const acc: AnalyticsData[] = [];

      if (channelInfo?.statistics) {
        const chStats = channelInfo.statistics;
        if (chStats.subscriberCount !== undefined) {
          acc.push({
            label: 'Subscribers',
            percentageChange: 0,
            aggregation: 'latest',
            category: 'overview',
            data: [{ total: String(chStats.subscriberCount), date: endDate }],
          });
        }
        if (chStats.viewCount !== undefined) {
          acc.push({
            label: 'Lifetime Views',
            percentageChange: 0,
            aggregation: 'latest',
            category: 'overview',
            data: [{ total: String(chStats.viewCount), date: endDate }],
          });
        }
        if (chStats.videoCount !== undefined) {
          acc.push({
            label: 'Videos',
            percentageChange: 0,
            aggregation: 'latest',
            category: 'overview',
            data: [{ total: String(chStats.videoCount), date: endDate }],
          });
        }
      }

      const pushMetricSeries = (
        label: string,
        key: string,
        opts: {
          average?: boolean;
          unit?: AnalyticsData['unit'];
          aggregation?: AnalyticsData['aggregation'];
          category?: AnalyticsData['category'];
          isPercentPoint?: boolean;
        } = {}
      ) => {
        if (!mappedData.length) return;
        const hasKey = mappedData.some((r) => r[key] !== undefined);
        if (!hasKey) return;

        const aggregation =
          opts.aggregation || (opts.average ? 'average' : 'sum');
        const currSeries = mappedData.map((p: any) => ({
          total: String(
            Number.isFinite(Number(p[key]))
              ? Number(Number(p[key]).toFixed(2))
              : 0
          ),
          date: String(p.day),
        }));
        const prevSeries = prevMappedData.map((p: any) => ({
          total: String(Number(p[key]) || 0),
          date: String(p.day),
        }));

        const currVal = aggregatePoints(currSeries, aggregation);
        const prevVal = prevSeries.length
          ? aggregatePoints(prevSeries, aggregation)
          : undefined;

        acc.push({
          label,
          average: opts.average,
          unit: opts.unit,
          aggregation,
          category: opts.category || 'overview',
          percentageChange: computePercentageChange(
            currVal,
            prevVal,
            Boolean(opts.isPercentPoint)
          ),
          data: currSeries,
        });
      };

      pushMetricSeries('Views', 'views', { category: 'overview' });
      pushMetricSeries('Engaged Views', 'engagedViews', {
        category: 'overview',
      });
      pushMetricSeries('Estimated Minutes Watched', 'estimatedMinutesWatched', {
        unit: 'minutes',
        category: 'retention',
      });
      pushMetricSeries('Average View Duration', 'averageViewDuration', {
        average: true,
        unit: 'seconds',
        aggregation: 'average',
        category: 'retention',
      });
      pushMetricSeries('Average View Percentage', 'averageViewPercentage', {
        average: true,
        unit: 'percent',
        aggregation: 'average',
        category: 'retention',
        isPercentPoint: true,
      });
      pushMetricSeries('Likes', 'likes', { category: 'engagement' });
      pushMetricSeries('Comments', 'comments', { category: 'engagement' });
      pushMetricSeries('Shares', 'shares', { category: 'engagement' });

      if (mappedData.length > 0) {
        const calcPeriodEr = (rows: Record<string, any>[]) => {
          const v = rows.reduce((s, r) => s + (Number(r.views) || 0), 0);
          const eng = rows.reduce(
            (s, r) =>
              s +
              (Number(r.likes) || 0) +
              (Number(r.comments) || 0) +
              (Number(r.shares) || 0),
            0
          );
          return v > 0 ? Number(((eng / v) * 100).toFixed(2)) : 0;
        };

        const erSeries = mappedData.map((r) => {
          const v = Number(r.views) || 0;
          const eng =
            (Number(r.likes) || 0) +
            (Number(r.comments) || 0) +
            (Number(r.shares) || 0);
          const er = v > 0 ? Number(((eng / v) * 100).toFixed(2)) : 0;
          return { total: String(er), date: String(r.day) };
        });

        const currEr = calcPeriodEr(mappedData);
        const prevEr = prevMappedData.length
          ? calcPeriodEr(prevMappedData)
          : undefined;

        acc.push({
          label: 'Engagement Rate',
          average: true,
          unit: 'percent',
          aggregation: 'average',
          category: 'engagement',
          percentageChange: computePercentageChange(currEr, prevEr, true),
          data: erSeries,
        });
      }

      pushMetricSeries('Subscribers Gained', 'subscribersGained', {
        category: 'audience',
      });
      pushMetricSeries('Subscribers Lost', 'subscribersLost', {
        category: 'audience',
      });

      if (trafficRows.length > 0) {
        const breakdown = buildBreakdown(
          trafficRows.map((r) => ({
            label: this.formatYoutubeTrafficSource(
              String(r.insightTrafficSourceType || '')
            ),
            value: Number(r.views) || 0,
          })),
          10
        );
        if (breakdown.length > 0) {
          const totalTraffic = breakdown.reduce((s, b) => s + b.value, 0);
          acc.push({
            label: 'Traffic Sources',
            percentageChange: 0,
            category: 'traffic',
            breakdown,
            data: [{ total: String(totalTraffic), date: endDate }],
          });
        }
      }

      if (countryRows.length > 0) {
        const breakdown = buildBreakdown(
          countryRows.map((r) => ({
            label: String(r.country || ''),
            value: Number(r.views) || 0,
          })),
          10
        );
        if (breakdown.length > 0) {
          const totalCountry = breakdown.reduce((s, b) => s + b.value, 0);
          acc.push({
            label: 'Views by Country',
            percentageChange: 0,
            category: 'audience',
            breakdown,
            data: [{ total: String(totalCountry), date: endDate }],
          });
        }
      }

      if (demoRows.length > 0) {
        const genderMap: Record<string, string> = {
          female: 'Female',
          male: 'Male',
          user_specified: 'User-specified',
        };
        const breakdown = buildBreakdown(
          demoRows.map((r) => {
            const age = String(r.ageGroup || '').replace(/^age/, '');
            const g = genderMap[String(r.gender || '')] || String(r.gender || '');
            return {
              label: g ? `${age} (${g})` : age,
              value: Number(r.viewerPercentage) || 0,
            };
          }),
          12
        );
        if (breakdown.length > 0) {
          acc.push({
            label: 'Audience by Age & Gender',
            percentageChange: 0,
            unit: 'percent',
            category: 'audience',
            breakdown,
            data: [{ total: '100', date: endDate }],
          });
        }
      }

      const pushViewsBreakdown = (
        label: string,
        rows: Record<string, any>[],
        dimension: string,
        category: AnalyticsData['category'],
        limit = 10
      ) => {
        const breakdown = buildBreakdown(
          rows.map((r) => ({
            label: this.formatYoutubeDimension(String(r[dimension] || '')),
            value: Number(r.views) || 0,
          })),
          limit
        );
        if (breakdown.length > 0) {
          const total = breakdown.reduce((s, b) => s + b.value, 0);
          acc.push({
            label,
            percentageChange: 0,
            category,
            breakdown,
            data: [{ total: String(total), date: endDate }],
          });
        }
      };

      pushViewsBreakdown(
        'Views by Content Type',
        contentTypeRows,
        'creatorContentType',
        'traffic'
      );
      pushViewsBreakdown(
        'Views by Subscription Status',
        subscribedStatusRows,
        'subscribedStatus',
        'audience'
      );
      pushViewsBreakdown(
        'Views by Device',
        deviceRows,
        'deviceType',
        'audience'
      );
      pushViewsBreakdown(
        'Top Search Terms',
        searchTermRows,
        'insightTrafficSourceDetail',
        'traffic'
      );

      if (topVideoRows.length > 0) {
        const videoIds = topVideoRows
          .map((r) => String(r.video || ''))
          .filter(Boolean);
        const videoMetaMap = new Map<string, any>();

        if (videoIds.length > 0) {
          await safeAnalyticsCall(
            'youtube.videos.list.meta',
            async () => {
              const metaRes = await ytDataClient.videos.list({
                part: ['snippet', 'statistics'],
                id: videoIds,
              });
              for (const item of metaRes.data.items || []) {
                if (item.id) {
                  videoMetaMap.set(item.id, item);
                }
              }
            },
            undefined
          );
        }

        const posts: AnalyticsPostItem[] = topVideoRows.map((r) => {
          const vid = String(r.video || '');
          const meta = videoMetaMap.get(vid);
          const snippet = meta?.snippet;
          const views = Number(r.views) || 0;
          const likes = Number(r.likes) || 0;
          const comments = Number(r.comments) || 0;
          const shares = Number(r.shares) || 0;
          const er =
            views > 0
              ? Number((((likes + comments + shares) / views) * 100).toFixed(2))
              : 0;
          const thumb =
            snippet?.thumbnails?.medium?.url ||
            snippet?.thumbnails?.default?.url ||
            undefined;

          return {
            id: vid,
            title: summarizePostTitle(snippet?.title, `Video ${vid}`),
            url: vid ? `https://www.youtube.com/watch?v=${vid}` : undefined,
            thumbnail: thumb,
            publishedAt: snippet?.publishedAt || endDate,
            mediaType: 'VIDEO',
            views,
            likes,
            comments,
            shares,
            engagementRate: er,
            avgWatchTimeSeconds:
              r.averageViewDuration !== undefined
                ? Number(Number(r.averageViewDuration).toFixed(1))
                : undefined,
          };
        });

        if (posts.length > 0) {
          const topTotalViews = posts.reduce((s, p) => s + (p.views || 0), 0);
          acc.push({
            label: 'Top Videos Performance',
            percentageChange: 0,
            category: 'posts',
            posts,
            data: [{ total: String(topTotalViews), date: endDate }],
          });
        }
      }

      return acc;
    } catch (err: any) {
      this.rethrowYoutubeAuthError(err);
      console.error('Error fetching YouTube analytics:', err?.message || err);
      return [];
    }
  }

  async analyticsSnapshot(
    id: string,
    accessToken: string
  ): Promise<AnalyticsSnapshotData | undefined> {
    const { client, youtube } = clientAndYoutube();
    client.setCredentials({ access_token: accessToken });
    try {
      const res = await youtube(client).channels.list({
        part: ['statistics'],
        mine: true,
      });
      const count = res.data.items?.[0]?.statistics?.subscriberCount;
      return count !== undefined && count !== null
        ? { followers: Number(count) || 0 }
        : undefined;
    } catch (err) {
      this.rethrowYoutubeAuthError(err);
      throw err;
    }
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const safeDays = Math.max(1, Math.min(365, Math.floor(date || 30)));
    const today = dayjs().format('YYYY-MM-DD');
    const startDate = dayjs().subtract(safeDays, 'day').format('YYYY-MM-DD');

    try {
      const { client, youtube, youtubeAnalytics } = clientAndYoutube();
      client.setCredentials({ access_token: accessToken });
      const youtubeClient = youtube(client);
      const ytAnalyticsClient = youtubeAnalytics(client);

      const response = await youtubeClient.videos.list({
        part: ['statistics', 'snippet'],
        id: [postId],
      });

      const video = response.data.items?.[0];

      if (!video || !video.statistics) {
        return [];
      }

      const stats = video.statistics;
      const result: AnalyticsData[] = [];

      const lifetimeViews = Number(stats.viewCount) || 0;
      const lifetimeLikes = Number(stats.likeCount) || 0;
      const lifetimeComments = Number(stats.commentCount) || 0;

      if (stats.viewCount !== undefined) {
        result.push({
          label: 'Views',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'overview',
          data: [{ total: String(stats.viewCount), date: today }],
        });
      }

      if (stats.likeCount !== undefined) {
        result.push({
          label: 'Likes',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'engagement',
          data: [{ total: String(stats.likeCount), date: today }],
        });
      }

      if (stats.commentCount !== undefined) {
        result.push({
          label: 'Comments',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'engagement',
          data: [{ total: String(stats.commentCount), date: today }],
        });
      }

      if (stats.favoriteCount !== undefined) {
        result.push({
          label: 'Favorites',
          percentageChange: 0,
          aggregation: 'latest',
          category: 'engagement',
          data: [{ total: String(stats.favoriteCount), date: today }],
        });
      }

      if (lifetimeViews > 0) {
        const er = Number(
          (((lifetimeLikes + lifetimeComments) / lifetimeViews) * 100).toFixed(2)
        );
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

      // Retention is cumulative over the video's life, so start at publish
      const publishedDate = video.snippet?.publishedAt
        ? dayjs(video.snippet.publishedAt).format('YYYY-MM-DD')
        : startDate;

      const [
        dailyVideoRows,
        videoTrafficRows,
        retentionRows,
        searchTermRows,
      ] = await Promise.all([
        safeAnalyticsCall(
          'youtube.postAnalytics.daily',
          async () => {
            try {
              const { data } = await ytAnalyticsClient.reports.query({
                ids: 'channel==MINE',
                startDate,
                endDate: today,
                filters: `video==${postId}`,
                metrics:
                  'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,shares,subscribersGained',
                dimensions: 'day',
                sort: 'day',
              });
              return this.mapYoutubeRows(data);
            } catch (err) {
              this.rethrowYoutubeAuthError(err);
              throw err;
            }
          },
          []
        ),
        safeAnalyticsCall(
          'youtube.postAnalytics.traffic',
          async () => {
            try {
              const { data } = await ytAnalyticsClient.reports.query({
                ids: 'channel==MINE',
                startDate,
                endDate: today,
                filters: `video==${postId}`,
                metrics: 'views',
                dimensions: 'insightTrafficSourceType',
                sort: '-views',
              });
              return this.mapYoutubeRows(data);
            } catch (err) {
              this.rethrowYoutubeAuthError(err);
              throw err;
            }
          },
          []
        ),
        safeAnalyticsCall(
          'youtube.postAnalytics.retention',
          async () => {
            try {
              const { data } = await ytAnalyticsClient.reports.query({
                ids: 'channel==MINE',
                startDate: publishedDate,
                endDate: today,
                filters: `video==${postId}`,
                metrics: 'audienceWatchRatio',
                dimensions: 'elapsedVideoTimeRatio',
                sort: 'elapsedVideoTimeRatio',
              });
              return this.mapYoutubeRows(data);
            } catch (err) {
              this.rethrowYoutubeAuthError(err);
              throw err;
            }
          },
          []
        ),
        safeAnalyticsCall(
          'youtube.postAnalytics.searchTerms',
          async () => {
            try {
              const { data } = await ytAnalyticsClient.reports.query({
                ids: 'channel==MINE',
                startDate,
                endDate: today,
                filters: `video==${postId};insightTrafficSourceType==YT_SEARCH`,
                metrics: 'views',
                dimensions: 'insightTrafficSourceDetail',
                sort: '-views',
                maxResults: 10,
              });
              return this.mapYoutubeRows(data);
            } catch (err) {
              this.rethrowYoutubeAuthError(err);
              throw err;
            }
          },
          []
        ),
      ]);

      if (dailyVideoRows.length > 0) {
        result.push({
          label: 'Period Views',
          percentageChange: 0,
          aggregation: 'sum',
          category: 'overview',
          data: dailyVideoRows.map((r) => ({
            total: String(Number(r.views) || 0),
            date: String(r.day),
          })),
        });

        result.push({
          label: 'Estimated Minutes Watched',
          percentageChange: 0,
          unit: 'minutes',
          aggregation: 'sum',
          category: 'retention',
          data: dailyVideoRows.map((r) => ({
            total: String(
              Number((Number(r.estimatedMinutesWatched) || 0).toFixed(2))
            ),
            date: String(r.day),
          })),
        });

        result.push({
          label: 'Average View Duration',
          percentageChange: 0,
          average: true,
          unit: 'seconds',
          aggregation: 'average',
          category: 'retention',
          data: dailyVideoRows.map((r) => ({
            total: String(
              Number((Number(r.averageViewDuration) || 0).toFixed(1))
            ),
            date: String(r.day),
          })),
        });

        result.push({
          label: 'Average View Percentage',
          percentageChange: 0,
          average: true,
          unit: 'percent',
          aggregation: 'average',
          category: 'retention',
          data: dailyVideoRows.map((r) => ({
            total: String(
              Number((Number(r.averageViewPercentage) || 0).toFixed(2))
            ),
            date: String(r.day),
          })),
        });

        result.push({
          label: 'Shares',
          percentageChange: 0,
          aggregation: 'sum',
          category: 'engagement',
          data: dailyVideoRows.map((r) => ({
            total: String(Number(r.shares) || 0),
            date: String(r.day),
          })),
        });

        result.push({
          label: 'Subscribers Gained',
          percentageChange: 0,
          aggregation: 'sum',
          category: 'audience',
          data: dailyVideoRows.map((r) => ({
            total: String(Number(r.subscribersGained) || 0),
            date: String(r.day),
          })),
        });
      }

      if (videoTrafficRows.length > 0) {
        const breakdown = buildBreakdown(
          videoTrafficRows.map((r) => ({
            label: this.formatYoutubeTrafficSource(
              String(r.insightTrafficSourceType || '')
            ),
            value: Number(r.views) || 0,
          })),
          10
        );
        if (breakdown.length > 0) {
          const totalTraffic = breakdown.reduce((s, b) => s + b.value, 0);
          result.push({
            label: 'Traffic Sources',
            percentageChange: 0,
            category: 'traffic',
            breakdown,
            data: [{ total: String(totalTraffic), date: today }],
          });
        }
      }

      const searchBreakdown = buildBreakdown(
        searchTermRows.map((r) => ({
          label: String(r.insightTrafficSourceDetail || ''),
          value: Number(r.views) || 0,
        })),
        10
      );
      if (searchBreakdown.length > 0) {
        const totalSearch = searchBreakdown.reduce((s, b) => s + b.value, 0);
        result.push({
          label: 'Top Search Terms',
          percentageChange: 0,
          category: 'traffic',
          breakdown: searchBreakdown,
          data: [{ total: String(totalSearch), date: today }],
        });
      }

      // audienceWatchRatio can go above 1 where viewers rewatch a section
      const retentionPoints = retentionRows
        .map((r) => ({
          ratio: Number(r.elapsedVideoTimeRatio),
          watch: Number(r.audienceWatchRatio),
        }))
        .filter((p) => Number.isFinite(p.ratio) && Number.isFinite(p.watch));
      const lastRetentionPoint = retentionPoints[retentionPoints.length - 1];
      if (retentionPoints.length >= 2) {
        result.push({
          label: 'Audience Retention',
          percentageChange: 0,
          unit: 'percent',
          aggregation: 'average',
          category: 'retention',
          curve: true,
          data: retentionPoints.map((p) => ({
            date: `${Math.round(p.ratio * 100)}%`,
            total: String(Number((p.watch * 100).toFixed(1))),
          })),
        });
      }
      // sparse curves on low-view videos may stop before the end
      if (retentionPoints.length >= 2 && lastRetentionPoint.ratio >= 0.99) {
        const completion = Number((lastRetentionPoint.watch * 100).toFixed(1));
        result.push({
          label: 'Completion Rate',
          percentageChange: 0,
          unit: 'percent',
          aggregation: 'latest',
          category: 'retention',
          data: [{ total: String(completion), date: today }],
        });
      }

      return result;
    } catch (err: any) {
      // Expired or revoked token, checkPostAnalytics refreshes it and retries once
      this.rethrowYoutubeAuthError(err);
      console.error(
        'Error fetching YouTube post analytics:',
        err?.message || err
      );
      return [];
    }
  }
}
