import { countLength, textSlicer } from './count.length';

describe('countLength & textSlicer', () => {
  describe('Threads character counting (1 Unicode code point = 1 char)', () => {
    it('counts Traditional Chinese characters as 1 character each instead of 3 UTF-8 bytes', () => {
      const zhTwText = '繁體中文測試貼文：媽媽寶寶日常分享！';
      expect(zhTwText.length).toBe(18);
      expect(Buffer.byteLength(zhTwText, 'utf8')).toBe(54);
      expect(countLength('threads', zhTwText)).toBe(18);
    });

    it('accepts a 500-character Traditional Chinese Threads post without overflow', () => {
      const fiveHundredCjk = '測'.repeat(500);
      expect(countLength('threads', fiveHundredCjk)).toBe(500);

      const sliced = textSlicer('threads', 500, fiveHundredCjk);
      expect(fiveHundredCjk.slice(sliced.start, sliced.end)).toBe(
        fiveHundredCjk
      );
    });

    it('counts astral emojis (surrogate pairs) as 1 code point on Threads and slices cleanly without splitting surrogates', () => {
      const text = '育兒🎉👶✨日常';
      // 4 CJK + 3 code points (🎉, 👶, ✨; note ✨ is BMP, 🎉 & 👶 are astral surrogate pairs)
      expect([...text].length).toBe(7);
      expect(countLength('threads', text)).toBe(7);

      // Slice at 4 code points -> '育兒🎉👶' (UTF-16 length = 2 + 2 + 2 = 6, not 4!)
      const slice4 = textSlicer('threads', 4, text);
      expect(text.slice(slice4.start, slice4.end)).toBe('育兒🎉👶');
    });

    it('counts URLs by raw character count on Threads (unlike X 23-char t.co wrapping)', () => {
      const urlPost = '看看這篇 https://mamababy.example.com/articles/2026-guide';
      expect(countLength('threads', urlPost)).toBe([...urlPost].length);
      expect(countLength('x', urlPost)).not.toBe(
        countLength('threads', urlPost)
      );
    });
  });

  describe('X / Twitter weighted length regression check', () => {
    it('still counts CJK as weight 2 on X while Threads counts as 1', () => {
      const sample = '繁體中文';
      expect(countLength('x', sample)).toBe(8);
      expect(countLength('threads', sample)).toBe(4);
    });
  });
});
