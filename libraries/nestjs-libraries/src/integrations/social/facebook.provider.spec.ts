import 'reflect-metadata';

jest.mock('@gitroom/nestjs-libraries/temporal/temporal.heartbeat', () => ({
  setHeartbeatDetails: jest.fn(),
}));

import { FacebookProvider } from './facebook.provider';

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
    const readOrFetch = jest
      .fn()
      .mockResolvedValue(Buffer.from('cover-image-bytes'));
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
    expect(Buffer.from(await thumb.arrayBuffer()).toString()).toBe(
      'cover-image-bytes'
    );
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
