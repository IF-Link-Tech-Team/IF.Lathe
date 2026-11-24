#!/usr/bin/env node
/**
 * Maven Central cache for the CI job VMs.
 *
 * Every job VM starts empty, so each Android build downloaded its whole
 * dependency tree from Maven Central again, and Maven Central answers an IP
 * that keeps fetching the same large artifact with 429 for a day. This
 * service keeps one copy of each artifact on the build host and fetches what
 * it lacks from Google's Maven Central mirror, then Maven Central itself. A
 * job VM reaches it at QEMU's host address (10.0.2.2); the Gradle init script
 * in the VM image (images/linux/guest/iflink-maven.gradle) points Maven Central
 * repositories here.
 *
 * Content only ever comes from the upstreams over HTTPS: a job chooses which
 * path to fetch, never what is stored under it. maven-metadata.xml (version
 * listings that change) is passed through and not kept.
 *
 *   IFLINK_CI_MAVEN_CACHE_DIR=/var/cache/iflink-ci-maven \
 *   IFLINK_CI_MAVEN_CACHE_LISTEN=127.0.0.1:4380 node caches/maven-cache.mjs
 */
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export const UPSTREAMS = ["https://maven-central.storage-download.googleapis.com/maven2", "https://repo.maven.apache.org/maven2"];

// Group/artifact/version segments and file names; no dot-only segments.
const PATH = /^\/maven2\/((?:[A-Za-z0-9_][A-Za-z0-9._+-]*\/)*[A-Za-z0-9_][A-Za-z0-9._+-]*)$/;
const VOLATILE = /(^|\/)maven-metadata\.xml(\.(md5|sha1|sha256|sha512))?$/;

function write(stream, chunk) {
  return stream.write(chunk) ? Promise.resolve() : new Promise((resolve) => stream.once("drain", resolve));
}

export function createMavenCache({ dir, upstreams = UPSTREAMS, fetchImpl = fetch, log = () => {} }) {
  mkdirSync(dir, { recursive: true });
  return createServer(async (req, res) => {
    const match = PATH.exec(new URL(req.url ?? "/", "http://cache").pathname);
    if (!match) return res.writeHead(404).end();
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    const rel = match[1];
    const file = join(dir, rel);
    const volatile = VOLATILE.test(rel);

    if (!volatile && existsSync(file)) {
      const { size } = statSync(file);
      const now = new Date();
      utimesSync(file, now, now);
      res.writeHead(200, { "content-length": String(size), "content-type": "application/octet-stream", "x-cache": "hit" });
      if (req.method === "HEAD") return res.end();
      return createReadStream(file).pipe(res);
    }

    let status = 404;
    for (const base of upstreams) {
      let upstream;
      try {
        upstream = await fetchImpl(`${base}/${rel}`, { method: req.method, redirect: "follow" });
      } catch (err) {
        log(`${base}/${rel}: ${err instanceof Error ? err.message : err}`);
        status = 502;
        continue;
      }
      if (!upstream.ok) {
        // A 404 at the mirror may only be lag behind Maven Central.
        status = status === 404 ? upstream.status : status;
        await upstream.body?.cancel().catch(() => {});
        continue;
      }
      const length = upstream.headers.get("content-length");
      res.writeHead(200, { ...(length ? { "content-length": length } : {}), "content-type": "application/octet-stream", "x-cache": "miss" });
      if (req.method === "HEAD" || !upstream.body) return res.end();
      if (volatile) return Readable.fromWeb(upstream.body).pipe(res);

      // To the client and into the cache at once; the file is kept only when
      // the whole body arrived, and stays complete if the client goes away.
      mkdirSync(dirname(file), { recursive: true });
      const partial = `${file}.part-${randomBytes(4).toString("hex")}`;
      const out = createWriteStream(partial);
      let size = 0;
      let clientGone = false;
      res.on("close", () => (clientGone = !res.writableFinished));
      try {
        for await (const chunk of Readable.fromWeb(upstream.body)) {
          size += chunk.length;
          if (!clientGone) await write(res, chunk);
          await write(out, chunk);
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
        if (length && Number(length) !== size) throw new Error(`short body: ${size} of ${length} bytes`);
        renameSync(partial, file);
      } catch (err) {
        out.destroy();
        rmSync(partial, { force: true });
        log(`${rel}: ${err instanceof Error ? err.message : err}`);
        if (!clientGone) res.destroy();
        return;
      }
      return res.end();
    }
    res.writeHead(status).end();
  });
}

/** Removes cached files nobody has asked for in `days` days, and stale partials. */
export function pruneCache(dir, days, now = Date.now()) {
  let removed = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (now - statSync(full).mtimeMs > (entry.name.includes(".part-") ? 1 : days) * 86_400_000) {
        rmSync(full, { force: true });
        removed += 1;
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return removed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.env.IFLINK_CI_MAVEN_CACHE_DIR ?? "/var/cache/iflink-ci-maven";
  const [host, port] = (process.env.IFLINK_CI_MAVEN_CACHE_LISTEN ?? "127.0.0.1:4380").split(":");
  const keepDays = Number(process.env.IFLINK_CI_MAVEN_CACHE_DAYS ?? 60);
  const log = (text) => console.error(`${new Date().toISOString()} ${text}`);
  const prune = () => log(`pruned ${pruneCache(dir, keepDays)} file(s) unused for ${keepDays} days`);
  prune();
  setInterval(prune, 86_400_000).unref();
  createMavenCache({ dir, log }).listen(Number(port), host, () => log(`maven cache on ${host}:${port}, ${dir}`));
}
