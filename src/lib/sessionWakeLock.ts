/**
 * Best-effort Screen Wake Lock while the logged-in tab is visible.
 * Does not stop Chromium from throttling fully backgrounded tabs, but
 * reduces “asleep” while the window is open/visible so presence keeps ticking.
 */

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
};

let sentinel: WakeLockSentinelLike | null = null;
let desired = false;

function canRequest(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'wakeLock' in navigator &&
    typeof document !== 'undefined' &&
    !document.hidden
  );
}

async function acquire(): Promise<void> {
  if (!desired || !canRequest()) return;
  if (sentinel && !sentinel.released) return;
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
    };
    const lock = await nav.wakeLock!.request('screen');
    sentinel = lock;
    sentinel.addEventListener('release', () => {
      sentinel = null;
      if (desired && !document.hidden) {
        void acquire();
      }
    });
  } catch (e) {
    // Permission denied, battery saver, unsupported — ignore
    console.debug('[WakeLock] unavailable', e);
  }
}

async function release(): Promise<void> {
  const cur = sentinel;
  sentinel = null;
  if (cur && !cur.released) {
    try {
      await cur.release();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Enable wake lock for the session. Re-acquires when the tab becomes visible again.
 * Returns a cleanup that disables the lock.
 */
export function startSessionWakeLock(): () => void {
  desired = true;
  void acquire();

  const onVisibility = () => {
    if (document.hidden) {
      void release();
    } else if (desired) {
      void acquire();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    desired = false;
    document.removeEventListener('visibilitychange', onVisibility);
    void release();
  };
}
