# Running shuv2code in the Background

On a Linux host, shuv2code can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest shuv2code release:

```sh
npx shuv2code@latest service install
```

Check whether it is installed:

```sh
npx shuv2code@latest service status
```

Update or repair it:

```sh
npx shuv2code@latest service update
```

Stop it and remove it from startup:

```sh
npx shuv2code@latest service uninstall
```

Updating restarts shuv2code briefly. Let active agent work and terminal commands finish first.

The systemd unit runs a small stable launcher. Exact shuv2code versions are installed separately, so
a failed remote candidate can return to the previous version without rewriting the unit. Releases
that change the database must be installed with the local `service update` command above.

## Using It with shuv2code connect

shuv2code connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and shuv2code connect are managed separately.

Signing out of shuv2code connect does not remove the service. Use `shuv2code service uninstall` when you no longer
want shuv2code to start in the background.

The background service currently requires Linux with systemd.
