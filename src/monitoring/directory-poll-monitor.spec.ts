import {
  DIRECTORY_POLL_MONITOR,
  DirectoryPollMonitor,
  OK_CHECK_IN_EVERY_MS,
} from './directory-poll-monitor';

// VRMS spec 0025, AC-10: throttled ok check ins, error at once, never throws.

function setup(start = 1_000_000) {
  let now = start;
  const send = jest.fn();
  const monitor = new DirectoryPollMonitor(send, () => now);
  return { monitor, send, advance: (ms: number) => (now += ms) };
}

const config = {
  schedule: { type: 'interval', value: 5, unit: 'minute' },
  checkinMargin: 5,
  maxRuntime: 2,
};

describe('DirectoryPollMonitor', () => {
  it('checks in ok on the first run after a boot, with the monitor config', () => {
    const { monitor, send } = setup();
    monitor.ok();
    expect(send).toHaveBeenCalledWith(
      { monitorSlug: DIRECTORY_POLL_MONITOR, status: 'ok' },
      config,
    );
  });

  it('sends no further ok until 5 minutes have passed', () => {
    const { monitor, send, advance } = setup();
    monitor.ok();
    advance(30_000);
    monitor.ok();
    advance(OK_CHECK_IN_EVERY_MS - 30_001);
    monitor.ok();
    expect(send).toHaveBeenCalledTimes(1);
    advance(1);
    monitor.ok();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('checks in error at once every time, and the next ok goes out at once', () => {
    const { monitor, send, advance } = setup();
    monitor.ok();
    advance(30_000);
    monitor.error();
    advance(30_000);
    monitor.error();
    expect(send).toHaveBeenNthCalledWith(
      2,
      { monitorSlug: DIRECTORY_POLL_MONITOR, status: 'error' },
      config,
    );
    expect(send).toHaveBeenCalledTimes(3);
    advance(30_000);
    monitor.ok();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith(
      { monitorSlug: DIRECTORY_POLL_MONITOR, status: 'ok' },
      config,
    );
  });

  it('never throws when sending fails, and tries the ok again on the next run', () => {
    const { monitor, send } = setup();
    send.mockImplementationOnce(() => {
      throw new Error('sdk broke');
    });
    expect(() => monitor.ok()).not.toThrow();
    expect(() => monitor.error()).not.toThrow();
    monitor.ok();
    expect(send).toHaveBeenCalledTimes(3);
  });
});
