import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRANCH_POLL_MS, sameBranch, watchBranch } from "./branchWatch";
import type { GitBranch } from "./terminalApi";

const main: GitBranch = { name: "main", detached: false };
const develop: GitBranch = { name: "develop", detached: false };

describe("sameBranch", () => {
  it("compara por nombre y por HEAD desacoplado", () => {
    expect(sameBranch(main, { ...main })).toBe(true);
    expect(sameBranch(main, develop)).toBe(false);
    expect(sameBranch(main, { name: "main", detached: true })).toBe(false);
    expect(sameBranch(null, null)).toBe(true);
    expect(sameBranch(main, null)).toBe(false);
  });
});

describe("watchBranch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("consulta enseguida y vuelve a consultar en cada intervalo", async () => {
    const query = vi.fn().mockResolvedValue(main);
    const onBranch = vi.fn();
    const stop = watchBranch("C:\repo", query, onBranch);
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BRANCH_POLL_MS * 2);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledWith("C:\repo");
    stop();
  });

  it("ve un cambio de rama sin que cambie la carpeta", async () => {
    const query = vi.fn().mockResolvedValueOnce(main).mockResolvedValue(develop);
    const onBranch = vi.fn();
    const stop = watchBranch("C:\repo", query, onBranch);
    await vi.advanceTimersByTimeAsync(BRANCH_POLL_MS);
    expect(onBranch).toHaveBeenLastCalledWith(develop);
    stop();
  });

  it("al detenerse limpia el intervalo y descarta respuestas en vuelo", async () => {
    let resolve!: (b: GitBranch) => void;
    const query = vi.fn().mockReturnValue(new Promise<GitBranch>((r) => (resolve = r)));
    const onBranch = vi.fn();
    const stop = watchBranch("C:\repo", query, onBranch);
    stop();
    resolve(main);
    await vi.advanceTimersByTimeAsync(BRANCH_POLL_MS * 3);
    expect(query).toHaveBeenCalledTimes(1);
    expect(onBranch).not.toHaveBeenCalled();
  });

  it("un error de la consulta informa null y sigue consultando", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(main);
    const onBranch = vi.fn();
    const stop = watchBranch("C:\repo", query, onBranch);
    await vi.advanceTimersByTimeAsync(0);
    expect(onBranch).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(BRANCH_POLL_MS);
    expect(onBranch).toHaveBeenLastCalledWith(main);
    stop();
  });
});
