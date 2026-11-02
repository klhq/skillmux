import { describe, expect, test } from "bun:test";
import { RwLock } from "../src/vault-lock";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const tick = () => Bun.sleep(5);

describe("RwLock", () => {
  test("readers run together", async () => {
    const lock = new RwLock();
    const g = gate();
    let active = 0;
    let peak = 0;
    const reader = () =>
      lock.read(async () => {
        peak = Math.max(peak, ++active);
        await g.promise;
        active--;
      });
    const all = Promise.all([reader(), reader(), reader()]);
    await tick();
    expect(peak).toBe(3);
    g.open();
    await all;
  });

  test("a writer waits for readers already running and then runs alone", async () => {
    const lock = new RwLock();
    const g = gate();
    const events: string[] = [];
    const reader = lock.read(async () => {
      events.push("read:start");
      await g.promise;
      events.push("read:end");
    });
    await tick();
    const writer = lock.write(async () => {
      events.push("write");
    });
    await tick();
    expect(events).toEqual(["read:start"]);
    g.open();
    await Promise.all([reader, writer]);
    expect(events).toEqual(["read:start", "read:end", "write"]);
  });

  test("readers that arrive while a writer waits or runs queue behind it", async () => {
    const lock = new RwLock();
    const g = gate();
    const w = gate();
    const events: string[] = [];
    const first = lock.read(async () => {
      await g.promise;
    });
    await tick();
    const writer = lock.write(async () => {
      events.push("write:start");
      await w.promise;
      events.push("write:end");
    });
    const late = lock.read(async () => {
      events.push("late-read");
    });
    await tick();
    expect(events).toEqual([]);
    g.open();
    await first;
    await tick();
    expect(events).toEqual(["write:start"]);
    w.open();
    await Promise.all([writer, late]);
    expect(events).toEqual(["write:start", "write:end", "late-read"]);
  });

  test("writers run one at a time in arrival order", async () => {
    const lock = new RwLock();
    const events: string[] = [];
    const run = (name: string) =>
      lock.write(async () => {
        events.push(`${name}:start`);
        await Bun.sleep(10);
        events.push(`${name}:end`);
      });
    await Promise.all([run("a"), run("b"), run("c")]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("a failing reader or writer releases the lock", async () => {
    const lock = new RwLock();
    await expect(lock.read(async () => { throw new Error("r"); })).rejects.toThrow("r");
    await expect(lock.write(async () => { throw new Error("w"); })).rejects.toThrow("w");
    expect(await lock.write(async () => "still works")).toBe("still works");
    expect(await lock.read(async () => "and reads")).toBe("and reads");
  });

  test("returns the callback's value", async () => {
    const lock = new RwLock();
    expect(await lock.read(async () => 1)).toBe(1);
    expect(await lock.write(async () => 2)).toBe(2);
  });
});
