import { describe, it, expect } from 'vitest';
import { TaskQueue, TaskCancelled } from '@/lib/agent/taskQueue';

/** A job that ends when told to. */
function job(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const run = async () => {
    log.push(`start ${name}`);
    await done;
    log.push(`end ${name}`);
    return name;
  };
  return { run, finish };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the task queue', () => {
  it('runs up to the limit at once, then the others in order as slots free up', async () => {
    const log: string[] = [];
    const positions: string[] = [];
    const queue = new TaskQueue(() => 2, (tab, pos) => positions.push(`${tab}:${pos}`));
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => job(log, n));
    const results = [queue.run(1, a.run), queue.run(2, b.run), queue.run(3, c.run), queue.run(4, d.run)];
    await tick();
    expect(log).toEqual(['start a', 'start b']);
    expect(queue.queued).toEqual([3, 4]);
    expect(positions).toContain('3:1');
    expect(positions).toContain('4:2');

    a.finish();
    await tick(); await tick();
    expect(log).toEqual(['start a', 'start b', 'end a', 'start c']);
    expect(queue.queued).toEqual([4]);
    expect(positions.filter((p) => p.startsWith('4:')).at(-1)).toBe('4:1'); // moved up

    b.finish(); c.finish(); await tick(); await tick(); d.finish();
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd']);
    expect(queue.active).toBe(0);
  });

  it('stops a waiting task without running it', async () => {
    const log: string[] = [];
    const queue = new TaskQueue(() => 1);
    const a = job(log, 'a');
    const first = queue.run(1, a.run);
    const second = queue.run(2, job(log, 'b').run);
    await tick();
    expect(queue.cancel(2)).toBe(true);
    await expect(second).rejects.toBeInstanceOf(TaskCancelled);
    a.finish();
    await first;
    expect(log).toEqual(['start a', 'end a']);
    expect(queue.cancel(2)).toBe(false);
  });

  it('lets a new task in a tab replace that tab\'s waiting one', async () => {
    const log: string[] = [];
    const queue = new TaskQueue(() => 1);
    const a = job(log, 'a');
    const first = queue.run(1, a.run);
    const old = queue.run(2, job(log, 'old').run);
    const replacement = job(log, 'new');
    const fresh = queue.run(2, replacement.run);
    await expect(old).rejects.toBeInstanceOf(TaskCancelled);
    a.finish(); await first; await tick(); await tick();
    replacement.finish();
    expect(await fresh).toBe('new');
    expect(log).not.toContain('start old');
  });

  it('frees the slot when a job fails', async () => {
    const queue = new TaskQueue(() => 1);
    await expect(queue.run(1, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(queue.run(2, async () => 'ok')).resolves.toBe('ok');
  });

  it('reads the limit each time, so raising it lets more start', async () => {
    let limit = 1;
    const log: string[] = [];
    const queue = new TaskQueue(() => limit);
    const a = job(log, 'a');
    const b = job(log, 'b');
    const first = queue.run(1, a.run);
    const second = queue.run(2, b.run);
    await tick();
    expect(log).toEqual(['start a']);
    limit = 3;
    a.finish(); await first; await tick(); await tick();
    expect(log).toContain('start b');
    b.finish(); await second;
  });
});
