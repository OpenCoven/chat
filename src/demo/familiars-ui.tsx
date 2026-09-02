import type { ButtonHTMLAttributes, CSSProperties } from 'react';

import { Icon, type IconName } from './minimal-icons';
import type { MockFamiliar } from './mock-familiars';

/**
 * The handful of primitives the Familiars Redesign v2 surface builds on.
 *
 * The design imports these from the Coven Cave design-system bundle
 * (`CovenCave.Button`, `IconButton`, `Segmented`, `ThinkingIndicator`). This
 * repository has no such bundle, so each is redrawn here with the same props
 * and the design's own overrides folded in, under `fr-*` class names.
 */

export type InspectorTab = 'overview' | 'access' | 'activity';
export type ActivityKey = 'completion' | 'duration' | 'tools' | 'recent';
export type AccessGroupKey = 'auto' | 'review' | 'paths' | 'contract';
export type DemoEmpty = 'conversations' | 'runs' | 'familiar';
export type Presence = MockFamiliar['status'];

export const INSPECTOR_TABS: readonly InspectorTab[] = ['overview', 'access', 'activity'];

/** Join class names, dropping the falsy ones. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

type AvatarProps = Readonly<{
  initial: string;
  size: 22 | 24 | 28 | 36;
  /** Draw the presence dot in this state. */
  presence?: Presence;
  /** Pulse the dot when the familiar is available. */
  live?: boolean;
  /** The accent ring that marks the active familiar. */
  ring?: boolean;
  /** Sit on `--bg-hover` rather than `--bg-elevated`, for menus and popovers. */
  elevated?: boolean;
  /** Presence dot diameter in pixels. */
  dot?: number;
  /** The dot's border matches the surface it sits on. */
  surface?: 'panel' | 'elevated';
}>;

export function Avatar({
  initial,
  size,
  presence,
  live,
  ring,
  elevated,
  dot = 10,
  surface = 'panel',
}: AvatarProps) {
  const font = size >= 36 ? 14 : size >= 28 ? 12 : size >= 24 ? 11 : 10;
  const style = { '--size': `${size}px`, '--font': `${font}px` } as CSSProperties;

  return (
    <span
      className={cx('fr-avatar', ring && 'fr-avatar--ring', elevated && 'fr-avatar--elevated')}
      style={style}
      aria-hidden="true"
    >
      {initial}
      {presence ? (
        <span
          className={cx(
            'fr-presence',
            live && presence === 'available' && 'fr-live',
            surface === 'elevated' && 'fr-presence--elevated',
          )}
          data-presence={presence}
          style={{ '--dot': `${dot}px` } as CSSProperties}
        />
      ) : null}
    </span>
  );
}

type FamButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  Readonly<{
    variant?: 'primary' | 'secondary' | 'ghost';
    size?: 'xs' | 'sm' | 'md';
    leadingIcon?: IconName;
    fullWidth?: boolean;
  }>;

export function FamButton({
  variant = 'secondary',
  size = 'md',
  leadingIcon,
  fullWidth,
  className,
  children,
  type = 'button',
  ...rest
}: FamButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'fr-btn',
        `fr-btn--${variant}`,
        `fr-btn--${size}`,
        fullWidth && 'fr-btn--full',
        className,
      )}
      {...rest}
    >
      {leadingIcon ? (
        <span className="fr-btn-icon" aria-hidden="true">
          <Icon name={leadingIcon} size={size === 'xs' ? 11 : 13} />
        </span>
      ) : null}
      {children}
    </button>
  );
}

type FamIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> &
  Readonly<{
    icon: IconName;
    /** The accessible name; also the tooltip unless `title` says otherwise. */
    label: string;
    size?: 'sm' | 'md';
    /** Mirror the glyph, as the design does for the inspector's sidebar icon. */
    flip?: boolean;
  }>;

export function FamIconButton({
  icon,
  label,
  size = 'md',
  flip,
  className,
  title,
  type = 'button',
  ...rest
}: FamIconButtonProps) {
  return (
    <button
      type={type}
      className={cx('fr-icon-btn', `fr-icon-btn--${size}`, flip && 'fr-flip', className)}
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 15 : 16} />
    </button>
  );
}

type SegmentedProps<T extends string> = Readonly<{
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  getLabel: (value: T) => string;
  label: string;
}>;

/**
 * A row of mutually exclusive buttons.
 *
 * `aria-pressed` rather than a tablist: the design system renders it as a
 * group of toggles, and the inspector's panels are one region whose contents
 * change rather than three panels that exist at once.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  getLabel,
  label,
}: SegmentedProps<T>) {
  return (
    <fieldset aria-label={label} className="fr-segmented">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className="fr-segmented-option"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {getLabel(option)}
        </button>
      ))}
    </fieldset>
  );
}

export function ThinkingIndicator({ label }: { label: string }) {
  return (
    <output className="fr-thinking" aria-live="polite">
      <span className="fr-thinking-dots" aria-hidden="true">
        <span className="fr-thinking-dot" />
        <span className="fr-thinking-dot" />
        <span className="fr-thinking-dot" />
      </span>
      <span>{label}</span>
    </output>
  );
}
