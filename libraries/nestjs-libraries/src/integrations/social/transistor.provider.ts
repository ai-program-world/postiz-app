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
import { TransistorDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/transistor.dto';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { computeSeriesTrend } from '@gitroom/nestjs-libraries/integrations/social/analytics.helper';

const TRANSISTOR_API = 'https://api.transistor.fm/v1';

@Rules(
  'Transistor publishes a podcast episode: the content is the episode description (HTML), the audio must be an .mp3 from the media library set in the settings, pictures and videos are not sent'
)
export class TransistorProvider
  extends SocialAbstract
  implements SocialProvider
{
  override maxConcurrentJob = 3; // Transistor allows 10 requests per 10 seconds
  identifier = 'transistor';
  name = 'Transistor';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'html' as const;
  dto = TransistorDto;

  maxLength() {
    return 100000;
  }

  async customFields() {
    return [
      {
        key: 'apiKey',
        label: 'API Key',
        validation: `/^.{10,}$/`,
        type: 'password' as const,
      },
    ];
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
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
      url: state,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const body: { apiKey: string } = JSON.parse(
      Buffer.from(params.code, 'base64').toString()
    );

    try {
      const { data } = await (
        await this.fetch(`${TRANSISTOR_API}`, {
          headers: {
            'x-api-key': body.apiKey,
            Accept: 'application/json',
          },
        })
      ).json();

      return {
        refreshToken: body.apiKey,
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
        accessToken: body.apiKey,
        id: String(data.id),
        name: data.attributes.name,
        picture: data.attributes.image_url || '',
        username: data.attributes.name,
      };
    } catch (e) {
      console.log(e);
      return 'Invalid API key';
    }
  }

  @Tool({ description: 'List of available shows', dataSchema: [] })
  async shows(token: string) {
    const { data } = await (
      await this.fetch(`${TRANSISTOR_API}/shows?pagination[per]=100`, {
        headers: {
          'x-api-key': token,
          Accept: 'application/json',
        },
      })
    ).json();

    return data.map((p: any) => ({ id: p.id, name: p.attributes.title }));
  }

  // Transistor reads dates as dd-mm-yyyy but answers in mixed formats, so the
  // returned days are matched by position: the series starts at start_date
  private async downloads(
    accessToken: string,
    path: string,
    days: number
  ): Promise<Array<{ date: string; total: number }>> {
    const start = dayjs().subtract(days, 'day');
    const { data } = await (
      await this.fetch(
        `${TRANSISTOR_API}/analytics/${path}?start_date=${start.format(
          'DD-MM-YYYY'
        )}&end_date=${dayjs().format('DD-MM-YYYY')}`,
        {
          headers: {
            'x-api-key': accessToken,
            Accept: 'application/json',
          },
        }
      )
    ).json();

    return (data?.attributes?.downloads || []).map(
      (item: { downloads: number }, index: number) => ({
        date: start.add(index, 'day').format('YYYY-MM-DD'),
        total: item.downloads || 0,
      })
    );
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const shows = await this.shows(accessToken);
    const totals: Record<string, number> = {};
    for (const show of shows) {
      for (const item of await this.downloads(accessToken, show.id, date)) {
        totals[item.date] = (totals[item.date] || 0) + item.total;
      }
    }

    const data = Object.keys(totals)
      .sort()
      .map((day) => ({ date: day, total: String(totals[day]) }));

    return [
      {
        label: 'Downloads',
        percentageChange: computeSeriesTrend(data),
        aggregation: 'sum',
        category: 'overview',
        data,
      },
    ];
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const downloads = await this.downloads(
      accessToken,
      `episodes/${postId}`,
      date
    );

    const data = downloads.map((item) => ({
      date: item.date,
      total: String(item.total),
    }));

    return [
      {
        label: 'Downloads',
        percentageChange: computeSeriesTrend(data),
        aggregation: 'sum',
        data,
      },
    ];
  }

  private async findDraft(
    accessToken: string,
    show: string,
    title: string
  ): Promise<string | undefined> {
    const params = new URLSearchParams({
      show_id: show,
      status: 'draft',
      query: title,
      'pagination[per]': '50',
    });
    const { data } = await (
      await this.fetch(`${TRANSISTOR_API}/episodes?${params}`, {
        headers: {
          'x-api-key': accessToken,
          Accept: 'application/json',
        },
      })
    ).json();

    const draft = (data || []).find((p: any) => p?.attributes?.title === title);
    return draft ? String(draft.id) : undefined;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<TransistorDto>[]
  ): Promise<PostResponse[]> {
    const { settings, message } = postDetails[0];
    const audioUrl = `${
      settings.audio.path.indexOf('http') === -1
        ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/${process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY}`
        : ``
    }${settings.audio.path}`;

    const fields = {
      title: settings.title,
      description: message,
      audio_url: audioUrl,
      ...(settings.summary ? { summary: settings.summary } : {}),
      ...(settings.episodeType ? { type: settings.episodeType } : {}),
    };

    // Creating and publishing are two calls, so a retry after a failed publish
    // finds the draft it already created and updates it instead of adding another
    const draftId = await this.findDraft(
      accessToken,
      settings.show,
      settings.title
    );

    const { data: episode } = await (
      await this.fetch(
        draftId
          ? `${TRANSISTOR_API}/episodes/${draftId}`
          : `${TRANSISTOR_API}/episodes`,
        {
          method: draftId ? 'PATCH' : 'POST',
          headers: {
            'x-api-key': accessToken,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            episode: draftId ? fields : { show_id: settings.show, ...fields },
          }),
        }
      )
    ).json();

    const { data: published } = await (
      await this.fetch(`${TRANSISTOR_API}/episodes/${episode.id}/publish`, {
        method: 'PATCH',
        headers: {
          'x-api-key': accessToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          episode: {
            status: 'published',
          },
        }),
      })
    ).json();

    return [
      {
        id: postDetails[0].id,
        status: 'completed',
        releaseURL:
          published?.attributes?.share_url || episode.attributes.share_url,
        postId: String(episode.id),
      },
    ];
  }
}
