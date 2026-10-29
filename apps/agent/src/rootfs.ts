import { chmod, lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Preconditions for a shared root-owned `--rootfs` driven by a rootless tenant (host-validation.md B):
 * podman cannot create anything in the tree, so everything it would create must already exist.
 * Runs as root on the extracted tree (never on tenant data).
 */
export async function ensureRootfs(dir: string): Promise<void> {
  for (const d of ["proc", "sys", "dev", "etc", "tmp", "var/tmp", "run", "workspace"]) {
    const p = join(dir, d);
    const st = await lstat(p).catch(() => null);
    if (st && !st.isDirectory()) await rm(p, { force: true });
    await mkdir(p, { recursive: true, mode: 0o755 });
  }
  // tmpfs is mounted over these at run time; build residue (e.g. a 0700 root dir in /tmp) makes crun
  // fail with "open directory: Permission denied", so ship them empty.
  for (const d of ["tmp", "var/tmp", "run"]) {
    for (const name of await readdir(join(dir, d))) {
      await rm(join(dir, d, name), { recursive: true, force: true });
    }
  }
  await chmod(join(dir, "tmp"), 0o1777);
  await chmod(join(dir, "var/tmp"), 0o1777);
  for (const f of ["etc/hosts", "etc/hostname", "etc/resolv.conf"]) {
    const p = join(dir, f);
    const st = await lstat(p).catch(() => null);
    if (st && st.isDirectory()) await rm(p, { recursive: true, force: true });
    if (!st || st.isDirectory()) await writeFile(p, "", { mode: 0o644 });
  }
  const mtab = join(dir, "etc/mtab");
  const target = "../proc/self/mounts";
  const cur = await lstat(mtab).catch(() => null);
  if (!cur || !cur.isSymbolicLink() || (await readlink(mtab)) !== target) {
    if (cur) await rm(mtab, { recursive: true, force: true });
    await symlink(target, mtab);
  }
  await rm(join(dir, "run/.containerenv"), { force: true });
  await chmod(dir, 0o755);
}
