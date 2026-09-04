/** What `GET /api/client/v1/health` reports, mocked. */
export const MOCK_HEALTH = {
  service: 'coven-cave',
  apiVersion: '1.4',
  minimumClientVersion: '1.0',
  instanceId: 'cave-7f3a91c2',
  pairingRequired: true,
  capabilities: ['attachments', 'attention', 'task-handoff', 'github-actions'] as const,
};

/** The paired credential, as the paired-clients surface would describe it. */
export const MOCK_CREDENTIAL = {
  label: 'OpenCoven Chat (desktop)',
  scopes: ['chat:read', 'chat:send', 'conversations:write', 'attachments:write'],
  createdAt: '12 August 2026',
  lastUsed: '4 minutes ago',
};
