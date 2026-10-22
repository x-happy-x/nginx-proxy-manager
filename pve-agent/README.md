# Proxmox agent

`homenet-pve-agent` collects host and guest metrics through a systemd service.
HomeNet reads snapshots over SSH using a key restricted to `serve`. Version
1.2.0 also supports power operations; a plain installation remains read-only.
Python 3 and `pvesh` are provided by Proxmox VE. No Python packages are needed.

Since 1.3.0 each running guest also carries `ips` (IPv4 from the QEMU guest
agent or LXC interfaces, Docker and loopback interfaces skipped) and `macs`.
HomeNet uses them to show on which server and VM an application runs; a guest
without the guest agent is matched by its MAC in the router's ARP table.

## Installation and update

Copy this directory to the Proxmox host and run the installer there as root.
Use the HomeNet public key configured for that host, never its private key.

```sh
# Monitoring only (also revokes existing power permissions for this key):
sh install.sh 'ssh-ed25519 AAAA... homenet-pve@router'

# Allow VM and LXC power operations:
sh install.sh 'ssh-ed25519 AAAA... homenet-pve@router' --allow-guest-actions

# Also allow reboot/shutdown of the Proxmox host:
sh install.sh 'ssh-ed25519 AAAA... homenet-pve@router' --allow-guest-actions --allow-node-actions
```

The installer updates the executable and systemd unit, restarts collection,
and replaces the matching public-key entry while retaining other keys. Supply
the desired flags on each invocation with a key. Running `sh install.sh`
without a key updates the files but preserves all existing key permissions.

The resulting entry in `/root/.ssh/authorized_keys` looks like:

```text
restrict,command="/usr/local/bin/homenet-pve-agent serve --allow-guest-actions" ssh-ed25519 AAAA... homenet-pve@router
```

On a Proxmox cluster, `authorized_keys` may be shared through `/etc/pve/priv`;
changing permissions for a key can therefore affect every member using it.
Use a separate HomeNet key per host when different permissions are needed.
Reboot and shutdown may interrupt guests and HomeNet itself if it runs there.

Check the installation from HomeNet's host using the configured identity:

```sh
ssh -i /path/to/homenet-key root@proxmox-host ping
ssh -i /path/to/homenet-key root@proxmox-host capabilities
ssh -i /path/to/homenet-key root@proxmox-host bundle
```

The bundle and ping include capabilities for the current SSH key. Refresh
HomeNet after installation. Old agents keep working for monitoring and are
treated as read-only by the manager.

## Restricted protocol

Read requests: `ping`, `current`, `history`, `hardware`, `bundle`,
`capabilities`, and `task UPID`. Power requests are:

```text
control guest qemu|lxc VMID start|shutdown|reboot|stop
control node reboot|shutdown
```

Guest actions require `--allow-guest-actions` in the administrator-owned
forced command; host actions independently require `--allow-node-actions`.
Client request text cannot enable either flag. Guests must exist on the local
host, be unlocked, and have the required current state. Templates are rejected.
`shutdown` requests a graceful shutdown; `stop` cuts guest power. No command
sets `skiplock`, `forceStop`, or `overrule-shutdown`.

An accepted guest action normally returns `{"ok":true,"upid":"UPID:..."}`.
Poll `task UPID` until `status` is `stopped`, then inspect `exitstatus`: only
`OK` indicates task success. Task IDs must belong to this host. For HA-managed
guests, a successful Proxmox task can acknowledge an HA request; refresh the
guest state to see its eventual state. Host actions return an acknowledgement
without a task ID; reconnection and fresh metrics establish the new host state.
On a timeout or lost connection, refresh state before retrying the operation.
If a mutation times out or its response cannot be decoded, the agent returns
`{"ok":true,"unknown":true,"message":"..."}`: this acknowledges receipt only,
and does not establish whether Proxmox started or completed the operation.

Failures return `{"ok":false,"error":"..."}` and a nonzero SSH exit status.
All `pvesh` invocations use argument arrays without a shell. Requests cannot
select another node, an arbitrary API path, extra flags, a shell, or file writes.

## Local checks

```sh
python3 -m unittest discover -s pve-agent/tests -v
sh -n pve-agent/install.sh
```

Run these from the repository root. The Python tests mock Proxmox processes;
they do not contact or change a host.
