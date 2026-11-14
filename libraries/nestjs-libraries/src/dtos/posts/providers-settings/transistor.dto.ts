import {
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JSONSchema } from 'class-validator-jsonschema';
import { AudioMediaDto } from '@gitroom/nestjs-libraries/dtos/media/audio.media.dto';

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
  @Type(() => AudioMediaDto)
  @JSONSchema({
    description:
      'The episode audio, an .mp3 from the media library (upload it with uploadFromUrlTool first)',
  })
  audio: AudioMediaDto;
}
