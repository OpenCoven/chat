import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { FamButton } from '../design/familiars-ui';
import { type Companion, type CompanionStatus, defaultCompanion } from '../lib/companion';
import { CopyButton } from './copy-button';
import './companion-panel.css';

export function CompanionPanel({ client = defaultCompanion }: { client?: Companion }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        className="coven-companion-open"
        type="button"
        ref={opener}
        onClick={() => setOpen(true)}
      >
        iPhone companion
      </button>
      {open && (
        <CompanionDialog
          client={client}
          close={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        />
      )}
    </>
  );
}

function CompanionDialog({ client, close }: { client: Companion; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const operation = useRef(0);
  const mutating = useRef(false);
  const [status, setStatus] = useState<CompanionStatus>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [qr, setQr] = useState('');
  const [confirmForget, setConfirmForget] = useState(false);
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal?.();
    void client
      .status()
      .then((value) => {
        if (alive.current) setStatus(value);
      })
      .catch((reason: unknown) => {
        if (alive.current) setError(message(reason));
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
    const timer = setInterval(() => {
      if (mutating.current) return;
      const expected = operation.current;
      void client
        .status()
        .then((value) => {
          if (alive.current && expected === operation.current) setStatus(value);
        })
        .catch((reason: unknown) => {
          if (alive.current && expected === operation.current) setError(message(reason));
        });
    }, 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [client]);
  const link = status?.enabled ? status.pairingLink : undefined;
  useEffect(() => {
    let current = true;
    setQr('');
    if (link)
      void QRCode.toString(link, { type: 'svg', width: 280, margin: 4, errorCorrectionLevel: 'M' })
        .then((value) => {
          if (current) setQr(`data:image/svg+xml,${encodeURIComponent(value)}`);
        })
        .catch(() => {
          if (current) setError('The QR code could not be drawn. Copy the pairing link instead.');
        });
    return () => {
      current = false;
    };
  }, [link]);
  async function change(action: 'enable' | 'disable' | 'forget') {
    operation.current += 1;
    mutating.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await client[action]();
      if (alive.current) {
        setStatus(value);
        setConfirmForget(false);
      }
    } catch (reason) {
      if (alive.current) setError(message(reason));
    } finally {
      mutating.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="coven-companion-dialog"
      aria-labelledby="companion-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="coven-companion-heading">
        <h2 id="companion-title">iPhone companion</h2>
        <FamButton size="sm" aria-label="Close companion" onClick={close}>
          Close
        </FamButton>
      </div>
      <p>
        Chat with your familiars from your iPhone. Keep this Mac awake with Chat running, on the
        same local network.
      </p>
      <output>
        {busy
          ? 'Checking companion…'
          : status?.enabled
            ? 'Companion is on'
            : status
              ? 'Companion is off'
              : 'Companion unavailable'}
      </output>
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
      {link && (
        <div className="coven-companion-pairing">
          {qr && <img src={qr} width={280} height={280} alt="Scan with Chat on your iPhone" />}
          <p>
            In Chat on iPhone, choose <strong>Pair with your Mac</strong> and scan this code, or
            paste the link.
          </p>
          <label>
            Private pairing link
            <input aria-label="Private pairing link" value={link} readOnly spellCheck={false} />
          </label>
          <CopyButton text={link} label="Copy pairing link" />
          <p className="coven-companion-note">
            This link grants access to your Chat conversations. Share it only with your own phone.
          </p>
        </div>
      )}
      <div className="coven-companion-actions">
        {status && (
          <FamButton
            disabled={busy}
            onClick={() => void change(status.enabled ? 'disable' : 'enable')}
          >
            {status.enabled ? 'Turn off' : 'Turn on companion'}
          </FamButton>
        )}
        {status && (
          <FamButton disabled={busy} onClick={() => setConfirmForget(true)}>
            Forget paired phones
          </FamButton>
        )}
      </div>
      {confirmForget && (
        <div className="coven-companion-confirm">
          <p>Forget all paired phones? They will need a new pairing code to connect again.</p>
          <FamButton disabled={busy} onClick={() => void change('forget')}>
            Forget all phones
          </FamButton>
          <FamButton disabled={busy} onClick={() => setConfirmForget(false)}>
            Cancel
          </FamButton>
        </div>
      )}
    </dialog>
  );
}

function message(reason: unknown): string {
  return (
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Companion could not be updated.'
  ).slice(0, 2048);
}
