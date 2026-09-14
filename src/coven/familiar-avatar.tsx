import { type CSSProperties, useState } from 'react';
import { cx } from '../demo/familiars-ui';

export type FamiliarAvatarProps = {
  name: string;
  avatarUrl?: string | undefined;
  size: 22 | 24 | 28 | 36;
  ring?: boolean;
};

export function FamiliarAvatar({ name, avatarUrl, size, ring }: FamiliarAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const source =
    avatarUrl &&
    avatarUrl !== failedUrl &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatarUrl)
      ? avatarUrl
      : undefined;
  const font = size >= 36 ? 14 : size >= 28 ? 12 : size >= 24 ? 11 : 10;
  return (
    <span
      className={cx('fr-avatar', ring && 'fr-avatar--ring')}
      style={{ '--size': `${size}px`, '--font': `${font}px` } as CSSProperties}
    >
      {source ? (
        <img
          key={source}
          className="coven-avatar-image"
          src={source}
          alt={`${name} avatar`}
          width={size}
          height={size}
          onError={() => setFailedUrl(source)}
        />
      ) : (
        <span role="img" aria-label={`${name} avatar (initial)`}>
          {name[0] ?? '?'}
        </span>
      )}
    </span>
  );
}
