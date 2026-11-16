import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

const videoCategoriesList = jest.fn();
const playlistsList = jest.fn();
const playlistItemsInsert = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
      })),
    },
    youtube: jest.fn(() => ({
      videoCategories: { list: videoCategoriesList },
      playlists: { list: playlistsList },
      playlistItems: { insert: playlistItemsInsert },
    })),
    youtubeAnalytics: jest.fn(() => ({})),
    oauth2: jest.fn(() => ({})),
  },
}));

jest.mock('@gitroom/nestjs-libraries/temporal/temporal.heartbeat', () => ({
  setHeartbeatDetails: jest.fn(),
}));

import { YoutubeProvider } from './youtube.provider';
import { YoutubeSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.settings.dto';
import { getValidationSchemas } from '@gitroom/nestjs-libraries/chat/validation.schemas.helper';

const baseSettings = {
  title: 'My video',
  type: 'public',
  selfDeclaredMadeForKids: 'no',
};

const postDetails = (settings: any) =>
  [
    {
      id: 'post-1',
      message: 'description',
      settings,
      media: [{ path: 'https://uploads.example.com/video.mp4' }],
    },
  ] as any;

const startUpload = (provider: YoutubeProvider) => {
  const fetchMock = jest.fn().mockResolvedValue({
    headers: { get: () => 'https://upload.example.com/session' },
  });
  (provider as any).fetch = fetchMock;
  (provider as any).youtubeMediaSize = jest.fn().mockResolvedValue(1000);
  return fetchMock;
};

describe('YoutubeProvider category and playlist', () => {
  let provider: YoutubeProvider;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new YoutubeProvider();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('settings DTO', () => {
    it('accepts a post without category and playlist', async () => {
      const errors = await validate(
        plainToInstance(YoutubeSettingsDto, baseSettings)
      );
      expect(errors).toHaveLength(0);
    });

    it('accepts categoryId and playlistId as strings', async () => {
      const errors = await validate(
        plainToInstance(YoutubeSettingsDto, {
          ...baseSettings,
          categoryId: '22',
          playlistId: 'PL123',
        })
      );
      expect(errors).toHaveLength(0);
    });

    it('rejects non string values', async () => {
      const errors = await validate(
        plainToInstance(YoutubeSettingsDto, {
          ...baseSettings,
          categoryId: 22,
          playlistId: { id: 'PL123' },
        })
      );
      expect(errors.map((p) => p.property).sort()).toEqual([
        'categoryId',
        'playlistId',
      ]);
    });

    it('exposes both fields in the schema used by the MCP integrationSchema tool', () => {
      const schema = getValidationSchemas().YoutubeSettingsDto as any;
      expect(schema.properties.categoryId.description).toContain('category');
      expect(schema.properties.playlistId.description).toContain('playlist');
      expect(schema.required || []).not.toContain('categoryId');
      expect(schema.required || []).not.toContain('playlistId');
    });
  });

  describe('tools', () => {
    it('registers categories and playlists as provider tools', () => {
      const tools = Reflect.getMetadata(
        'custom:tool',
        YoutubeProvider.prototype
      ).map((p: any) => p.methodName);
      expect(tools).toEqual(
        expect.arrayContaining(['categories', 'playlists'])
      );
    });

    it('lists the assignable categories for Taiwan in Traditional Chinese', async () => {
      videoCategoriesList.mockResolvedValue({
        data: {
          items: [
            { id: '22', snippet: { title: '人物與網誌', assignable: true } },
            { id: '18', snippet: { title: '短片', assignable: false } },
            { id: '27', snippet: { title: '教育', assignable: true } },
          ],
        },
      });

      const list = await provider.categories('token');

      expect(videoCategoriesList).toHaveBeenCalledWith({
        part: ['snippet'],
        regionCode: 'TW',
        hl: 'zh-TW',
      });
      expect(list).toEqual([
        { id: '22', name: '人物與網誌' },
        { id: '27', name: '教育' },
      ]);
    });

    it('lists every page of the channel playlists', async () => {
      playlistsList
        .mockResolvedValueOnce({
          data: {
            items: [{ id: 'PL1', snippet: { title: '帕帕貝貝家' } }],
            nextPageToken: 'next',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [{ id: 'PL2', snippet: { title: '一週大事' } }],
          },
        });

      const list = await provider.playlists('token');

      expect(playlistsList).toHaveBeenCalledTimes(2);
      expect(playlistsList.mock.calls[0][0]).toMatchObject({
        mine: true,
        maxResults: 50,
      });
      expect(playlistsList.mock.calls[1][0]).toMatchObject({
        mine: true,
        pageToken: 'next',
      });
      expect(list).toEqual([
        { id: 'PL1', name: '帕帕貝貝家' },
        { id: 'PL2', name: '一週大事' },
      ]);
    });
  });

  describe('upload', () => {
    it('writes the category into the snippet and keeps the playlist for later', async () => {
      const fetchMock = startUpload(provider);

      const [response] = await provider.postPending(
        'id',
        'token',
        postDetails({ ...baseSettings, categoryId: '27', playlistId: 'PL1' }),
        {} as any
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.snippet.categoryId).toBe('27');
      expect((response as any).pendingData.playlistId).toBe('PL1');
    });

    it('leaves the category out when it is not set, so the channel default is used', async () => {
      const fetchMock = startUpload(provider);

      const [response] = await provider.postPending(
        'id',
        'token',
        postDetails(baseSettings),
        {} as any
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.snippet).not.toHaveProperty('categoryId');
      expect((response as any).pendingData.playlistId).toBe('');
    });

    it('hands over to finalizePost when the upload finished but a playlist is set', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ id: 'video-1' }),
      }) as any;

      const result = await provider.checkPostStatus(
        'token',
        {
          uploadUri: 'https://upload.example.com/session',
          videoSize: 1000,
          path: 'video.mp4',
          uploadedBytes: 1000,
          thumbnail: '',
          playlistId: 'PL1',
        },
        {} as any
      );

      expect(result.status).toBe('ready');
      expect((result as any).pendingData.videoId).toBe('video-1');
    });

    it('adds the uploaded video to the playlist', async () => {
      playlistItemsInsert.mockResolvedValue({ data: {} });

      const result = await provider.finalizePost(
        'token',
        {
          uploadUri: 'https://upload.example.com/session',
          videoSize: 1000,
          path: 'video.mp4',
          uploadedBytes: 1000,
          thumbnail: '',
          playlistId: 'PL1',
          videoId: 'video-1',
        },
        {} as any
      );

      expect(playlistItemsInsert).toHaveBeenCalledWith({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId: 'PL1',
            resourceId: { kind: 'youtube#video', videoId: 'video-1' },
          },
        },
      });
      expect(result).toEqual({
        status: 'completed',
        postId: 'video-1',
        releaseURL: 'https://www.youtube.com/watch?v=video-1',
      });
    });

    it('still completes the post when adding to the playlist fails', async () => {
      playlistItemsInsert.mockRejectedValue({
        response: { status: 404, data: { error: 'playlistNotFound' } },
      });
      const log = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = await provider.finalizePost(
        'token',
        {
          uploadUri: 'https://upload.example.com/session',
          videoSize: 1000,
          path: 'video.mp4',
          uploadedBytes: 1000,
          thumbnail: '',
          playlistId: 'PL-removed',
          videoId: 'video-1',
        },
        {} as any
      );

      expect(result.status).toBe('completed');
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });

    it('does not touch playlists when none is set', async () => {
      const result = await provider.finalizePost(
        'token',
        {
          uploadUri: 'https://upload.example.com/session',
          videoSize: 1000,
          path: 'video.mp4',
          uploadedBytes: 1000,
          thumbnail: '',
          videoId: 'video-1',
        },
        {} as any
      );

      expect(playlistItemsInsert).not.toHaveBeenCalled();
      expect(result.status).toBe('completed');
    });
  });
});
