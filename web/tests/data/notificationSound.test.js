import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationSoundPlayer } from '../../src/data/notificationSound.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, val) => map.set(key, String(val)),
  };
}

function createFakeAudioContextClass(log) {
  return class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 1.0;
      this.destination = { id: 'dest' };
    }
    async resume() {
      log.resumed += 1;
      this.state = 'running';
    }
    createOscillator() {
      const osc = {
        type: '',
        frequency: { setValueAtTime: (freq, at) => log.notes.push({ freq, at, type: osc.type }) },
        connect() {},
        start(at) { log.starts.push(at); },
        stop(at) { log.stops.push(at); },
      };
      return osc;
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
      };
    }
    async close() {
      log.closed += 1;
    }
  };
}

test('createNotificationSoundPlayer plays distinct success/error cues and persists mute toggle', async () => {
  const storage = createMemoryStorage();
  const log = { resumed: 0, notes: [], starts: [], stops: [], closed: 0 };
  const player = createNotificationSoundPlayer({
    AudioContextClass: createFakeAudioContextClass(log),
    storage,
  });

  assert.equal(player.isMuted(), false);
  player.unlock();
  assert.equal(log.resumed, 1);

  const playedSuccess = await player.play('success');
  assert.equal(playedSuccess, true);
  assert.equal(log.notes.length, 2);
  assert.ok(log.notes[1].freq > log.notes[0].freq);

  const playedError = await player.play('error');
  assert.equal(playedError, true);
  assert.equal(log.notes.length, 4);
  assert.ok(log.notes[3].freq < log.notes[2].freq);

  assert.equal(player.setMuted(true), true);
  assert.equal(storage.getItem('voxcpm.notificationSoundMuted'), 'true');
  assert.equal(await player.play('success'), false);
  assert.equal(log.notes.length, 4);

  const reloaded = createNotificationSoundPlayer({ storage });
  assert.equal(reloaded.isMuted(), true);
  player.close();
  assert.equal(log.closed, 1);
});

test('createNotificationSoundPlayer degrades cleanly when Web Audio or storage is unavailable and recovers from closed context', async () => {
  const safePlayer = createNotificationSoundPlayer({ AudioContextClass: null, storage: null });
  safePlayer.unlock();
  assert.equal(await safePlayer.play('success'), false);
  assert.equal(safePlayer.setMuted(true), true);
  assert.equal(safePlayer.isMuted(), true);

  let created = 0;
  let lastCreatedCtx = null;
  const BaseCtx = createFakeAudioContextClass({ resumed: 0, notes: [], starts: [], stops: [], closed: 0 });
  class ClosableCtx extends BaseCtx {
    constructor() {
      super();
      created += 1;
      this.id = created;
      lastCreatedCtx = this;
    }
    async close() {
      this.state = 'closed';
    }
  }
  const recoverable = createNotificationSoundPlayer({ AudioContextClass: ClosableCtx, storage: createMemoryStorage() });
  assert.equal(await recoverable.play('success'), true);
  assert.equal(created, 1);
  // Simulate genuine external/browser closure of the underlying AudioContext without calling player.close()
  lastCreatedCtx.state = 'closed';
  recoverable.unlock();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(await recoverable.play('error'), true);
  assert.equal(created, 2);
  recoverable.close();
});

test('createNotificationSoundPlayer resumes interrupted iOS Safari AudioContext and logs storage/close/unlock errors', async () => {
  const debugLogs = [];
  const warnLogs = [];
  const logger = {
    debug: (loc, msg) => debugLogs.push({ loc, msg }),
    warn: (loc, msg) => warnLogs.push({ loc, msg }),
  };

  // 1. Storage SecurityError during window.localStorage resolution logs via logger.debug and degrades to null
  const prevWindow = globalThis.window;
  globalThis.window = {
    get localStorage() {
      throw new Error('SecurityError: blocked');
    },
  };
  let closeShouldReject = true;
  let createdCount = 0;
  let activeCtx = null;
  const log = { resumed: 0, notes: [], starts: [], stops: [], closed: 0 };
  const BaseCtx = createFakeAudioContextClass(log);
  class InterruptedCtx extends BaseCtx {
    constructor() {
      super();
      createdCount += 1;
      this.state = 'interrupted';
      activeCtx = this;
    }
    async close() {
      log.closed += 1;
      if (closeShouldReject) throw new Error('close failed');
    }
  }
  try {
    const player = createNotificationSoundPlayer({ AudioContextClass: InterruptedCtx, logger });
    assert.equal(debugLogs.some(e => e.loc === 'notificationSound.resolveStorage'), true);
    assert.equal(player.isMuted(), false);

    // 2. unlock() resumes initial 'interrupted' AudioContext
    player.unlock();
    assert.equal(log.resumed, 1);
    assert.equal(activeCtx.state, 'running');
    assert.equal(createdCount, 1);

    // 3. Existing 'running' AudioContext transitioning externally to 'interrupted' is resumed by play() without recreating
    activeCtx.state = 'interrupted';
    assert.equal(await player.play('success'), true);
    assert.equal(createdCount, 1);
    assert.equal(log.resumed, 2);
    assert.equal(log.notes.length, 2);

    // 4. Existing 'running' AudioContext transitioning externally to 'interrupted' is also resumed by unlock()
    activeCtx.state = 'interrupted';
    player.unlock();
    assert.equal(createdCount, 1);
    assert.equal(log.resumed, 3);

    // 5. Running context does not invoke redundant resume()
    assert.equal(await player.play('error'), true);
    assert.equal(log.resumed, 3);
    assert.equal(log.notes.length, 4);

    // 6. Async close() rejection is logged via logger.debug
    player.close();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(debugLogs.some(e => e.loc === 'notificationSound.close'), true);
    closeShouldReject = false;

    // 7. Synchronous throw from close() is also logged cleanly
    class SyncThrowCloseCtx extends BaseCtx {
      close() {
        throw new Error('sync close failure');
      }
    }
    const syncPlayer = createNotificationSoundPlayer({ AudioContextClass: SyncThrowCloseCtx, storage: createMemoryStorage(), logger });
    assert.equal(await syncPlayer.play('success'), true);
    syncPlayer.close();
    assert.equal(debugLogs.filter(e => e.loc === 'notificationSound.close').length, 2);

    // 8. unlock() async rejection and sync throw both log via logger.debug
    class FailingResumeCtx extends BaseCtx {
      resume() {
        return Promise.reject(new Error('unlock rejected'));
      }
    }
    const rejectPlayer = createNotificationSoundPlayer({ AudioContextClass: FailingResumeCtx, storage: createMemoryStorage(), logger });
    rejectPlayer.unlock();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(debugLogs.filter(e => e.loc === 'notificationSound.unlock').length, 1);

    class SyncThrowResumeCtx extends BaseCtx {
      resume() {
        throw new Error('sync unlock throw');
      }
    }
    const syncResumePlayer = createNotificationSoundPlayer({ AudioContextClass: SyncThrowResumeCtx, storage: createMemoryStorage(), logger });
    syncResumePlayer.unlock();
    assert.equal(debugLogs.filter(e => e.loc === 'notificationSound.unlock').length, 2);

    // 9. Storage getItem/setItem errors log via logger.warn
    const failingStorage = {
      getItem() { throw new Error('read blocked'); },
      setItem() { throw new Error('quota full'); },
    };
    const storageErrPlayer = createNotificationSoundPlayer({ AudioContextClass: null, storage: failingStorage, logger });
    storageErrPlayer.setMuted(true);
    assert.equal(warnLogs.some(e => e.loc === 'notificationSound.readMutedFlag'), true);
    assert.equal(warnLogs.some(e => e.loc === 'notificationSound.writeMutedFlag'), true);
  } finally {
    globalThis.window = prevWindow;
  }
});
