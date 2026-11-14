import {
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JSONSchema } from 'class-validator-jsonschema';
import { ValidUrlPath } from '@gitroom/helpers/utils/valid.url.path';

export class TransistorAudioDto {
  @IsString()
  @IsDefined()
  id: string;

  @IsString()
  @IsDefined()
  @Validate(ValidUrlPath)
  @Matches(/\.mp3(\?.*)?$/i, { message: 'Audio must be an .mp3 file' })
  path: string;
}

export class TransistorDto {
  @IsString()
  @IsDefined()
  @JSONSchema({
    description: 'Show must be an id',
  })
  show: string;

  @IsString()
  @MinLength(1)
  @MaxLength(250)
  @IsDefined()
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(4000)
  summary?: string;

  @IsIn(['full', 'trailer', 'bonus'])
  @IsOptional()
  episodeType?: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => TransistorAudioDto)
  @JSONSchema({
    description:
      'The episode audio, an .mp3 from the media library (upload it with uploadFromUrlTool first)',
  })
  audio: TransistorAudioDto;
}
