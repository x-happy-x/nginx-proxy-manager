# Computer agent for Windows and Linux

HomeNet's PC integration uses a small compiled Go binary over SSH. It collects
a snapshot on demand; no listening port, service, Python or Node.js is needed
on the computer. The manager keeps history and handles searches across hosts.

The agent reports CPU, memory, local disks, network counters and uptime. On
Windows it lists WSL distributions and their state/version. It discovers native
Docker containers and containers in running WSL distributions. Optional actions
start/stop/restart containers and start/terminate WSL distributions.

Network details retain each interface; aggregate host traffic uses only
interfaces with a default IPv4/IPv6 route, avoiding duplicate Docker bridge and
veth traffic. Multiple default routes (for example a VPN and its physical
uplink) can still describe overlapping traffic, so inspect interface details
when comparing those numbers.

## Build

From the repository root, with Go 1.22 or newer and PowerShell:

```powershell
./pc-agent/build.ps1
```

The script creates ready-to-copy directories, each with a binary and installer:

- `pc-agent/dist/windows-amd64/`
- `pc-agent/dist/windows-arm64/`
- `pc-agent/dist/linux-amd64/`
- `pc-agent/dist/linux-arm64/`

The binaries are static Go builds (`CGO_ENABLED=0`). Build artifacts are ignored
by Git. For a single Linux build without PowerShell:

```sh
cd backend
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags '-s -w' -o ../pc-agent/homenet-pc-agent ./pcagent
```

## Install over SSH

Enable the target's OpenSSH server first. Use your regular administrative SSH
login to upload/install the agent; the restricted HomeNet key deliberately
cannot upload files or open a shell. In HomeNet's computer settings, generate
the integration key and copy its **public** key.

Linux example (replace `user`, `pc`, and the sample key):

```sh
ssh user@pc 'mkdir -p ~/homenet-agent-install'
scp pc-agent/dist/linux-amd64/homenet-pc-agent pc-agent/dist/linux-amd64/install.sh user@pc:homenet-agent-install/
ssh -t user@pc
sh ~/homenet-agent-install/install.sh 'ssh-ed25519 AAAA... homenet-pc@router'
```

Add `--allow-docker-actions` to the installer command to enable container power
controls. The installer runs as the SSH account, puts the binary at
`~/.local/bin/homenet-pc-agent`, and adds a restricted key to
`~/.ssh/authorized_keys`. That account must already have access to Docker's
local socket; the agent never runs `sudo` or changes group membership.

Windows example from PowerShell, using the same Windows account that owns the
WSL distributions and uses Docker Desktop:

```powershell
scp pc-agent/dist/windows-amd64/homenet-pc-agent.exe pc-agent/dist/windows-amd64/install.ps1 user@pc:.
ssh -t user@pc
powershell.exe -NoProfile -File install.ps1 -PublicKey 'ssh-ed25519 AAAA... homenet-pc@router'
```

Enter the last command in a PowerShell session on the target (run
`powershell.exe -NoProfile` first if SSH opens `cmd.exe`). Add
`-AllowDockerActions` and/or `-AllowWSLActions` as needed. Windows installs to
`%LOCALAPPDATA%\HomeNet\pc-agent.exe`, with the public key in the current
profile's `.ssh\authorized_keys`. It does not install a Windows service and
must run as that user, not SYSTEM or a separate administrator profile: WSL
registrations are per Windows user.

For an account in the local Administrators group, default Windows OpenSSH
configuration reads `%ProgramData%\ssh\administrators_authorized_keys` instead.
Run the installer in an elevated PowerShell session **as the same account**
with `-AdministratorKeyFile`; it applies the required Administrators/SYSTEM
ACL. If SSH has been configured to use another key-file location or a different
default shell, adapt that configuration explicitly. The generated Windows
forced command assumes the normal `cmd.exe` OpenSSH default shell. Prefer a
dedicated ordinary account when its WSL/Docker access meets your needs.

Finally configure the computer's address, SSH port, username and trusted host
fingerprint in HomeNet. The connection check uses `ping`; refresh the computer
page to collect its first snapshot.

## Update and permissions

Copy the new binary and rerun the same installer with the public key and the
desired permission flags. Existing unrelated keys are preserved. Omitting
control flags revokes both categories of power control for that key. Control
is read-only by default and advertised per SSH key through `capabilities`.

An authorized key runs only the installed binary's `serve` command. Requests
cannot enable permissions, choose an arbitrary command or execute a shell.
The forced-command entry contains the permission flags, for example on Linux:

```text
restrict,command="'/home/user/.local/bin/homenet-pc-agent' serve --allow-docker-actions" ssh-ed25519 AAAA... homenet-pc@router
```

Docker uses the local system endpoint explicitly: `/var/run/docker.sock` on
Linux and inside WSL, and `//./pipe/docker_engine` on Windows. An inherited
Docker CLI context or `DOCKER_HOST` cannot redirect control to another server.
Rootless Docker sockets and remote Docker contexts are not part of this first
version. Docker must be available in the SSH user's PATH (and in each WSL
distribution being inspected). Docker Desktop may expose the same engine from
several contexts; those entries can describe the same containers.

Monitoring checks that a WSL distribution is running before executing Docker
there. Stopped distributions stay stopped and show an unavailable Docker
context. WSL start invokes `/bin/true` to boot the distribution; WSL may stop
it again when idle. Terminate stops all processes in that distribution. No
global WSL shutdown or unregister operation is exposed.

## Protocol and verification

Read-only SSH requests: `ping`, `capabilities`, `snapshot`. Actions use
`control BASE64URL` where the unpadded Base64URL payload is a strict JSON object:

```json
{"target":"docker","context":"native","id":"FULL_64_CHARACTER_CONTAINER_ID","action":"restart"}
{"target":"wsl","name":"Ubuntu","action":"start"}
```

Docker contexts are `native` or `wsl:DISTRIBUTION_NAME`; actions are `start`,
`stop`, `restart`. WSL actions are `start` and `terminate`. The agent rechecks
inventory and state immediately before control. Container IDs must be full
hexadecimal IDs, and WSL names must exactly match current registrations.
Commands use argument arrays; no request value is inserted into a shell script.

Replies use `{"ok":true,"message":"..."}` or
`{"ok":false,"error":"..."}`. If a power command times out, the reply includes
`"unknown":true`; inspect refreshed state before retrying. Docker stop/restart
uses a 20-second graceful timeout (Docker may then kill the container). Overall
collection is bounded by 30 seconds and control by 45 seconds.

```powershell
cd backend
go test ./pcagent
go vet ./pcagent
```

Tests mock process execution and verify disabled permissions, fresh inventory
checks, stopped WSL handling, localized UTF-16 WSL output, argument separation,
injection rejection and ambiguous timeouts. Test on the actual Windows/Linux
SSH target before relying on control; local compilation does not verify that
target's account, Docker permissions, SSH shell or WSL installation.
