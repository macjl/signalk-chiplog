import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectionProblem, createConnection, watchConnection } from '../public/js/connection.mjs';

const failure = (status, code) => Object.assign(new Error(code), { status, code });
const NETWORK = failure(0, 'network');
const SIGNED_OUT = failure(401, 'forbidden');

// A probe that answers with whatever the test last set.
function server() {
  const control = { answer: null, calls: 0 };
  control.probe = async () => {
    control.calls += 1;
    if (control.answer) {
      throw control.answer;
    }
    return {};
  };
  return control;
}

describe('connection problems', () => {
  it('tells a lost link and a lost login from errors about the request', () => {
    assert.equal(connectionProblem(NETWORK), 'offline');
    assert.equal(connectionProblem(failure(502, 'http_error')), 'offline');
    assert.equal(connectionProblem(failure(504, 'http_error')), 'offline');
    assert.equal(connectionProblem(SIGNED_OUT), 'signedOut');
    assert.equal(connectionProblem(failure(503, 'plugin_not_started')), null);
    assert.equal(connectionProblem(failure(404, 'entry_not_found')), null);
    assert.equal(connectionProblem(failure(409, 'conflict')), null);
    assert.equal(connectionProblem(null), null);
  });
});

describe('connection', () => {
  it('goes offline on a network failure and back on the next success', () => {
    const link = createConnection({ probe: server().probe });
    const seen = [];
    link.subscribe((snapshot) => seen.push(snapshot.state));

    assert.equal(link.report(NETWORK), 'offline');
    assert.equal(link.snapshot().state, 'offline');
    link.observe(200);

    assert.deepEqual(seen, ['offline', 'connected']);
    assert.equal(link.snapshot().restored, 1);
  });

  it('counts a return only when the link was actually lost', () => {
    const link = createConnection({ probe: server().probe });
    link.observe(200);
    link.observe(204);
    assert.equal(link.snapshot().restored, 0);
  });

  it('takes any answer past the login as the server being back', () => {
    const link = createConnection({ probe: server().probe });
    link.report(NETWORK);
    assert.equal(link.report(failure(503, 'plugin_not_started')), null);
    assert.equal(link.snapshot().state, 'connected');
  });

  it('checks a 401 before calling the login lost', async () => {
    const remote = server();
    const link = createConnection({ probe: remote.probe });

    // The probe gets in: the account lacks the rights for that one request.
    link.report(SIGNED_OUT);
    assert.equal(link.snapshot().checking, true);
    assert.equal(await link.check(), 'connected');
    assert.equal(link.snapshot().restored, 0);

    // The probe is refused too: the login is gone.
    remote.answer = SIGNED_OUT;
    link.report(SIGNED_OUT);
    assert.equal(await link.check(), 'signedOut');
    assert.equal(remote.calls, 2);

    // Further refusals add no probe while it stays so.
    link.report(SIGNED_OUT);
    assert.equal(link.snapshot().checking, false);
    assert.equal(remote.calls, 2);
  });

  it('runs one probe at a time and reports what it found', async () => {
    const remote = server();
    const link = createConnection({ probe: remote.probe });
    link.report(NETWORK);

    remote.answer = NETWORK;
    const [first, second] = await Promise.all([link.check(), link.check()]);
    assert.deepEqual([first, second], ['offline', 'offline']);
    assert.equal(remote.calls, 1);

    remote.answer = SIGNED_OUT;
    assert.equal(await link.check(), 'signedOut');

    remote.answer = null;
    assert.equal(await link.check(), 'connected');
    assert.equal(link.snapshot().restored, 1);
  });

  it('treats a probe refused for another reason as a server that answers', async () => {
    const remote = server();
    const link = createConnection({ probe: remote.probe });
    link.report(NETWORK);
    remote.answer = failure(503, 'plugin_not_started');
    assert.equal(await link.check(), 'connected');
  });

  it('stops telling a listener once it unsubscribes', () => {
    const link = createConnection({ probe: server().probe });
    let calls = 0;
    const stop = link.subscribe(() => (calls += 1));
    link.report(NETWORK);
    stop();
    link.observe(200);
    assert.equal(calls, 1);
  });
});

describe('connection watcher', () => {
  function target() {
    const handlers = new Map();
    return {
      handlers,
      visibilityState: 'visible',
      addEventListener: (name, handler) => handlers.set(name, handler),
      removeEventListener: (name) => handlers.delete(name),
      fire: (name) => handlers.get(name)?.()
    };
  }

  it('looks again when the network returns or the page is back in view', async () => {
    const remote = server();
    const link = createConnection({ probe: remote.probe });
    const win = target();
    const doc = target();
    const stop = watchConnection(link, { window: win, document: doc });

    win.fire('focus');
    assert.equal(remote.calls, 0, 'nothing to check while connected');

    link.report(NETWORK);
    remote.answer = NETWORK;
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    assert.equal(remote.calls, 0, 'not while hidden');

    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await link.check();
    win.fire('online');
    await link.check();
    assert.equal(remote.calls, 2);

    stop();
    assert.equal(win.handlers.size + doc.handlers.size, 0);
  });
});
