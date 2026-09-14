import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FamiliarAvatar } from './familiar-avatar';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';

describe('FamiliarAvatar', () => {
  it('renders the supplied PNG at the demo size with its accent ring', () => {
    render(<FamiliarAvatar name="Astra" avatarUrl={png} size={28} ring />);
    const image = screen.getByRole('img', { name: 'Astra avatar' });
    expect(image).toHaveAttribute('src', png);
    expect(image.closest('.fr-avatar--ring')).toHaveStyle('--size: 28px');
  });

  it('uses an accessible initial when the native avatar is missing', () => {
    render(<FamiliarAvatar name="Kitty" size={22} />);
    expect(screen.getByRole('img', { name: 'Kitty avatar (initial)' })).toHaveTextContent('K');
  });

  it('falls back on image failure and recovers when the supplied URL changes', () => {
    const view = render(<FamiliarAvatar name="Astra" avatarUrl={png} size={36} ring />);
    fireEvent.error(screen.getByRole('img', { name: 'Astra avatar' }));
    expect(screen.getByRole('img', { name: 'Astra avatar (initial)' })).toHaveTextContent('A');
    view.rerender(
      <FamiliarAvatar name="Echo" avatarUrl="data:image/png;base64,YWJj" size={36} ring />,
    );
    expect(screen.getByRole('img', { name: 'Echo avatar' })).toHaveAttribute(
      'src',
      'data:image/png;base64,YWJj',
    );
  });

  it.each([
    'file:///private/avatar.png',
    'https://example.com/avatar.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
  ])('does not load non-native PNG sources: %s', (avatarUrl) => {
    const { container } = render(<FamiliarAvatar name="Echo" avatarUrl={avatarUrl} size={24} />);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Echo avatar (initial)' })).toHaveTextContent('E');
  });
});
