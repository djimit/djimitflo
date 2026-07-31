import { describe, it, expect } from "vitest";
import { RemoteGitService } from "../services/remote-git-service";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("RemoteGitService", () => {
  let cacheRoot: string;
  let service: RemoteGitService;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "remote-git-"));
    service = new RemoteGitService(cacheRoot, 30_000);
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("resolves remote HEAD for a known public repo", () => {
    const head = service.resolveRemoteHead("octocat/Hello-World");
    expect(head.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(head.ref).toContain("HEAD");
  });

  it("clones a public repo to the deterministic cache path", async () => {
    const result = await service.cloneRepository("octocat/Hello-World");
    expect(result.path).toContain("repos/octocat/Hello-World");
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.branch).toBeTruthy();
    expect(result.fromCache).toBe(false);
  });

  it("returns cached result on second clone of same commit", async () => {
    await service.cloneRepository("octocat/Hello-World");
    const second = await service.cloneRepository("octocat/Hello-World");
    expect(second.fromCache).toBe(true);
  });

  it("throws on invalid ownerRepo format", async () => {
    await expect(service.cloneRepository("invalid")).rejects.toThrow("Invalid ownerRepo format");
  });

  it("throws when repo does not exist", async () => {
    await expect(
      service.cloneRepository("djimit/nonexistent-repo-999999"),
    ).rejects.toThrow();
  });
});
