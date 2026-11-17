import { IsDefined, IsString, Matches, Validate } from 'class-validator';
import { ValidUrlPath } from '@gitroom/helpers/utils/valid.url.path';

// An .mp3 from the media library, used by podcast providers in their settings;
// never a post attachment (MediaDto only accepts pictures and mp4)
export class AudioMediaDto {
  @IsString()
  @IsDefined()
  id: string;

  @IsString()
  @IsDefined()
  @Validate(ValidUrlPath)
  @Matches(/\.mp3(\?.*)?$/i, { message: 'Audio must be an .mp3 file' })
  path: string;
}
