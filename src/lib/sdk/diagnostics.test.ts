import { presentDiagnostics, presentError } from './diagnostics';

describe('presentation diagnostics', () => {
  it('maps allowlisted native checks to fixed user-safe copy', () => {
    expect(
      presentDiagnostics({
        version: 1,
        platform: 'darwin',
        architecture: 'aarch64',
        checks: [
          {
            component: 'cave_credential_custody',
            status: 'unavailable',
            code: 'secure_store_unavailable',
          },
        ],
      }),
    ).toEqual({
      platform: 'macOS · aarch64',
      checks: [
        {
          label: 'Credential storage',
          status: 'Unavailable',
          detail: 'Secure credential storage is unavailable on this device.',
        },
      ],
    });
  });

  it('never includes raw causes, paths, prompts, messages, attachments, or secret-shaped text', () => {
    const source = {
      code: 'service_unavailable',
      retryable: true,
      diagnosticId: '00000000-0000-4000-8000-000000000003',
      cause: '/Users/person/private/keychain',
      prompt: 'sensitive prompt',
      message: 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      attachment: { name: 'private.pdf' },
    };

    expect(JSON.stringify(presentError(source))).toBe(
      JSON.stringify({
        title: 'Connection unavailable',
        detail: 'OpenCoven could not be reached. Try again when the local service is available.',
        diagnosticId: 'local-diagnostic',
      }),
    );
  });
});
