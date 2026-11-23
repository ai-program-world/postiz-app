import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class GetPostsAnalyticsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  postIds: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  date?: number;

  @IsOptional()
  @IsBoolean()
  refresh?: boolean;
}
