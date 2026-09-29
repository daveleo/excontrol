import type { ConfigRecovery } from "@excontrol/shared";

/** The settings file was unusable at start-up (backend config.ts). Installer dashboard: always
 *  explained. Customer view: only when nothing could be restored — then the room really needs
 *  service; a silent restore is not the customer's problem. */
export function RecoveryBanner({ recovery, customer }: { recovery?: ConfigRecovery; customer?: boolean }) {
  if (!recovery) return null;
  if (customer) {
    return recovery.restored ? null : (
      <div className="recovery-banner" role="alert">
        This control panel needs service — its settings could not be loaded. Please contact your installer.
      </div>
    );
  }
  return (
    <div className="recovery-banner" role="alert">
      {recovery.restored ? (
        <>
          <strong>Settings restored.</strong> The settings file was damaged (usually a power cut) and the last good copy
          was loaded. The damaged file is kept as <code>{recovery.keptAs}</code>. This notice clears on the next save.
        </>
      ) : (
        <>
          <strong>Settings could not be loaded</strong> and no good copy exists, so the setup is empty. The damaged file
          is kept as <code>{recovery.keptAs}</code> — import a backup under Setup › Backup, or set the system up again.
        </>
      )}
    </div>
  );
}
