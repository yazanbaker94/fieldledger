# VPS deployment

## Ubuntu and Caddy

The native deployment runs FieldLedger under its own system user. PostgreSQL authenticates that user over a local Unix socket. Caddy serves the dedicated hostname over HTTPS, with DNS managed in Cloudflare.

Install Node.js 22.12 or later, PostgreSQL 18, and `iproute2`. On a fresh Ubuntu 26.04 VPS with those packages, run the following once to create the app account and database.

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin fieldledger
sudo -u postgres createuser fieldledger
sudo -u postgres createdb --owner=fieldledger fieldledger
sudo -u fieldledger psql -d fieldledger -c 'select current_user;'
```

From a clone on the VPS, deploy a reviewed commit. The script builds the release, validates its service unit, and serializes service changes with a host-local lock. It verifies that the service process owns the HTTP listener, is running from the expected release directory, and serves the expected app page and healthy API. If an update fails, it restores the previous unit and release, then checks the restored service if it was running. A failed first deployment removes its service unit and release. The first successful deployment enables the service on boot. Updates start the service and preserve its existing boot configuration.

The native app also serves hashed assets from the previous distinct asset build. This covers browsers that received its HTML during a deployment. Rebuilding identical assets preserves that fallback. After a rollback, the restored release also serves the latest failed candidate's hashed assets for browsers that already received its page. A later failed cutover replaces those candidate assets, and the next healthy deployment establishes a fresh fallback. After a healthy deployment, the script retains the active release and the one it replaced for rollback, then removes older managed release directories. Hard links keep each retained release's fallback available through that cleanup and through rollback.

```sh
bash deploy/native-release.sh HEAD
```

On a VPS where Caddy imports `/etc/caddy/sites/*.caddy`, install the site file, validate the full configuration, and reload Caddy.

```sh
sudo install -m 0644 deploy/fieldledger.swoop.video.caddy /etc/caddy/sites/
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Add the `fieldledger` DNS record in the Cloudflare `swoop.video` zone, pointing to the VPS. Start with **DNS only** so Caddy can obtain a publicly trusted origin certificate. Verify `https://fieldledger.swoop.video/api/health` and complete a fresh timecard workflow on the public site.

```sh
curl --fail --show-error https://fieldledger.swoop.video/api/health
curl --fail --show-error --silent --output /dev/null https://fieldledger.swoop.video/
sudo journalctl -u fieldledger.service -n 50 --no-pager
```

To roll back a healthy deployment after a functional regression, rerun `bash deploy/native-release.sh <previous-commit>` and repeat the public checks. If automatic recovery fails, the script prints the location of the retained rollback files. Code rollback uses the existing database. Keep schema changes compatible with the previous release or plan a separate database restore before deploying them.

FieldLedger starts after PostgreSQL. During a planned PostgreSQL stop and start, FieldLedger stays running and its health endpoint returns an error until the database accepts connections again. Recheck the public health endpoint after database maintenance.

## Docker Compose

Compose runs an app container and a PostgreSQL container. The app publishes a loopback-only port for origin checks. The database is reachable on the private Compose network and persists in its own named volume.

### Start the origin

Use an existing Docker Engine and Compose v2 installation on the VPS. Clone the repository into its own deployment directory. Create `.env` from `.env.example`, set `POSTGRES_PASSWORD` to the output of `openssl rand -hex 32`, and set `APP_ORIGIN` to the exact public HTTPS origin, such as `https://fieldledger.swoop.video`. Protect `.env` with `chmod 600 .env`. Leave `APP_PORT` at `3088` or choose another free loopback port.

```sh
docker compose up -d --build --wait
curl --fail --show-error http://127.0.0.1:3088/api/health
```

### Publish with Cloudflare Tunnel

Create a dedicated remotely managed tunnel in the Cloudflare dashboard under **Networking → Tunnels**. Add a published application route for the demo subdomain with service URL `http://app:3000`. Put the tunnel token in the VPS `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Set `TRUST_PROXY=1` for the single tunnel connector forwarding the client address, then enable the connector.

```sh
docker compose --profile tunnel up -d --wait
curl --fail --show-error https://fieldledger.swoop.video/api/health
```

Cloudflare creates the subdomain DNS record when you publish the route in the dashboard. Check that the public HTTPS page loads and complete a fresh submit, return, resubmit, and approval through the browser. A fresh session starts at CAD $9,700 in approved labour. Approving eight hours increases it to $10,100.

If you already have a Cloudflare connector or HTTPS reverse proxy running directly on the VPS, you can add a hostname-specific route from that connector or proxy to `http://127.0.0.1:3088` and leave the optional Compose tunnel disabled. Configure the proxy to sanitize the client IP header before setting `TRUST_PROXY=1`. Use `TRUST_PROXY=0` when reaching the app directly.

### Updates and troubleshooting

After pulling a reviewed revision, rerun `docker compose up -d --build --wait` with the same profile options. The `app-assets` volume keeps hashed bundles from the last healthy release and the most recent replacement available through container updates. Retain that volume across updates.

If the running container predates the asset cache, seed the volume once before replacing it. Run this from the updated checkout while the old app is still running.

```bash
(
  set -euo pipefail
  docker compose build app
  docker compose exec -T app tar -C /app/dist -cf - assets |
    docker compose run --rm --no-deps -T --entrypoint sh app -ec '
      source_dir=$(mktemp -d)
      tar -xf - -C "$source_dir"
      FIELDLEDGER_ASSET_SOURCE="$source_dir/assets" sh /usr/local/bin/fieldledger-entrypoint \
        sh /usr/local/bin/fieldledger-entrypoint --mark-healthy
    '
  docker compose up -d --wait
)
```

Run `docker compose ps` and `docker compose logs --tail=100 app db` for health and startup diagnostics. The `pgdata` volume survives normal updates. Back it up before a database major-version upgrade.
