'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { TransistorDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/transistor.dto';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { MediaComponent } from '@gitroom/frontend/components/media/media.component';
import { SelectShow } from '@gitroom/frontend/components/new-launch/providers/transistor/select.show';

const episodeTypes = [
  { value: 'full', label: 'Full' },
  { value: 'trailer', label: 'Trailer' },
  { value: 'bonus', label: 'Bonus' },
];

const SettingsComponent = () => {
  const form = useSettings();

  return (
    <div className="flex flex-col">
      <SelectShow {...form.register('show')} />
      <Input label="Episode title" {...form.register('title')} />
      <Input label="Summary" {...form.register('summary')} />
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
  dto: TransistorDto,
  maximumCharacters: 100000,
});
