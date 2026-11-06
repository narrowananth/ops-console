import { readFileSync } from 'node:fs';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

/** Records each note the page plays in place of the speaker. */
const STUB_AUDIO = () => {
  const played: number[] = [];
  const peaks: number[] = [];
  (window as unknown as { played: number[]; peaks: number[] }).played = played;
  (window as unknown as { peaks: number[] }).peaks = peaks;
  class Param {
    value = 0;
    setValueAtTime() {}
    linearRampToValueAtTime(value: number) {
      peaks.push(value);
    }
    exponentialRampToValueAtTime() {}
  }
  class Node {
    connect(next: unknown) {
      return next;
    }
  }
  class Oscillator extends Node {
    type = 'sine';
    frequency = new Param();
    start() {
      played.push(this.frequency.value);
    }
    stop() {}
  }
  class Gain extends Node {
    gain = new Param();
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running';
    currentTime = 0;
    destination = new Node();
    createOscillator() {
      return new Oscillator();
    }
    createGain() {
      return new Gain();
    }
    async resume() {}
  };
};

const finished = (startedBy: 'operator' | 'console', status: 'done' | 'failed' = 'done') =>
  JSON.stringify({
    event: 'session.finished',
    at: new Date().toISOString(),
    data: {
      session_id: 's1',
      message_id: 'm1',
      status,
      state: status === 'done' ? 'idle' : 'failed',
      error_code: null,
      started_by: startedBy,
    },
  });

test("a run the operator started chimes when it ends; a job's run and a turned-off sound stay quiet", async ({
  page,
}) => {
  await page.addInitScript(STUB_AUDIO);
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
  });
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  const played = () => page.evaluate(() => (window as unknown as { played: number[] }).played);
  // The page opens its socket after it listens for the first click, so wait for the socket, then click: audio starts
  // only after the operator touched the page.
  await expect.poll(() => socket !== undefined).toBe(true);
  await page.mouse.click(5, 5);

  socket?.send(finished('console'));
  socket?.send(finished('operator'));
  await expect.poll(played).toEqual([784, 1046.5]);
  socket?.send(finished('operator', 'failed'));
  await expect.poll(played).toEqual([784, 1046.5, 659.3, 523.3]);

  await page.getByRole('switch', { name: 'Sound when the agent finishes' }).click();
  socket?.send(finished('operator'));
  await page.getByRole('button', { name: 'Play' }).click();
  // Play still sounds with the chime off; the run did not.
  await expect.poll(played).toEqual([784, 1046.5, 659.3, 523.3, 784, 1046.5]);
});

test('Volume sets how loud the chime is, is kept in the browser, and is off limits while the sound is off', async ({
  page,
}) => {
  await page.addInitScript(STUB_AUDIO);
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  const peaks = () => page.evaluate(() => (window as unknown as { peaks: number[] }).peaks);
  const volume = page.getByRole('slider', { name: 'Volume' });
  await expect(volume).toHaveValue('100');

  await page.getByRole('button', { name: 'Play' }).click();
  await expect.poll(peaks).toEqual([0.5, 0.5]);

  await volume.focus();
  for (let press = 0; press < 10; press++) await volume.press('ArrowLeft');
  await expect(volume).toHaveValue('50');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ops-console:notify.volume'))).toBe('50');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect.poll(async () => (await peaks()).slice(-2)).toEqual([0.25, 0.25]);

  await page.reload();
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('50');
  await page.getByRole('switch', { name: 'Sound when the agent finishes' }).click();
  await expect(page.getByRole('slider', { name: 'Volume' })).toBeDisabled();
});
