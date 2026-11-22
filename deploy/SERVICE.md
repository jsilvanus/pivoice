# systemd user unit

`pivoice.service` runs pivoice as a systemd user service.

Expected layout (relative to the service user's home, `%h`):

- app checkout: `~/apps/pivoice` (runs `src/main.js` directly, no build step)
- environment file: `~/apps/pivoice.env` (all settings and secrets live here, never in git)
- Node.js: `~/.local/bin/node`

Install:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/pivoice.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pivoice
loginctl enable-linger "$USER"   # once, so it runs without a login session
```

Status and logs: `systemctl --user status pivoice`, `journalctl --user -u pivoice -f`.
