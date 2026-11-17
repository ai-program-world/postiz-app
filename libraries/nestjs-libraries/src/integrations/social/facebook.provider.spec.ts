import 'reflect-metadata';

jest.mock('@gitroom/nestjs-libraries/temporal/temporal.heartbeat', () => ({
  setHeartbeatDetails: jest.fn(),
}));

import sharp from 'sharp';
import { ApplicationFailure } from '@temporalio/common';
import { FacebookProvider } from './facebook.provider';
import { BadBody } from '@gitroom/nestjs-libraries/integrations/social.abstract';

const videoPost = (media: any, settings: any = {}) =>
  [
    {
      id: 'post-1',
      message: 'description',
      settings,
      media: [media],
    },
  ] as any;

const integration = { id: 'integration-1', internalId: 'page-1' } as any;

const image = (format: 'png' | 'webp', width = 64, height = 36) =>
  sharp({
    create: { width, height, channels: 3, background: '#ff0000' },
  })
    .toFormat(format)
    .toBuffer();

const mockVideoUpload = (provider: FacebookProvider) => {
  const fetchMock = jest.fn().mockResolvedValue({
    json: async () => ({ id: 'video-1', permalink_url: '/reel/video-1' }),
  });
  (provider as any).fetch = fetchMock;
  return fetchMock;
};

describe('FacebookProvider video cover', () => {
  let provider: FacebookProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new FacebookProvider();
  });

  it('keeps the JSON body when the video has no cover', async () => {
    const fetchMock = mockVideoUpload(provider);
    const readOrFetch = jest.fn();
    (provider as any).readOrFetch = readOrFetch;

    const [result] = await provider.post(
      'page-1',
      'token',
      videoPost(
        { path: 'https://uploads.example.com/video.mp4' },
        { title: 'My video' }
      ),
      integration
    );

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/page-1/videos');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({
      file_url: 'https://uploads.example.com/video.mp4',
      description: 'description',
      title: 'My video',
      published: true,
    });
    expect(readOrFetch).not.toHaveBeenCalled();
    expect(result.releaseURL).toBe('https://www.facebook.com/reel/video-1');
  });

  it('sends the cover as the thumb image of a multipart upload', async () => {
    const fetchMock = mockVideoUpload(provider);
    const readOrFetch = jest.fn().mockResolvedValue(await image('png'));
    (provider as any).readOrFetch = readOrFetch;

    await provider.post(
      'page-1',
      'token',
      videoPost({
        path: 'https://uploads.example.com/video.mp4',
        thumbnail: 'https://uploads.example.com/cover.jpg',
        thumbnailTimestamp: 1500,
      }),
      integration
    );

    expect(readOrFetch).toHaveBeenCalledWith(
      'https://uploads.example.com/cover.jpg'
    );

    const [, options] = fetchMock.mock.calls[0];
    // fetch sets the multipart boundary itself, a fixed content type would break it
    expect(options.headers).toBeUndefined();
    const form = options.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('file_url')).toBe('https://uploads.example.com/video.mp4');
    expect(form.get('description')).toBe('description');
    expect(form.get('published')).toBe('true');
    expect(form.get('title')).toBeNull();

    const thumb = form.get('thumb') as File;
    expect(thumb.name).toBe('thumbnail.jpg');
    expect(thumb.type).toBe('image/jpeg');
    // the cover is always re-encoded as a JPEG
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('converts a webp cover to JPEG and downscales a large one', async () => {
    const fetchMock = mockVideoUpload(provider);
    (provider as any).readOrFetch = jest
      .fn()
      .mockResolvedValue(await image('webp', 4000, 2250));

    await provider.post(
      'page-1',
      'token',
      videoPost({
        path: 'https://uploads.example.com/video.mp4',
        thumbnail: 'https://uploads.example.com/cover.webp',
      }),
      integration
    );

    const thumb = (fetchMock.mock.calls[0][1].body as FormData).get(
      'thumb'
    ) as File;
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
  });

  it('publishes the video without the cover when Facebook rejects it', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(
        new BadBody('upload mp4', '{"error":{"code":100}}', '{}', 'bad thumb')
      )
      .mockResolvedValueOnce({
        json: async () => ({ id: 'video-1', permalink_url: '/reel/video-1' }),
      });
    (provider as any).fetch = fetchMock;
    (provider as any).readOrFetch = jest.fn().mockResolvedValue(await image('png'));

    const [result] = await provider.post(
      'page-1',
      'token',
      videoPost({
        path: 'https://uploads.example.com/video.mp4',
        thumbnail: 'https://uploads.example.com/cover.png',
      }),
      integration
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(FormData);
    const [, retry] = fetchMock.mock.calls[1];
    expect(retry.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(retry.body).file_url).toBe(
      'https://uploads.example.com/video.mp4'
    );
    expect(result.postId).toBe('video-1');
  });

  it('does not retry without the cover on a generic or permission error', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValue(
        new BadBody(
          'upload mp4',
          '{"error":{"code":200,"message":"(#200) Permissions error"}}',
          '{}',
          'Unknown Error'
        )
      );
    (provider as any).fetch = fetchMock;
    (provider as any).readOrFetch = jest.fn().mockResolvedValue(await image('png'));

    await expect(
      provider.post(
        'page-1',
        'token',
        videoPost({
          path: 'https://uploads.example.com/video.mp4',
          thumbnail: 'https://uploads.example.com/cover.png',
        }),
        integration
      )
    ).rejects.toBeInstanceOf(BadBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry without the cover on a token error', async () => {
    const tokenError = ApplicationFailure.create({
      message: 'token expired',
      type: 'refresh_token',
    });
    const fetchMock = jest.fn().mockRejectedValue(tokenError);
    (provider as any).fetch = fetchMock;
    (provider as any).readOrFetch = jest.fn().mockResolvedValue(await image('png'));

    await expect(
      provider.post(
        'page-1',
        'token',
        videoPost({
          path: 'https://uploads.example.com/video.mp4',
          thumbnail: 'https://uploads.example.com/cover.png',
        }),
        integration
      )
    ).rejects.toBe(tokenError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts the video without a cover when the cover cannot be read', async () => {
    const fetchMock = mockVideoUpload(provider);
    (provider as any).readOrFetch = jest
      .fn()
      .mockRejectedValue(new Error('404'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await provider.post(
      'page-1',
      'token',
      videoPost({
        path: 'https://uploads.example.com/video.mp4',
        thumbnail: 'https://uploads.example.com/cover.png',
      }),
      integration
    );

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body).file_url).toBe(
      'https://uploads.example.com/video.mp4'
    );
  });

  it('does not touch photo posts', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ id: 'photo-1' }) })
      .mockResolvedValueOnce({
        json: async () => ({
          id: 'page-1_post-1',
          permalink_url: 'https://fb/p',
        }),
      });
    (provider as any).fetch = fetchMock;
    const readOrFetch = jest.fn();
    (provider as any).readOrFetch = readOrFetch;

    await provider.post(
      'page-1',
      'token',
      videoPost({
        path: 'https://uploads.example.com/photo.jpg',
        thumbnail: 'https://uploads.example.com/cover.jpg',
      }),
      integration
    );

    expect(readOrFetch).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toContain('/page-1/photos');
  });
});
