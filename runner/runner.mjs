#!/usr/bin/env node
/**
 * IF ecosystem CI runner.
 *
 *   IFLINK_CI_URL=https://ci.example \
 *   IFLINK_CI_TOKEN=cir_… \
 *   node runner/runner.mjs [--labels linux,x64] [--work /srv/iflink-ci/work]
 *
 * Polls the control plane for a job, clones the pipeline's repo at the run's
 * ref, runs `before` + steps as shell commands, uploads requested artifacts,
 * and reports the outcome. Every step streams its output back as log deltas,
 * and a heartbeat keeps the lease alive; if the lease is revoked (the run was
 * cancelled) the current step is killed and the job ends as cancelled.
 *
 * A pipeline may also ask for a docker image (`image` in the config): after
 * the steps succeed the runner builds it from the workspace, tags and pushes
 * it when asked, and reports it as a `docker-image` artifact.
 *
 * A pipeline with `vm` in its config runs in a throwaway VM (runner/vm.mjs): the
 * runner still clones on the host, then copies the tree into the guest and
 * runs `before`, the steps, artifacts and the image build there.
 *
 * `node runner/runner.mjs --self-check` prints the tools this host offers and
 * exits 0; it needs no token and contacts nothing.
 *
 * Zero dependencies (runner/runner.mjs + runner/vm.mjs), Node ≥ 20. Meant to run
 * under systemd on the build host.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { redactSecrets } from "./redact.mjs";
import { startVm, tartAvailable, vmAvailable, windowsAvailable } from "./vm.mjs";

const BASE = (process.env.IFLINK_CI_URL ?? "http://127.0.0.1:4311").replace(/\/$/, "");
const TOKEN = process.env.IFLINK_CI_TOKEN ?? "";
// Every child (clone, steps, image build) inherits process.env; with the token
// there, repository code could claim, log to or finish other jobs.
delete process.env.IFLINK_CI_TOKEN;
const WORK = process.env.IFLINK_CI_WORK ?? "/tmp/iflink-ci-work";
const GIT_BASE = process.env.IFLINK_CI_GIT_BASE ?? "https://github.com";
const LABELS = process.env.IFLINK_CI_LABELS ?? "";
const POLL_MS = Number(process.env.IFLINK_CI_POLL_MS ?? 3000);
// Steps run in /bin/sh and would otherwise lose an nvm-managed node/npm.
const NODE_DIR = process.env.IFLINK_CI_NODE_DIR ?? dirname(process.execPath);
const BASE_PATH = `${NODE_DIR}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
const HEARTBEAT_MS = 30_000;

let activeJob = null;
let activeVm = null;
let child = null;

function which(bin) {
  try {
    return execFileSync("/usr/bin/env", ["sh", "-c", `command -v ${shellQuote(bin)}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

if (process.argv.includes("--self-check")) {
  console.log(JSON.stringify({ docker: Boolean(which("docker")), git: Boolean(which("git")), node: process.version, vm: vmAvailable(), vm_macos: tartAvailable(), vm_windows: windowsAvailable() }));
  process.exit(0);
}

if (!TOKEN) {
  console.error("IFLINK_CI_TOKEN 未设置");
  process.exit(2);
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

async function api(path, body, method = "POST") {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

// The active job's log writer: holds output until a line is complete, so a
// secret split across two reads is still whole when redacted.
let logBuffer = "";
let masks = [];

function resetLog(secretValues = []) {
  logBuffer = "";
  masks = [...secretValues];
}

/** A step can mask a value of its own, as on GitHub: `echo "::add-mask::$TOKEN"`. */
function redactLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const mask = /^::add-mask::(.*)$/.exec(line.replace(/\r$/, ""));
    if (mask) {
      if (mask[1]) masks.push(mask[1]);
      continue;
    }
    out.push(line);
  }
  return redactSecrets(out.join("\n"), masks);
}

// Chunks go out one after another, in order; flushLog waits for all of them,
// so a fast last step's output cannot arrive after the job is finished (the
// control plane drops log writes to a finished job).
let posting = Promise.resolve();
function post(jobId, text) {
  posting = posting.then(async () => {
    for (let i = 0; i < text.length; i += 64_000) {
      await api("/api/v1/ci/log", { job_id: jobId, chunk: text.slice(i, i + 64_000) }).catch(() => {});
    }
  });
  return posting;
}

async function sendChunk(jobId, chunk) {
  if (!chunk) return;
  logBuffer += chunk;
  const end = logBuffer.lastIndexOf("\n");
  // A very long line without a newline still has to go out eventually.
  if (end < 0 && logBuffer.length < 64_000) return;
  const cut = end < 0 ? logBuffer.length : end + 1;
  const ready = logBuffer.slice(0, cut);
  logBuffer = logBuffer.slice(cut);
  await post(jobId, redactLines(ready));
}

async function flushLog(jobId) {
  const rest = logBuffer;
  logBuffer = "";
  if (rest) post(jobId, redactLines(rest));
  await posting;
}

async function heartbeat() {
  if (!activeJob) return;
  try {
    const res = await api("/api/v1/ci/heartbeat", { job_id: activeJob.id });
    if (res.body?.cancelled) {
      activeJob.cancelled = true;
      child?.kill("SIGTERM");
    }
  } catch {
    // A transient outage is fine; the lease lasts two minutes.
  }
}

function shell(command, cwd, env, kind = "sh") {
  return new Promise((resolve) => {
    // Not `-l`: a login shell sources /etc/profile, which resets PATH and hides
    // an nvm-managed node/npm.
    const [bin, ...flags] = kind === "bash" ? ["bash", "-e", "-c"] : ["/bin/sh", "-c"];
    const proc = spawn(bin, [...flags, command], { cwd, env: { ...env, PATH: BASE_PATH }, detached: true });
    child = proc;
    let output = "";
    const onData = (buf) => {
      output += buf.toString();
      void sendChunk(activeJob.id, buf.toString());
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, (env.STEP_TIMEOUT ?? 600) * 1000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      child = null;
      resolve({ code, output });
    });
  });
}

async function checkout(config, job, workdir) {
  mkdirSync(workdir, { recursive: true });
  const repo = config.repo;
  if (!repo) return { ok: false, error: "流水线没有配置 repo" };
  const branch = config.branch ?? "main";
  // "file:/path/to/bare.git" style origins and full URLs pass through; a bare
  // "owner/name" is resolved against the git host.
  const remote = /^(https?:|file:|\/|git@)/.test(repo) ? repo : `${GIT_BASE}/${repo}.git`;
  // safe.directory: the workspace is created by this process, which may differ
  // from the repo's owner (systemd service user vs the account that pushed).
  const safe = ["-c", `safe.directory=${remote}`];
  const git = `git ${safe.map(shellQuote).join(" ")}`;
  // depth 0 is the full history, as actions/checkout's fetch-depth: 0.
  const depth = config.checkout?.depth ?? 1;
  const depthArg = depth > 0 ? `--depth ${depth} ` : "";
  // The run's ref picks what is built: a branch is cloned directly; any other
  // ref (a PR's refs/pull/N/merge, a tag) is fetched after the default branch.
  const ref = job.ref ?? "";
  const otherRef = ref.startsWith("refs/") && !ref.startsWith("refs/heads/");
  const cloneBranch = !ref || otherRef ? branch : ref.replace(/^refs\/heads\//, "");
  // GitHub drops an SSH connection now and then ("Connection closed by …
  // port 22"); a clone is retried before the job is failed for it.
  let clone;
  for (let attempt = 1; attempt <= 3; attempt++) {
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });
    clone = await shell(`${git} clone ${depthArg}--branch ${shellQuote(cloneBranch)} ${shellQuote(remote)} .`, workdir, process.env);
    if (clone.code === 0 || !/Connection (closed|reset|timed out)|kex_exchange_identification|Could not resolve host|early EOF|RPC failed/i.test(clone.output)) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
  }
  if (clone.code !== 0) return { ok: false, error: `clone 失败：${tail(clone.output, 5)}` };
  if (otherRef) {
    const fetchDepth = depth > 0 ? `--depth ${Math.max(50, depth)} ` : "";
    // What the ref points at is built: for a PR that is GitHub's test merge
    // (refs/pull/N/merge), while the run's commit is the PR head it reports on.
    const fetched = await shell(`${git} fetch ${fetchDepth}origin ${shellQuote(`+${ref}:refs/ci/ref`)} && git checkout --detach refs/ci/ref`, workdir, process.env);
    if (fetched.code !== 0) return { ok: false, error: `checkout ${ref} 失败：${tail(fetched.output, 5)}` };
  } else if (job.commit ?? "") {
    const commit = shellQuote(job.commit);
    // A full clone has the commit unless the branch moved since; a shallow
    // fetch into it would make it shallow again.
    const fetch = depth > 0 ? `${git} fetch --depth ${Math.max(50, depth)} origin ${commit}` : `{ git cat-file -e ${shellQuote(`${job.commit}^{commit}`)} 2>/dev/null || ${git} fetch origin ${commit}; }`;
    const fetched = await shell(`${fetch} && git checkout --detach ${commit}`, workdir, process.env);
    if (fetched.code !== 0) return { ok: false, error: `checkout ${job.commit} 失败：${tail(fetched.output, 5)}` };
  }
  if (config.checkout?.submodules) {
    const modules = await shell(`${git} submodule update --init --recursive ${depth > 0 ? `--depth ${depth}` : ""}`, workdir, process.env);
    if (modules.code !== 0) return { ok: false, error: `子模块 checkout 失败：${tail(modules.output, 5)}` };
  }
  return { ok: true };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function tail(text, lines) {
  return text.trim().split("\n").slice(-lines).join("\n");
}

async function tarArtifacts(workdir, patterns, vm) {
  if (!patterns || patterns.length === 0) return [];
  const out = [];
  for (const pattern of patterns) {
    const target = join(WORK, `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.tgz`);
    const command = `tar -czf ${shellQuote(target)} ${shellQuote(pattern)} 2>/dev/null`;
    const result = vm ? await vm.download(pattern, target) : await shell(command, workdir, process.env);
    if (result.code === 0 && existsSync(target)) {
      out.push({ name: basename(pattern).replace(/[*?[\]{}]/g, "").replace(/\.$/, "") || "artifact", path: target });
    }
  }
  return out;
}

async function uploadArtifact(jobId, item) {
  // Streamed: an image archive is far larger than the runner should buffer.
  const res = await fetch(`${BASE}/api/v1/ci/artifact/upload?job_id=${encodeURIComponent(jobId)}&name=${encodeURIComponent(item.name)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream", "content-length": String(statSync(item.path).size) },
    body: createReadStream(item.path),
    duplex: "half",
  });
  if (!res.ok) throw new Error(`上传制品失败 HTTP ${res.status}${await res.text().then((t) => `：${t.slice(0, 200)}`).catch(() => "")}`);
}

/**
 * Builds the pipeline's docker image, if it asks for one. Returns the artifact
 * to report (`null` when the config has no image) plus the step outcome; any
 * problem is expressed as `{ ok: false, error }` so the caller can fail the job
 * with a readable message instead of an exception.
 */
async function buildImage(job, image, workdir, env, options = {}, vm = null) {
  const docker = options.dockerBin ?? "docker";
  // A job VM always has docker; on the host it has to be there.
  if (!vm && !which(docker)) return { ok: false, error: `找不到 docker（${docker}），无法构建镜像` };
  const send = (text) => sendChunk(job.id, text);
  const run = async (args) => {
    const began = Date.now();
    const command = [docker, ...args.map(shellQuote)].join(" ");
    if (vm) return { ...(await vm.shell(command, env, { timeout: 1800 })), ms: Date.now() - began };
    const result = await shell(command, workdir, { ...env, STEP_TIMEOUT: "1800" });
    await send(result.output);
    return { ...result, ms: Date.now() - began };
  };

  const dockerfile = image.dockerfile;
  const tag = image.tag ?? "if:latest";
  await send(`\n$ docker build -f ${dockerfile} -t ${tag} .\n`);
  const build = await run(["build", "-f", dockerfile, "-t", tag, "."]);
  if (build.code !== 0) return { ok: false, ms: build.ms, error: `docker build 失败（退出码 ${build.code}）` };

  // The image id is the `sha256:…` value the daemon records; it doubles as the
  // artifact digest and as the reference a later `pull` resolves to.
  const inspect = await run(["inspect", "-f", "{{.Id}}", tag]);
  const imageId = inspect.output.trim().split("\n").pop() ?? "";
  if (inspect.code !== 0 || !imageId) return { ok: false, ms: build.ms + inspect.ms, error: `docker inspect ${tag} 失败` };
  const artifacts = [{ kind: "docker-image", name: tag, path: tag, size: 0, digest: `sha256:${imageId}` }];

  let pushed = null;
  if (image.push) {
    await send(`\n$ docker tag ${tag} ${image.push} && docker push ${image.push}\n`);
    const tagResult = await run(["tag", tag, image.push]);
    if (tagResult.code !== 0) return { ok: false, ms: build.ms, artifacts, error: `docker tag ${image.push} 失败` };
    const push = await run(["push", image.push]);
    if (push.code !== 0) return { ok: false, ms: build.ms + tagResult.ms + push.ms, artifacts, error: `docker push ${image.push} 失败（退出码 ${push.code}）` };
    // A pushed image is recorded under its registry ref, same digest.
    artifacts.push({ kind: "docker-image", name: image.push, path: image.push, size: 0, digest: `sha256:${imageId}` });
    pushed = image.push;
  }
  return { ok: true, ms: build.ms + inspect.ms, artifacts, tag, image_id: imageId, push: pushed };
}

async function execute(claim, options = {}) {
  const { job, config } = claim;
  job.commit = job.commit || "";
  activeJob = job;
  const workdir = join(WORK, job.id);
  const started = Date.now();
  const steps = [];
  const secrets = job.secrets ?? {};
  resetLog(Object.values(secrets));
  const fail = async (raw) => {
    const error = redactSecrets(String(raw), masks);
    await sendChunk(job.id, `\n✗ ${error}\n`);
    await flushLog(job.id);
    await api("/api/v1/ci/finish", { job_id: job.id, status: job.cancelled ? "cancelled" : "failed", steps: redactSteps(steps), error }).catch(() => {});
    cleanup();
  };
  const redactSteps = (list) => list.map((s) => (s.error ? { ...s, error: redactSecrets(String(s.error), masks) } : s));

  try {
    // The control plane withholds a pipeline's secrets from PR runs; a trusted
    // run whose vault lacks one would only fail later, less clearly.
    if (job.missing_secrets?.length) return fail(`凭据库里没有这些键：${job.missing_secrets.join(", ")}`);
    if (job.secrets_withheld) await sendChunk(job.id, "这次运行不可信（PR 或非默认分支），不提供流水线的凭据。\n");
    // A requeued job keeps its id: start from an empty directory.
    rmSync(workdir, { recursive: true, force: true });
    // A VM job's tree is cloned beside the VM's own files, then copied in.
    const source = config.vm ? join(workdir, "src") : workdir;
    const stepStart = Date.now();
    const co = await checkout(config, { commit: job.commit ?? "", ref: job.ref ?? "" }, source);
    steps.push({ name: "checkout", status: co.ok ? "done" : "failed", ms: Date.now() - stepStart, error: co.error });
    if (!co.ok) return fail(co.error ?? "checkout 失败");
    if (job.cancelled) return fail("已取消");

    let env;
    let vm = null;
    if (config.vm) {
      const began = Date.now();
      vm = await startVm({
        jobId: job.id,
        workdir,
        spec: config.vm,
        hooks: { track: (proc) => (child = proc), output: (text) => void sendChunk(job.id, text) },
      });
      if (vm.ok) activeVm = vm;
      const copied = vm.ok ? await vm.upload(source) : null;
      const error = !vm.ok ? vm.error : copied.code !== 0 ? `源码复制进 VM 失败：${tail(copied.output, 5)}` : undefined;
      steps.push({ name: "vm", status: error ? "failed" : "done", ms: Date.now() - began, error });
      if (error) return fail(error);
      await sendChunk(job.id, `VM 就绪（${Math.round(vm.bootMs / 100) / 10} 秒，镜像 ${basename(vm.image)}）\n`);
      if (Object.keys(secrets).length) {
        const written = await vm.writeSecrets(secrets);
        if (written.code !== 0) return fail("凭据写入 VM 失败");
      }
      // The guest gets the pipeline's env and these, nothing of the host's;
      // secrets reach it through the file above, never a command line.
      env = { ...(config.env ?? {}), ...(job.inputs ?? {}), CI: "1", CI_JOB_ID: job.id, CI_RUN_ID: job.run_id, CI_COMMIT: job.commit, CI_TMP: vm.tmp };
    } else {
      // A job's own state (sqlite files, uploaded data) must never land in the
      // control plane's database when the repo under test happens to be this
      // very service — every job gets a private data directory.
      const jobData = join(WORK, job.id, ".iflink-data");
      mkdirSync(jobData, { recursive: true });
      env = {
        ...process.env,
        ...(config.env ?? {}),
        ...(job.inputs ?? {}),
        // Passed in the process environment, never on a command line.
        ...secrets,
        CI: "1",
        CI_JOB_ID: job.id,
        CI_RUN_ID: job.run_id,
        IFLINK_DATA_DIR: jobData,
        IFLINK_DB: join(jobData, "iflink.db"),
      };
    }
    const exec = (command, timeout, kind) =>
      vm ? vm.shell(command, env, { timeout, shell: kind }) : shell(command, workdir, { ...env, STEP_TIMEOUT: String(timeout) }, kind);

    for (const command of config.before ?? []) {
      const began = Date.now();
      const result = await exec(command, 600);
      if (result.code !== 0) {
        steps.push({ name: "before", status: "failed", ms: Date.now() - began });
        return fail(`前置命令失败：${command}`);
      }
    }
    for (const step of config.steps ?? []) {
      if (job.cancelled) return fail("已取消");
      await sendChunk(job.id, `\n$ ${step.name}\n`);
      const began = Date.now();
      const result = await exec(step.run, step.timeout ?? 600, step.shell);
      await flushLog(job.id);
      const status = result.code === 0 ? "done" : step.allow_failure ? "allowed_failure" : "failed";
      steps.push({ name: step.name, status, ms: Date.now() - began, code: result.code });
      if (status === "failed") return fail(`步骤 ${step.name} 失败（退出码 ${result.code}）`);
    }
    for (const item of await tarArtifacts(workdir, config.artifacts, vm)) {
      await uploadArtifact(job.id, item);
      rmSync(item.path, { force: true });
    }
    // The image build is the last step: everything the pipeline wanted on disk
    // is already stored, and a failed build fails the job like any other step.
    if (config.image) {
      if (job.cancelled) return fail("已取消");
      const began = Date.now();
      const image = await buildImage(job, config.image, workdir, env, options, vm);
      steps.push({ name: "docker-build", status: image.ok ? "done" : "failed", ms: image.ms ?? Date.now() - began, error: image.error });
      for (const artifact of image.artifacts ?? []) {
        // Docker images live in the daemon, not on disk: only the reference,
        // its id and the digest travel back to the control plane.
        await api("/api/v1/ci/artifact", {
          job_id: job.id, kind: artifact.kind, name: artifact.name, path: artifact.path, size: artifact.size, digest: artifact.digest,
        }).catch(() => {});
      }
      if (!image.ok) return fail(image.error ?? "镜像构建失败");
      await sendChunk(job.id, `\n✓ 镜像 ${image.tag} (${image.image_id})${image.push ? ` → ${image.push}` : ""}\n`);
    }
    await flushLog(job.id);
    await api("/api/v1/ci/finish", { job_id: job.id, status: "succeeded", steps: redactSteps(steps), error: "" });
    log(`job ${job.id} succeeded in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    await fail(err && err.message ? err.message : String(err));
  } finally {
    cleanup();
  }
}

function cleanup() {
  activeVm?.stop();
  activeVm = null;
  if (activeJob) rmSync(join(WORK, activeJob.id), { recursive: true, force: true });
  activeJob = null;
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  // Nothing runs yet: whatever is here was left by a runner that stopped
  // mid-job (its job is requeued or failed by its lease).
  for (const entry of readdirSync(WORK)) rmSync(join(WORK, entry), { recursive: true, force: true });
  log(`runner up: ${BASE} labels=${LABELS || "-"} work=${WORK} path=${BASE_PATH}`);
  const beat = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  try {
    for (;;) {
      const res = await api("/api/v1/ci/claim", { labels: LABELS }).catch(() => null);
      if (!res || res.status !== 200) {
        log(`claim failed (${res?.status ?? "network"})：${res?.body?.message ?? ""}`);
        await sleep(POLL_MS * 2);
        continue;
      }
      if (!res.body.job) {
        await sleep(POLL_MS);
        continue;
      }
      log(`claimed job ${res.body.job.id} (run ${res.body.job.run_id})`);
      await execute(res.body);
    }
  } finally {
    clearInterval(beat);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGTERM", () => {
  activeJob && (activeJob.cancelled = true);
  child?.kill("SIGTERM");
  activeVm?.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
