# IF.Lathe

Self-hosted CI for GitHub repositories, built to replace GitHub Actions on your
own machines. Every job runs in a fresh VM (Linux, macOS or Windows), and the
results go back to GitHub as check runs with the log, error annotations,
deployments and code-scanning uploads. Lathe can also have an LLM review each
pull request and explain failed runs.

[中文说明](#中文说明)

- **No inbound traffic.** The control plane polls GitHub (heads of branches and
  open pull requests) through a GitHub App. It never needs a public address or
  webhooks.
- **A VM per job.** Linux jobs boot a QEMU/KVM image built from
  `images/linux`, macOS jobs an APFS clone of a [tart](https://tart.run)
  image, Windows jobs a Windows Server image built from `images/windows`. The
  VM is deleted when the job ends.
- **Results on GitHub.** A check run per pipeline (queued → in progress →
  completed) with the step table, the last 60 KB of the log and up to 50
  annotations parsed from compiler and linter output. Falls back to commit
  statuses when the App lacks the Checks permission. Pipelines with an
  `environment` also create GitHub Deployments, and `code_scanning` uploads
  the run's SARIF files (for example from the CodeQL CLI).
- **LLM review.** For repositories with review on, each new pull-request head
  gets an "AI review" check: a summary, a risk level and findings annotated on
  changed lines (bugs, security, tests, dependency updates). The check is
  always `neutral`, so it never blocks a merge. Failed runs get a short "likely
  cause / fix" note in their check. Any OpenAI-compatible API works; the
  defaults are DeepSeek's.
- **Caches for VMs.** A Maven Central cache and a Docker Hub pull-through cache
  on the runner host, so a hundred fresh VMs do not each download the same
  artifacts.

## How it fits together

```
           GitHub (App: checks, statuses, deployments, code scanning)
                ▲  poll heads, report results           ▲ clone
                │                                        │
  ┌─────────────┴──────────────┐   runner protocol   ┌───┴──────────────────┐
  │ control plane              │◀───── HTTP ────────▶│ runner (runner.mjs)  │
  │ bin/lathe.mjs serve        │  claim, log,        │ one job at a time    │
  │ SQLite: pipelines, runs,   │  artifacts, finish  │  └─ VM per job       │
  │ vault, audits              │                     │     (QEMU/tart)      │
  └────────────────────────────┘                     └──────────────────────┘
```

The control plane and the runners can share a host or not. Runners reach the
control plane over HTTP; a macOS runner on another network reaches it through
an SSH tunnel to a tunnel-only account (`deploy/install-mac-runner.sh`).

## Quick start (one Linux host with KVM)

Requirements: Node 24+, `qemu-system-x86`, `qemu-utils`, `openssh-client`,
`nftables`, Docker (to build the Linux VM image), systemd.

```bash
git clone https://github.com/IF-Link-Tech-Team/IF.Lathe /opt/lathe
sudo /opt/lathe/deploy/install-server.sh
```

This creates the `lathe` account and `/srv/lathe/lathe.env` (vault key and
read-API token, generated once), registers this host's runners, builds the
Linux VM image, installs the caches and the loopback firewall, and starts
`lathe.service` plus three runner units.

Then create a GitHub App (see [Permissions](#github-app-permissions)), install
it on your repositories, and give Lathe its key:

```bash
cd /opt/lathe
sudo -u lathe env $(sudo cat /srv/lathe/lathe.env) node bin/lathe.mjs github-app set --app-id 123456 --installation 7890123 --key app.pem
sudo -u lathe env $(sudo cat /srv/lathe/lathe.env) node bin/lathe.mjs pipelines apply pipelines/
```

## Pipeline files

One JSON file per repository; `lathe pipelines apply <file|dir>` registers them
(re-applying updates them).

```json
{
  "repo": "owner/app",
  "branch": "main",
  "audit": true,
  "pipelines": [
    {
      "name": "app/check",
      "vm": { "cpus": 4, "memory_mb": 8192 },
      "on": ["push", "pull_request"],
      "steps": [
        { "name": "install", "run": "npm ci" },
        { "name": "test", "run": "npm test", "shell": "bash" }
      ]
    },
    {
      "name": "app/deploy",
      "after": ["app/check"],
      "serial": true,
      "secrets": { "DEPLOY_KEY": "APP__DEPLOY_KEY" },
      "environment": { "name": "production", "url": "https://app.example.org" },
      "steps": [{ "name": "release", "run": "./deploy.sh" }]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `repo` | `owner/name` (cloned over HTTPS) or any clone URL, such as `git@gh-name:owner/name.git` for a private repository with a deploy key |
| `audit` | LLM review of pull requests; on by default when a pipeline runs on `pull_request` |
| `dormant` | every pipeline of the file runs only by hand (while another CI still deploys) |
| `on` | `push`, `pull_request`; unset means `["push"]`, `[]` means manual, `after` or schedule only |
| `after` | pipelines that must have succeeded at the same commit first (outside pull requests) |
| `vm` | run in a throwaway VM; `os`: `linux` (default), `macos`, `windows` |
| `needs` | runner labels the job requires; a job without `vm` runs on the runner host itself and never goes to a `vm-only` runner |
| `steps` | `{ name, run, shell?: "sh" \| "bash", allow_failure? }`; Windows steps run in PowerShell 7 |
| `secrets` | env name → vault key; given only to trusted runs: the pipeline's own branch, never a pull request |
| `inputs` | env names a manual run may set |
| `schedule` | `every:<minutes>` or a 5-field UTC cron |
| `serial` | never two jobs of this pipeline at once |
| `artifacts` | globs kept after the run |
| `status` | check name on GitHub (default: the part of `name` after `/`) |
| `environment` | `{ name, url? }`: each trusted run is a GitHub deployment |
| `code_scanning` | upload the run's `.sarif` artifacts to code scanning |
| `checkout` | `{ depth, submodules, repos }`; `repos` lists `owner/name` repositories the steps clone themselves (private dependencies): a trusted run gets a GitHub App token that can only read those, for an hour, and git in the job uses it for their https, ssh and `gh-<name>` URLs |

Private repositories: put a read-only deploy key for each in
`~/.ssh/iflink-ci/key_<name>` of the installing user. The installer copies it
to the runner account with an SSH alias `gh-<name>`.

## GitHub App permissions

| Permission | Access | Used for |
|---|---|---|
| Contents | read | heads of branches |
| Metadata | read | required |
| Pull requests | read | open pull requests, their files for review |
| Checks | read & write | check runs, AI review |
| Commit statuses | read & write | fallback when Checks is not granted |
| Deployments | read & write | `environment` pipelines |
| Code scanning alerts | read & write | SARIF uploads |

No webhook is needed; leave it inactive.

## Command line

```
lathe serve                           control plane, watcher (every LATHE_WATCH_SECONDS) and scheduler
lathe pipelines apply <file|dir>      register pipeline files
lathe pipelines list
lathe run <pipeline> [--ref R] [--commit SHA]
lathe runs [--limit N]
lathe logs <run-id>
lathe runner add <name> [--labels linux,x64,vm]   prints IFLINK_CI_TOKEN=… for runner.env
lathe runner labels                   sync a runner's registered labels from IFLINK_CI_TOKEN / IFLINK_CI_LABELS
lathe secret set <KEY> < value        vault value (read from stdin, never from arguments)
lathe secret list
lathe github-app set --app-id N --installation N --key app.pem
lathe watch [--dry-run]               one watcher pass
lathe health [--optional-runner N]    the CI's own health as JSON: watcher, runners, queue, disk (exit 1 if a check fails)
```

## Settings

Control plane: `LATHE_DB` (`./data/lathe.db`), `LATHE_SECRET_KEY` (vault key,
16+ characters; keep it, everything in the vault is sealed with it),
`LATHE_LISTEN` (`127.0.0.2:4311`), `LATHE_ADMIN_TOKEN` (bearer token of the
read API `GET /api/v1/runs[/:id]`), `LATHE_DATA` (artifacts),
`LATHE_WATCH_SECONDS` (120), `IFLINK_CI_PUBLIC_URL` (optional link from checks
to a console).

LLM: store the API key with `lathe secret set LATHE__LLM_API_KEY`.
`LATHE_LLM_BASE_URL` (`https://api.deepseek.com`), `LATHE_REVIEW_MODEL`
(`deepseek-v4-pro`), `LATHE_EXPLAIN_MODEL` (`deepseek-flash`),
`LATHE_LLM_DAILY_TOKENS` (3,000,000; reviews stop for the day past it),
`LATHE_AUDITS_PER_PASS` (4), `LATHE_LLM_KEY` (vault key name).

Runner (`runner.env`): `IFLINK_CI_URL`, `IFLINK_CI_TOKEN`, `IFLINK_CI_LABELS`,
`IFLINK_CI_WORK`, `IFLINK_CI_VM_IMAGE`, `IFLINK_CI_VM_CPUS`,
`IFLINK_CI_VM_MEMORY_MB`, `IFLINK_CI_WINDOWS_IMAGE`, `IFLINK_CI_TART`,
`IFLINK_CI_TART_IMAGE`, `IFLINK_CI_ARTIFACT_MAX_MB`, `IFLINK_CI_POLL_MS`.

## Runner hosts

- **Linux**: `deploy/install-runner-host.sh` (called by `install-server.sh`, or
  on its own with `RUNNER_ENV` and `CONTROL_HOST`/`CONTROL_PORT` for a separate
  control plane).
- **Windows jobs**: put a Windows Server 2025 evaluation ISO at
  `/var/lib/iflink-ci-vm/windows/ws2025-eval.iso` and re-run the installer; it
  builds the image unattended (Node 24, Python 3.12 with uv, PowerShell 7, Git)
  and the runners start claiming `vm-windows` jobs.
- **macOS jobs**: `deploy/install-mac-runner.sh` on a Mac, as the logged-in
  user (tart needs a GUI session). Register its runner with
  `--labels vm-macos,vm-only`.
- **`vm-only`**: a runner with this label is never given a job without `vm`,
  so nothing runs on its host. The installers set it by default; a job on the
  host would run as the runner's account and could read the runner's token.
  `RUNNER_HOST_JOBS=1 install-runner-host.sh` drops it.

## Embedding

Lathe is also a library (`@iflink/lathe`). A host program that has its own
database, vault and projects calls `configureLathe({ name, makeError,
resolveSecret, onRunFinished, deployOnSuccess, githubApp })` once and mounts
the runner protocol with `claimAndReport` / `finishAndReport`. IF.Platform
runs Lathe this way.

## Threat model

- Job code is untrusted. It runs as root inside a VM that shares nothing with
  the host but the checked-out tree. The VM's QEMU process runs as a dedicated
  account with no sudo, inside a systemd sandbox: the rest of the filesystem,
  private networks, the host's own addresses and other loopback services are
  out of reach (an nftables table limits loopback to the control plane, the
  caches and ephemeral ports).
- Secrets go only to trusted runs, those of the pipeline's own branch; pull
  requests never get them. A fork pull request by a first-time contributor
  does not run until a maintainer labels it `ci-approved` (as Actions'
  first-time contributor rule). Secret values are redacted from logs.
- The LLM sees the diff and pull-request text as data, has no tools, and its
  answer is shown as plain text with links removed. Logs sent for failure
  explanations are already redacted. Lockfiles, generated and binary files are
  not sent.
- The control plane holds the App key and the vault, sealed with
  `LATHE_SECRET_KEY` (AES-256-GCM). Keep it off public networks; nothing needs
  to reach it except the runners.

## Third-party pieces

- [tart](https://github.com/cirruslabs/tart) (macOS VMs) is under the Fair
  Source licence, with usage limits for larger organisations.
- Windows Server evaluation images expire after 180 days; rebuild or license
  them.
- The CodeQL CLI is free for public repositories and research; private
  repositories need GitHub Advanced Security.
- [distribution](https://github.com/distribution/distribution) (Docker Hub
  cache) is Apache-2.0; Node.js is MIT.

## Development

```bash
npm test          # node --test, including an end-to-end run with a real runner
npm run typecheck
```

---

## 中文说明

IF.Lathe 是自托管的 GitHub CI，用来在自己的机器上替代 GitHub Actions。

- **不需要入站流量**：控制面通过 GitHub App 轮询分支和 PR 的 head，不需要公网地址或 webhook。
- **每个 job 一台全新 VM**：Linux 用 QEMU/KVM，macOS 用 tart 的 APFS 克隆，Windows 用无人值守构建的 Windows Server 镜像；job 结束即删除。
- **结果回到 GitHub**：每条流水线一个 check run，带步骤表、日志末尾 60 KB 和从编译器/lint 输出解析出的注释（最多 50 条）；App 没有 Checks 权限时退回 commit status。带 `environment` 的流水线同时创建 GitHub Deployment，`code_scanning` 会上传 SARIF。
- **LLM 审查**：开启审查的仓库，每个新的 PR head 会得到一个 “AI review” check：摘要、风险等级和标在改动行上的发现（bug、安全、测试、依赖更新）。结论恒为 `neutral`，不会阻塞合并。失败的运行会在 check 里追加“可能原因 / 修复建议”。兼容任何 OpenAI 格式的 API，默认使用 DeepSeek。
- **VM 用的缓存**：runner 主机上有 Maven Central 缓存和 Docker Hub 拉取缓存。

快速开始：在一台有 KVM 的 Linux 主机上运行 `sudo deploy/install-server.sh`，然后用 `lathe github-app set` 写入 App 私钥，用 `lathe pipelines apply` 注册流水线文件。字段、权限、命令和设置见上文英文部分。

安全模型：job 代码视为不可信，只在 VM 里以 root 运行，VM 进程本身在专用账号和 systemd 沙箱里，访问不到内网、主机地址和其他回环服务；密钥只交给可信运行（流水线自己分支上的运行，PR 永远拿不到），首次贡献者的 fork PR 要等维护者加上 `ci-approved` 标签才会运行；日志中的密钥值会被遮盖；LLM 只把 diff 和 PR 文本当数据处理，没有工具，输出按纯文本展示并去掉链接。

许可证：MIT。第三方组件的许可见上文 “Third-party pieces”。
