import { afterEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './backup-harness';
import { backupNow, ownerOf, reopen, rig, seedA, setting } from './restore-harness';

let h: Harness;

afterEach(async () => {
  await h?.close();
});

describe('telemetry settings across restore', () => {
  it('keeps the live opt-out and install ID when restoring a backup from before opting out', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    h.directory!.setSetting('telemetry.enabled', '1');
    h.directory!.setSetting('telemetry.install_id', 'backup-install-id');
    const engine = rig(h);
    const backup = await backupNow(engine.backup);
    const owner = ownerOf(h);

    h.directory!.setSetting('telemetry.enabled', '0');
    h.directory!.setSetting('telemetry.install_id', 'live-install-id');
    await engine.restore.restoreWorkspace({ manifest: backup.manifest, confirm: 'RESTORE', actor: owner });

    const restored = reopen(h);
    try {
      expect(setting(restored, 'telemetry.enabled')).toBe('0');
      expect(setting(restored, 'telemetry.install_id')).toBe('live-install-id');
    } finally {
      restored.close();
    }
  });

  it('keeps live telemetry settings when restoring a backup made before those settings existed', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const engine = rig(h);
    const backup = await backupNow(engine.backup);
    const owner = ownerOf(h);

    h.directory!.setSetting('telemetry.enabled', '0');
    h.directory!.setSetting('telemetry.install_id', 'live-install-id');
    await engine.restore.restoreWorkspace({ manifest: backup.manifest, confirm: 'RESTORE', actor: owner });

    const restored = reopen(h);
    try {
      expect(setting(restored, 'telemetry.enabled')).toBe('0');
      expect(setting(restored, 'telemetry.install_id')).toBe('live-install-id');
    } finally {
      restored.close();
    }
  });

  it('does not bring back telemetry settings the live instance does not have', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    h.directory!.setSetting('telemetry.enabled', '1');
    h.directory!.setSetting('telemetry.install_id', 'backup-install-id');
    const engine = rig(h);
    const backup = await backupNow(engine.backup);
    const owner = ownerOf(h);

    // live: neither key was ever set (a fresh install restoring an older backup), and cloud.* behaviour is unchanged
    h.directory!.db.prepare("DELETE FROM settings WHERE key LIKE 'telemetry.%'").run();
    expect(setting(h.directory!, 'telemetry.enabled')).toBeNull();
    expect(setting(h.directory!, 'telemetry.install_id')).toBeNull();
    await engine.restore.restoreWorkspace({ manifest: backup.manifest, confirm: 'RESTORE', actor: owner });

    const restored = reopen(h);
    try {
      expect(setting(restored, 'telemetry.enabled')).toBeNull();
      expect(setting(restored, 'telemetry.install_id')).toBeNull();
    } finally {
      restored.close();
    }
  });

  it('does not change live telemetry settings when restoring one board as a copy', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    h.directory!.setSetting('telemetry.enabled', '1');
    h.directory!.setSetting('telemetry.install_id', 'backup-install-id');
    const engine = rig(h);
    const backup = await backupNow(engine.backup);

    h.directory!.setSetting('telemetry.enabled', '0');
    h.directory!.setSetting('telemetry.install_id', 'live-install-id');
    await engine.restore.restoreBoardCopy({ manifest: backup.manifest, boardId: 'b1', actor: ownerOf(h) });

    expect(setting(h.directory!, 'telemetry.enabled')).toBe('0');
    expect(setting(h.directory!, 'telemetry.install_id')).toBe('live-install-id');
  });
});
