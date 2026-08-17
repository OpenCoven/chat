type MessageCarrier = Readonly<{
  message: string;
}>;

function isMessageCarrier(value: unknown): value is MessageCarrier {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string' &&
    value.message.trim().length > 0
  );
}

export function normalizeRejectionMessage(rejection: unknown, fallbackMessage: string): string {
  if (rejection instanceof Error) {
    const message = rejection.message.trim();
    if (message.length > 0) {
      return message;
    }
  }

  if (typeof rejection === 'string') {
    const message = rejection.trim();
    if (message.length > 0) {
      return message;
    }
  }

  if (isMessageCarrier(rejection)) {
    return rejection.message.trim();
  }

  return fallbackMessage;
}
