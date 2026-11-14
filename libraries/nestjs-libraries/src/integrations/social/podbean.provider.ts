import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { SocialAbstract } from '../social.abstract';
import {
  AnalyticsData,
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from './social.integrations.interface';
import dayjs from 'dayjs';
import { PodbeanDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/podbean.dto';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import {
  buildBreakdown,
  computeSeriesTrend,
  safeAnalyticsCall,
} from '@gitroom/nestjs-libraries/integrations/social/analytics.helper';

const PODBEAN_API = 'https://api.podbean.com/v1';
// Podbean answers 403 to requests without a User-Agent
const PODBEAN_HEADERS = { 'User-Agent': 'Postiz/1.0 (+https://postiz.com)' };

@Rules(
  'Podbean publishes a podcast episode: the content is the episode description (HTML), the audio must be an .mp3 from the media library set in the settings, pictures and videos are not sent'
)
export class PodbeanProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Podbean allows 2 requests per second per app
  identifier = 'podbean';
  name = 'Podbean';
  isBetweenSteps = false;
  scopes = ['podcast_read', 'episode_read', 'episode_publish'];
  editor = 'html' as const;
  dto = PodbeanDto;

  maxLength() {
    return 100000;
  }

  public override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry';
        value: string;
      }
    | undefined {
    if (
      body.indexOf('invalid_token') > -1 ||
      body.indexOf('invalid_grant') > -1
    ) {
      return {
        type: 'refresh-token',
        value: 'Please re-authenticate your Podbean account',
      };
    }
    if (body.indexOf('storage_limit_reach') > -1) {
      return {
        type: 'bad-body',
        value: 'You reached the upload limit of your Podbean plan',
      };
    }
    return undefined;
  }

  private basicAuth() {
    return `Basic ${Buffer.from(
      `${process.env.PODBEAN_CLIENT_ID}:${process.env.PODBEAN_CLIENT_SECRET}`
    ).toString('base64')}`;
  }

  private async podcast(accessToken: string) {
    const { podcast } = await (
      await this.fetch(`${PODBEAN_API}/podcast?access_token=${accessToken}`, {
        headers: PODBEAN_HEADERS,
      })
    ).json();

    return {
      id: podcast.id,
      name: podcast.title,
      picture: podcast.logo || '',
      username: podcast.title,
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const { access_token, expires_in } = await (
      await this.fetch(`${PODBEAN_API}/oauth/token`, {
        method: 'POST',
        headers: {
          ...PODBEAN_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: this.basicAuth(),
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      })
    ).json();

    return {
      ...(await this.podcast(access_token)),
      accessToken: access_token,
      // Podbean keeps the same refresh token, it only sends a new access token
      refreshToken,
      expiresIn: expires_in,
    };
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return {
      url: `${PODBEAN_API}/dialog/oauth?client_id=${
        process.env.PODBEAN_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(
        `${process.env.FRONTEND_URL}/integrations/social/podbean`
      )}&response_type=code&scope=${encodeURIComponent(
        this.scopes.join(' ')
      )}&state=${state}`,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const { access_token, refresh_token, expires_in, scope } = await (
      await this.fetch(`${PODBEAN_API}/oauth/token`, {
        method: 'POST',
        headers: {
          ...PODBEAN_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: this.basicAuth(),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: `${process.env.FRONTEND_URL}/integrations/social/podbean`,
        }),
      })
    ).json();

    this.checkScopes(this.scopes, scope || '');

    return {
      ...(await this.podcast(access_token)),
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in,
    };
  }

  // Podbean answers { "YYYY-MM-DD": count } for a day series and
  // { label: count } for platform / source / country totals
  private async stats(
    accessToken: string,
    path: string,
    days: number,
    episodeId?: string
  ): Promise<Record<string, number>> {
    const params = new URLSearchParams({
      access_token: accessToken,
      start: dayjs().subtract(days, 'day').format('YYYY-MM-DD'),
      end: dayjs().subtract(1, 'day').format('YYYY-MM-DD'),
      period: 'd',
      ...(episodeId ? { episode_id: episodeId } : {}),
    });

    return (
      (await (
        await this.fetch(`${PODBEAN_API}/podcastStats/${path}?${params}`, {
          headers: PODBEAN_HEADERS,
        })
      ).json()) || {}
    );
  }

  // Podbean may leave out days without downloads, the chart needs every day
  private downloadsSeries(stats: Record<string, number>, days: number) {
    return [...new Array(days)].map((_, index) => {
      const day = dayjs()
        .subtract(days - index, 'day')
        .format('YYYY-MM-DD');
      return { date: day, total: String(stats[day] || 0) };
    });
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const downloads = this.downloadsSeries(
      await this.stats(accessToken, 'stats', date),
      date
    );
    const today = dayjs().format('YYYY-MM-DD');
    const result: AnalyticsData[] = [
      {
        label: 'Downloads',
        percentageChange: computeSeriesTrend(downloads),
        aggregation: 'sum',
        category: 'overview',
        data: downloads,
      },
    ];

    for (const [label, path, category] of [
      ['Downloads by App', 'sources', 'traffic'],
      ['Downloads by Country', 'countries', 'audience'],
      ['Downloads by Device', 'platforms', 'audience'],
    ] as const) {
      const breakdown = buildBreakdown(
        await safeAnalyticsCall(
          `podbean.${path}`,
          () => this.stats(accessToken, path, date),
          {}
        ),
        10
      );
      if (breakdown.length > 0) {
        result.push({
          label,
          percentageChange: 0,
          category,
          breakdown,
          data: [
            {
              total: String(breakdown.reduce((a, b) => a + b.value, 0)),
              date: today,
            },
          ],
        });
      }
    }

    return result;
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const downloads = this.downloadsSeries(
      await this.stats(accessToken, 'stats', date, postId),
      date
    );

    return [
      {
        label: 'Downloads',
        percentageChange: computeSeriesTrend(downloads),
        aggregation: 'sum',
        data: downloads,
      },
    ];
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<PodbeanDto>[]
  ): Promise<PostResponse[]> {
    const { settings, message } = postDetails[0];
    const audioUrl = `${
      settings.audio.path.indexOf('http') === -1
        ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/${process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY}`
        : ``
    }${settings.audio.path}`;

    const { episode } = await (
      await this.fetch(`${PODBEAN_API}/episodes`, {
        method: 'POST',
        headers: {
          ...PODBEAN_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          access_token: accessToken,
          title: settings.title,
          content: message,
          status: 'publish',
          remote_media_url: audioUrl,
          ...(settings.episodeType
            ? { apple_episode_type: settings.episodeType }
            : {}),
        }),
      })
    ).json();

    return [
      {
        id: postDetails[0].id,
        status: 'completed',
        releaseURL: episode.permalink_url,
        postId: episode.id,
      },
    ];
  }
}
