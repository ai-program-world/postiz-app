import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class GetAnalyticsPostsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  date: number;

  @IsString()
  @IsNotEmpty()
  cursor: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
