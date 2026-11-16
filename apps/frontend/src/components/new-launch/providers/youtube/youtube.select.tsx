'use client';

import { FC, useEffect, useState } from 'react';
import { Select } from '@gitroom/react/form/select';
import { useCustomProviderFunction } from '@gitroom/frontend/components/launches/helpers/use.custom.provider.function';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';

// Loads the options from a YouTube provider tool (categories / playlists), an
// empty value keeps the YouTube default (channel category, no playlist).
export const YoutubeSelect: FC<{
  name: string;
  label: string;
  method: 'categories' | 'playlists';
  emptyLabel: string;
  onChange: (event: {
    target: {
      value: string;
      name: string;
    };
  }) => void;
}> = (props) => {
  const { onChange, name, label, method, emptyLabel } = props;
  const customFunc = useCustomProviderFunction();
  const [list, setList] = useState<undefined | any[]>();
  const { getValues } = useSettings();
  const [current, setCurrent] = useState<string | undefined>();
  const onChangeInner = (event: {
    target: {
      value: string;
      name: string;
    };
  }) => {
    setCurrent(event.target.value);
    onChange(event);
  };
  useEffect(() => {
    customFunc
      .get(method)
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => setList([]));
    const settings = getValues()[name];
    if (settings) {
      setCurrent(settings);
    }
  }, []);
  if (!list) {
    return null;
  }
  return (
    <Select name={name} label={label} onChange={onChangeInner} value={current}>
      <option value="">{emptyLabel}</option>
      {list.map((item: any) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </Select>
  );
};
