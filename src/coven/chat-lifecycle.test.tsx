import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatLifecycleControls } from './chat-lifecycle';

describe('ChatLifecycleControls', () => {
  it('describes deletion in terms of the saved local transcript only', () => {
    render(
      <ChatLifecycleControls
        id="one"
        title="First head"
        archived={false}
        disabled={false}
        pending={false}
        error=""
        onChange={() => {}}
      />,
    );
    const description = document.getElementById('coven-delete-description');
    expect(description).toHaveTextContent(/saved local transcript/i);
    expect(description).not.toHaveTextContent(/import/i);
  });
});
