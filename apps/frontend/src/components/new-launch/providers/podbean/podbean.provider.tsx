'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { PodbeanDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/podbean.dto';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { MediaComponent } from '@gitroom/frontend/components/media/media.component';

const episodeTypes = [
  { value: 'full', label: 'Full' },
  { value: 'trailer', label: 'Trailer' },
  { value: 'bonus', label: 'Bonus' },
];

const SettingsComponent = () => {
  const form = useSettings();

  return (
    <div className="flex flex-col">
      <Input label="Episode title" {...form.register('title')} />
      <Select
        label="Episode type"
        {...form.register('episodeType', {
          value: 'full',
        })}
      >
        {episodeTypes.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      <MediaComponent
        type="audio"
        label="Episode audio"
        description="Upload or select an .mp3 file"
        {...form.register('audio')}
      />
    </div>
  );
};

export default withProvider({
  postComment: PostComment.POST,
  comments: false,
  minimumCharacters: [],
  SettingsComponent: SettingsComponent,
  CustomPreviewComponent: undefined,
  dto: PodbeanDto,
  maximumCharacters: 100000,
});
