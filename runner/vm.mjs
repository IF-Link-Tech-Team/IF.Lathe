/**
 * Throwaway job VMs for runner/runner.mjs.
 *
 * A pipeline with `vm` in its config runs in its own KVM guest: a fresh
 * copy-on-write overlay of the CI image (images/linux, built by
 * deploy/build-vm-image.sh), booted straight from its kernel, with Docker
 * and the IF toolchains inside and root for the job's own user. Nothing is
 * shared with the host except what the runner copies in (the checked-out
 * source) and what it copies out (artifacts); the deploy keys that cloned the
 * source never enter the guest. The overlay is deleted with the job.
 *
 * The runner reaches the guest over SSH on a loopback port QEMU forwards. The
 * login key and the guest's host key are made per job and handed over through
 * QEMU's firmware config, so a guest only ever trusts this job's runner and
 * the runner only this job's guest. QEMU's user network makes the guest's
 * outbound connections from the QEMU process, so they leave under the
 * runner's own sandbox and firewall rules.
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

const QEMU = process.env.IFLINK_CI_QEMU ?? "qemu-system-x86_64";
const QEMU_IMG = process.env.IFLINK_CI_QEMU_IMG ?? "qemu-img";
const BOOT_SECONDS = Number(process.env.IFLINK_CI_VM_BOOT_SECONDS ?? 120);

/**
 * What a step's command line needs to know about the guest it runs in. The
 * Linux image is ours (images/linux); the macOS one is a Cirrus Labs tart
 * image, whose login is `admin` and which has no GNU `timeout`.
 */
export const LINUX_GUEST = {
  kind: "posix",
  user: "ci",
  home: "/home/ci",
  work: "/home/ci/work",
  tmp: "/home/ci/tmp",
  // The guest's own toolchains; a step may prepend another (e.g. /opt/node22/bin).
  path: "/usr/local/go/bin:/home/ci/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
  lang: "C.UTF-8",
  limit: (seconds) => `timeout -k 10 ${seconds}`,
};
export const MACOS_GUEST = {
  kind: "posix",
  user: "admin",
  home: "/Users/admin",
  work: "/Users/admin/work",
  tmp: "/Users/admin/tmp",
  path: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  lang: "en_US.UTF-8",
  // Like GNU timeout: the step runs in its own process group, which is
  // killed when the time is up (exit 124).
  limit: (seconds) =>
    `perl -e 'my $t = shift; my $pid = fork(); die "fork: $!" unless defined $pid; if ($pid == 0) { setpgrp(0, 0); exec @ARGV or die "exec: $!" } $SIG{ALRM} = sub { kill "KILL", -$pid; exit 124 }; alarm $t; waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' ${seconds}`,
};

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The runner's VM defaults, from its environment. */
export function vmDefaults(env = process.env) {
  return {
    image: env.IFLINK_CI_VM_IMAGE ?? "",
    cpus: Number(env.IFLINK_CI_VM_CPUS ?? 4),
    memoryMb: Number(env.IFLINK_CI_VM_MEMORY_MB ?? 8192),
  };
}

/** True when this host can boot job VMs: KVM, QEMU and an installed image. */
export function vmAvailable(env = process.env) {
  const { image } = vmDefaults(env);
  return Boolean(image) && existsSync(join(image, "root.img")) && existsSync("/dev/kvm");
}

/**
 * The command line sshd runs for one step: into the work tree, with exactly
 * this environment (nothing of the host's), under a guest-side time limit so
 * a step that outlives its timeout is killed inside the VM as well.
 */
export function guestCommand(command, env, { timeout = 600, shell = "sh", guest = LINUX_GUEST, workdir = guest.work } = {}) {
  const vars = Object.entries({ HOME: guest.home, USER: guest.user, LOGNAME: guest.user, PATH: guest.path, LANG: guest.lang, ...env })
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const interpreter = shell === "bash" ? "bash -e -c" : "sh -c";
  // Secrets written by writeSecrets are read from their file, so their values
  // never appear in this command line (ssh's argv, the guest's process list).
  const secrets = secretsPath(guest);
  const script = `[ ! -f ${secrets} ] || . ${secrets}\n${command}`;
  return `cd ${shellQuote(workdir)} && exec env -i ${vars.join(" ")} ${guest.limit(Math.max(1, Math.round(timeout)))} ${interpreter} ${shellQuote(script)}`;
}

const secretsPath = (guest) => guest.secrets ?? `${guest.home}/.ci/secrets.env`;

/**
 * Git settings (as GIT_CONFIG_* variables) that send a job's clones of its
 * `checkout.repos` through a read-only token: their https, ssh and
 * `gh-<name>` alias URLs all become token URLs. Nothing else is rewritten.
 */
export function gitCredentialEnv(token, repos) {
  const rules = [];
  for (const full of repos ?? []) {
    const [owner, name] = String(full).split("/");
    if (!owner || !name) continue;
    const base = `https://x-access-token:${token}@github.com/${owner}/${name}`;
    for (const prefix of [`https://github.com/${owner}/${name}`, `git@github.com:${owner}/${name}`, `ssh://git@github.com/${owner}/${name}`, `git@gh-${name}:${owner}/${name}`]) {
      rules.push([`url.${base}.insteadOf`, prefix]);
    }
  }
  if (!token || rules.length === 0) return {};
  const env = { GIT_CONFIG_COUNT: String(rules.length), GIT_TERMINAL_PROMPT: "0" };
  rules.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The secrets file: one `export NAME='value'` per secret, multi-line values intact. */
export function secretsFile(secrets) {
  return Object.entries(secrets)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join("");
}

/**
 * A Windows guest (images/windows): sshd runs commands with cmd.exe, steps
 * are PowerShell 7 like a GitHub Windows job's default shell, and the step
 * script travels base64-encoded so no quoting survives cmd.exe by accident.
 * There is no guest-side time limit; the host ends the session at the
 * step's timeout and the VM is discarded with the job.
 */
export const WINDOWS_GUEST = {
  kind: "windows",
  user: "Administrator",
  home: "C:\\Users\\Administrator",
  work: "C:\\ci\\work",
  tmp: "C:\\ci\\tmp",
  secrets: "C:\\ci\\.ci\\secrets.ps1",
};

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The command line for one step in a Windows guest. */
export function windowsCommand(command, env, { guest = WINDOWS_GUEST, workdir = guest.work } = {}) {
  const vars = Object.entries({ CI_TMP: guest.tmp, ...env })
    .filter(([key]) => ENV_NAME.test(key))
    .map(([key, value]) => `$env:${key} = ${psQuote(value)}`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // Logs are text: no ANSI colour in formatted output.
    "$PSStyle.OutputRendering = 'PlainText'",
    ...vars,
    `if (Test-Path -LiteralPath ${psQuote(guest.secrets)}) { . ${psQuote(guest.secrets)} }`,
    `Set-Location -LiteralPath ${psQuote(workdir)}`,
    command,
    "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }",
  ].join("\n");
  // -OutputFormat Text: errors as plain lines, not CLIXML on stderr.
  return `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/** What each kind of guest runs for a step, the secrets file and file copies. */
function guestOps(guest) {
  if (guest.kind === "windows") {
    return {
      step: (command, env, options) => windowsCommand(command, env, { ...options, guest }),
      secretsFile: (values) => Object.entries(values).filter(([name]) => ENV_NAME.test(name)).map(([name, value]) => `$env:${name} = ${psQuote(value)}\n`).join(""),
      secretsCommand: `mkdir C:\\ci\\.ci 2>nul & pwsh -NoProfile -NonInteractive -Command "[IO.File]::WriteAllText('${guest.secrets}', [Console]::In.ReadToEnd())"`,
      uploadCommand: `mkdir ${guest.work} 2>nul & mkdir ${guest.tmp} 2>nul & tar -xf - -C ${guest.work.replace(/\\/g, "/")}`,
      downloadCommand: (pattern) => `cd /d ${guest.work} && tar -czf - "${String(pattern).replace(/"/g, "")}" 2>nul`,
    };
  }
  return {
    step: (command, env, options) => guestCommand(command, env, { ...options, guest }),
    secretsFile,
    secretsCommand: `mkdir -p ${dirname(secretsPath(guest))} && chmod 0700 ${dirname(secretsPath(guest))} && umask 077 && cat > ${secretsPath(guest)}`,
    uploadCommand: `mkdir -p ${guest.work} ${guest.tmp} && tar -xf - -C ${guest.work}`,
    downloadCommand: (pattern) => `cd ${guest.work} && tar -czf - ${shellQuote(pattern)} 2>/dev/null`,
  };
}

/** The QEMU command line for one job VM. */
export function qemuArgs({ name, image, dir, port, cpus, memoryMb }) {
  return [
    "-name", name,
    "-machine", "q35,accel=kvm", "-cpu", "host", "-smp", String(cpus), "-m", String(memoryMb),
    "-nodefaults", "-no-user-config", "-display", "none", "-monitor", "none", "-no-reboot",
    "-serial", `file:${join(dir, "console.log")}`,
    "-kernel", join(image, "vmlinuz"), "-initrd", join(image, "initrd.img"),
    "-append", "root=/dev/vda rw console=ttyS0 net.ifnames=0 fsck.mode=skip panic=-1 quiet",
    "-drive", `file=${join(dir, "root.qcow2")},if=none,id=root,format=qcow2,cache=unsafe,discard=unmap`,
    "-device", "virtio-blk-pci,drive=root",
    "-fw_cfg", `name=opt/iflink/authorized_key,file=${join(dir, "login.pub")}`,
    "-fw_cfg", `name=opt/iflink/host_key,file=${join(dir, "host")}`,
    "-netdev", `user,id=net0,ipv4=on,ipv6=off,net=10.0.2.0/24,hostname=ci,hostfwd=tcp:127.0.0.1:${port}-10.0.2.15:22`,
    "-device", "virtio-net-pci,netdev=net0",
    "-device", "virtio-rng-pci",
    "-sandbox", "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
  ];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailOf(file, lines) {
  try {
    return readFileSync(file, "utf8").replace(/\r/g, "").trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Boots a job VM in `workdir/vm` and waits until it accepts SSH. `hooks.track`
 * receives every child process so the runner can kill it on cancel or
 * timeout; `hooks.output` receives step output as it arrives.
 */
export async function startVm({ jobId, workdir, spec = {}, hooks }) {
  if (spec.os === "macos") return startTartVm({ jobId, workdir, spec, hooks });
  if (spec.os === "windows") return startWindowsVm({ jobId, workdir, spec, hooks });
  const defaults = vmDefaults();
  if (!vmAvailable()) return { ok: false, error: "这台 runner 不能启动 VM（缺少 /dev/kvm 或 IFLINK_CI_VM_IMAGE 镜像）" };
  // The image `current` points at now: a newer one installed mid-job must not
  // change the disk under a running guest.
  const image = realpathSync(defaults.image);
  const dir = join(workdir, "vm");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "iflink-ci-runner", "-f", join(dir, "login")]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "iflink-ci-vm", "-f", join(dir, "host")]);
  execFileSync(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-b", join(image, "root.img"), "-F", "raw", join(dir, "root.qcow2")]);
  const port = await freePort();
  const hostKey = readFileSync(join(dir, "host.pub"), "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  writeFileSync(join(dir, "known_hosts"), `[127.0.0.1]:${port} ${hostKey}\n`, { mode: 0o600 });

  const cpus = spec.cpus ?? defaults.cpus;
  const memoryMb = spec.memory_mb ?? defaults.memoryMb;
  const qemu = spawn(QEMU, qemuArgs({ name: `iflink-ci-${jobId}`, image, dir, port, cpus, memoryMb }), { stdio: ["ignore", "ignore", "pipe"] });
  let qemuError = "";
  let exited = null;
  qemu.stderr.on("data", (buf) => (qemuError = (qemuError + buf.toString()).slice(-4000)));
  qemu.on("exit", (code, signal) => (exited = { code, signal }));
  qemu.on("error", (err) => (exited = { code: -1, signal: null, error: err.message }));

  const sshBase = [
    "-F", "/dev/null", "-p", String(port), "-i", join(dir, "login"),
    "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`, "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8", "-o", "LogLevel=ERROR",
    "ci@127.0.0.1",
  ];

  const stop = () => {
    if (exited) return;
    try {
      qemu.kill("SIGKILL");
    } catch {
      // already gone
    }
  };

  const fail = (why) => {
    stop();
    const console = tailOf(join(dir, "console.log"), 15);
    return { ok: false, error: `${why}${qemuError ? `\nqemu: ${qemuError.trim()}` : ""}${console ? `\n控制台末尾：\n${console}` : ""}` };
  };

  const session = sshSession({ sshBase, hooks, guest: LINUX_GUEST });
  const deadline = Date.now() + BOOT_SECONDS * 1000;
  const bootStarted = Date.now();
  for (;;) {
    if (exited) return fail(`VM 启动失败（qemu 退出 ${exited.code ?? exited.signal}${exited.error ? `：${exited.error}` : ""}）`);
    if (Date.now() > deadline) return fail(`VM 在 ${BOOT_SECONDS} 秒内没有接受 SSH`);
    const probe = await session.run("ssh", [...sshBase, "true"], { timeoutMs: 10_000 });
    if (probe.code === 0) break;
    await sleep(500);
  }
  return { ok: true, bootMs: Date.now() - bootStarted, image, ...session, stop };
}

/** Spawns a host process, collecting (or piping) its output. */
function runProcess(hooks, bin, args, { input, stdout, timeoutMs, onData } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: [input ? "pipe" : "ignore", stdout ? "pipe" : "pipe", "pipe"], detached: true });
    hooks?.track?.(proc);
    let output = "";
    const collect = (buf) => {
      const text = buf.toString();
      output += text;
      onData?.(text);
    };
    if (stdout) proc.stdout.pipe(stdout);
    else proc.stdout.on("data", collect);
    proc.stderr.on("data", collect);
    if (input) input.pipe(proc.stdin);
    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }, timeoutMs)
      : null;
    proc.on("error", (err) => collect(`${err.message}\n`));
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      hooks?.track?.(null);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** The steps, secrets and file copies of a job, over SSH into a booted guest. */
function sshSession({ sshBase, hooks, guest }) {
  const run = (bin, args, options) => runProcess(hooks, bin, args, options);
  const ops = guestOps(guest);
  return {
    run,
    tmp: guest.tmp,
    /** Runs one step in the guest; output streams to `hooks.output`. */
    shell(command, env, options = {}) {
      const timeout = options.timeout ?? 600;
      return run("ssh", [...sshBase, ops.step(command, env, { timeout, shell: options.shell })], {
        // The guest kills the step at `timeout`; this is the backstop for a
        // guest that stops answering.
        timeoutMs: (timeout + 60) * 1000,
        onData: hooks?.output,
      });
    },
    /** Writes the job's secrets to the guest's secrets file, over SSH stdin. */
    writeSecrets(values) {
      return run("ssh", [...sshBase, ops.secretsCommand], {
        input: Readable.from([ops.secretsFile(values)]),
        timeoutMs: 60_000,
      });
    },
    /** Copies a host directory's contents into the guest's work tree. */
    async upload(source) {
      const tar = spawn("tar", ["-C", source, "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] });
      let tarError = "";
      tar.stderr.on("data", (buf) => (tarError += buf.toString()));
      const tarDone = new Promise((resolve) => tar.on("close", (code) => resolve(code ?? 1)));
      const result = await run("ssh", [...sshBase, ops.uploadCommand], { input: tar.stdout, timeoutMs: 900_000 });
      const tarCode = await tarDone;
      if (tarCode !== 0) return { code: tarCode, output: tarError };
      return result;
    },
    /** Packs `pattern` (relative to the work tree) in the guest into a host .tgz. */
    async download(pattern, target) {
      const file = createWriteStream(target);
      const done = new Promise((resolve) => file.on("close", resolve));
      const result = await run("ssh", [...sshBase, ops.downloadCommand(pattern)], { stdout: file, timeoutMs: 900_000 });
      await done;
      const size = existsSync(target) ? statSync(target).size : 0;
      return { code: result.code === 0 && size > 0 ? 0 : 1, output: result.output };
    },
  };
}

/* macOS guests (tart) ------------------------------------------------------ */

const TART = process.env.IFLINK_CI_TART ?? "tart";
const TART_BOOT_SECONDS = Number(process.env.IFLINK_CI_TART_BOOT_SECONDS ?? 300);

/** True when this host can clone and boot macOS job VMs. */
export function tartAvailable(env = process.env) {
  if (process.platform !== "darwin" || !env.IFLINK_CI_TART_IMAGE) return false;
  try {
    return tartList().some((vm) => vm.Name === env.IFLINK_CI_TART_IMAGE);
  } catch {
    return false;
  }
}

function tartList() {
  return JSON.parse(execFileSync(TART, ["list", "--format", "json"], { encoding: "utf8", timeout: 30_000 }));
}

/**
 * Boots a macOS job VM: an APFS copy-on-write clone of the installed image
 * (IFLINK_CI_TART_IMAGE, a local tart VM with Xcode), deleted with the job.
 * The guest agent installs this job's login key and reports the guest's SSH
 * host key, so the session that follows trusts exactly this guest. Apple's
 * licence allows two macOS guests per Mac at a time: run one or two runners.
 */
async function startTartVm({ jobId, workdir, spec, hooks }) {
  if (!tartAvailable()) return { ok: false, error: "这台 runner 不能启动 macOS VM（需要 macOS、tart 和 IFLINK_CI_TART_IMAGE 镜像）" };
  const image = process.env.IFLINK_CI_TART_IMAGE;
  const name = `iflink-ci-${jobId}`;
  // A runner killed mid-job leaves its clone behind; nothing else is named so.
  for (const vm of tartList()) {
    if (vm.Name.startsWith("iflink-ci-") && vm.State !== "running") execFileSync(TART, ["delete", vm.Name], { timeout: 120_000 });
  }
  const dir = join(workdir, "vm");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "iflink-ci-runner", "-f", join(dir, "login")]);
  const tart = (args, options = {}) => runProcess(null, TART, args, { timeoutMs: 120_000, ...options });
  const cloned = await tart(["clone", image, name], { timeoutMs: 600_000 });
  if (cloned.code !== 0) return { ok: false, error: `tart clone 失败：${cloned.output.trim().slice(-500)}` };
  const deleteVm = () => {
    try {
      execFileSync(TART, ["stop", name, "--timeout", "5"], { stdio: "ignore", timeout: 60_000 });
    } catch {
      // not running
    }
    try {
      execFileSync(TART, ["delete", name], { stdio: "ignore", timeout: 120_000 });
    } catch {
      // already gone
    }
  };
  const sized = await tart(["set", name, "--cpu", String(spec.cpus ?? 8), "--memory", String(spec.memory_mb ?? 16384), "--random-mac", "--random-serial"]);
  if (sized.code !== 0) {
    deleteVm();
    return { ok: false, error: `tart set 失败：${sized.output.trim().slice(-500)}` };
  }
  // Softnet keeps the guest off the host's LAN; it needs a root-owned softnet
  // binary, so it is opt-in.
  const net = process.env.IFLINK_CI_TART_SOFTNET === "1" ? ["--net-softnet"] : [];
  const vmProc = spawn(TART, ["run", name, "--no-graphics", "--no-audio", "--no-clipboard", ...net], { stdio: ["ignore", "ignore", "pipe"] });
  let vmError = "";
  let exited = null;
  vmProc.stderr.on("data", (buf) => (vmError = (vmError + buf.toString()).slice(-4000)));
  vmProc.on("exit", (code, signal) => (exited = { code, signal }));
  vmProc.on("error", (err) => (exited = { code: -1, signal: null, error: err.message }));
  const stop = () => {
    if (!exited) {
      try {
        vmProc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    deleteVm();
  };
  const fail = (why) => {
    stop();
    return { ok: false, error: `${why}${vmError ? `\ntart: ${vmError.trim()}` : ""}` };
  };

  const bootStarted = Date.now();
  const deadline = bootStarted + TART_BOOT_SECONDS * 1000;
  for (;;) {
    if (exited) return fail(`macOS VM 启动失败（tart 退出 ${exited.code ?? exited.signal}${exited.error ? `：${exited.error}` : ""}）`);
    if (Date.now() > deadline) return fail(`macOS VM 在 ${TART_BOOT_SECONDS} 秒内没有就绪`);
    const probe = await tart(["exec", name, "true"], { timeoutMs: 15_000 });
    if (probe.code === 0) break;
    await sleep(2000);
  }
  const guest = MACOS_GUEST;
  const keyed = await tart(["exec", "-i", name, "sh", "-c", "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"], {
    input: Readable.from([readFileSync(join(dir, "login.pub"))]),
  });
  if (keyed.code !== 0) return fail(`登录公钥写入 macOS VM 失败：${keyed.output.trim().slice(-300)}`);
  const hostKey = (await tart(["exec", name, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"])).output.trim().split(/\s+/).slice(0, 2).join(" ");
  const ip = (await tart(["ip", name, "--wait", "120", "--resolver", "agent"], { timeoutMs: 150_000 })).output.trim().split("\n").pop();
  if (!/^ssh-ed25519 \S+$/.test(hostKey) || !/^[0-9.]+$/.test(ip ?? "")) return fail(`拿不到 macOS VM 的地址或主机密钥（${ip || "无地址"}）`);
  writeFileSync(join(dir, "known_hosts"), `${ip} ${hostKey}\n`, { mode: 0o600 });
  const sshBase = [
    "-F", "/dev/null", "-i", join(dir, "login"),
    "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`, "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8", "-o", "LogLevel=ERROR",
    `${guest.user}@${ip}`,
  ];
  const session = sshSession({ sshBase, hooks, guest });
  for (;;) {
    if (exited) return fail("macOS VM 意外退出");
    if (Date.now() > deadline) return fail(`macOS VM 在 ${TART_BOOT_SECONDS} 秒内没有接受 SSH`);
    const probe = await session.run("ssh", [...sshBase, "true"], { timeoutMs: 10_000 });
    if (probe.code === 0) break;
    await sleep(1000);
  }
  return { ok: true, bootMs: Date.now() - bootStarted, image, ...session, stop };
}

/* Windows guests (QEMU) ------------------------------------------------------ */

const WINDOWS_BOOT_SECONDS = Number(process.env.IFLINK_CI_WINDOWS_BOOT_SECONDS ?? 300);

/** True when this host can boot Windows job VMs: KVM and an installed image. */
export function windowsAvailable(env = process.env) {
  const image = env.IFLINK_CI_WINDOWS_IMAGE ?? "";
  return Boolean(image) && existsSync(join(image, "root.qcow2")) && existsSync("/dev/kvm");
}

/** The QEMU command line for one Windows job VM (AHCI disk, e1000e NIC: inbox drivers). */
export function windowsQemuArgs({ name, image, dir, port, cpus, memoryMb }) {
  return [
    "-name", name,
    "-machine", "q35,accel=kvm", "-cpu", "host,hv_relaxed,hv_spinlocks=0x1fff,hv_vapic,hv_time",
    "-smp", String(cpus), "-m", String(memoryMb),
    "-nodefaults", "-no-user-config", "-vga", "std", "-display", "none", "-monitor", "none", "-no-reboot",
    "-serial", `file:${join(dir, "console.log")}`,
    "-device", "ahci,id=ahci",
    "-drive", `file=${join(dir, "root.qcow2")},if=none,id=root,format=qcow2,cache=unsafe,discard=unmap`,
    "-device", "ide-hd,drive=root,bus=ahci.0",
    "-drive", `file=${join(dir, "keys.iso")},if=none,id=keys,media=cdrom,readonly=on`,
    "-device", "ide-cd,drive=keys,bus=ahci.1",
    "-netdev", `user,id=net0,ipv4=on,ipv6=off,net=10.0.2.0/24,hostname=ci,hostfwd=tcp:127.0.0.1:${port}-10.0.2.15:22`,
    "-device", "e1000e,netdev=net0",
    "-sandbox", "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
  ];
}

/**
 * Boots a Windows job VM: a fresh overlay of the image
 * deploy/build-windows-image.sh installs, with this job's login key and
 * host key on a small CD that keys.ps1 reads at boot before starting sshd.
 */
async function startWindowsVm({ jobId, workdir, spec, hooks }) {
  if (!windowsAvailable()) return { ok: false, error: "这台 runner 不能启动 Windows VM（缺少 /dev/kvm 或 IFLINK_CI_WINDOWS_IMAGE 镜像）" };
  const defaults = vmDefaults();
  const image = realpathSync(process.env.IFLINK_CI_WINDOWS_IMAGE);
  const dir = join(workdir, "vm");
  const keys = join(dir, "keys");
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "iflink-ci-runner", "-f", join(dir, "login")]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "iflink-ci-vm", "-f", join(keys, "host")]);
  writeFileSync(join(keys, "authorized_key"), readFileSync(join(dir, "login.pub")));
  execFileSync(process.env.IFLINK_CI_GENISOIMAGE ?? "genisoimage", ["-quiet", "-V", "CIKEYS", "-J", "-r", "-o", join(dir, "keys.iso"), keys]);
  execFileSync(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-b", join(image, "root.qcow2"), "-F", "qcow2", join(dir, "root.qcow2")]);
  const port = await freePort();
  const hostKey = readFileSync(join(keys, "host.pub"), "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  writeFileSync(join(dir, "known_hosts"), `[127.0.0.1]:${port} ${hostKey}\n`, { mode: 0o600 });

  const args = windowsQemuArgs({ name: `iflink-ci-${jobId}`, image, dir, port, cpus: spec.cpus ?? defaults.cpus, memoryMb: spec.memory_mb ?? defaults.memoryMb });
  const qemu = spawn(QEMU, args, { stdio: ["ignore", "ignore", "pipe"] });
  let qemuError = "";
  let exited = null;
  qemu.stderr.on("data", (buf) => (qemuError = (qemuError + buf.toString()).slice(-4000)));
  qemu.on("exit", (code, signal) => (exited = { code, signal }));
  qemu.on("error", (err) => (exited = { code: -1, signal: null, error: err.message }));
  const stop = () => {
    if (exited) return;
    try {
      qemu.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  const fail = (why) => {
    stop();
    const console = tailOf(join(dir, "console.log"), 10);
    return { ok: false, error: `${why}${qemuError ? `\nqemu: ${qemuError.trim()}` : ""}${console ? `\n控制台末尾：\n${console}` : ""}` };
  };

  const sshBase = [
    "-F", "/dev/null", "-p", String(port), "-i", join(dir, "login"),
    "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`, "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8", "-o", "LogLevel=ERROR",
    `${WINDOWS_GUEST.user}@127.0.0.1`,
  ];
  const session = sshSession({ sshBase, hooks, guest: WINDOWS_GUEST });
  const bootStarted = Date.now();
  const deadline = bootStarted + WINDOWS_BOOT_SECONDS * 1000;
  for (;;) {
    if (exited) return fail(`Windows VM 启动失败（qemu 退出 ${exited.code ?? exited.signal}${exited.error ? `：${exited.error}` : ""}）`);
    if (Date.now() > deadline) return fail(`Windows VM 在 ${WINDOWS_BOOT_SECONDS} 秒内没有接受 SSH`);
    const probe = await session.run("ssh", [...sshBase, "exit 0"], { timeoutMs: 15_000 });
    if (probe.code === 0) break;
    await sleep(2000);
  }
  return { ok: true, bootMs: Date.now() - bootStarted, image, ...session, stop };
}
