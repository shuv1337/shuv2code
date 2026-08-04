# shuv2code connect Clerk Setup

shuv2code connect uses one Clerk application for web, desktop, and mobile authentication. The relay accepts
Clerk JWTs only when they are generated from the `shuv2code-relay` template with the shared
`shuv2code-relay` audience.

## Application Keys

shuv2code connect is disabled in a fresh clone. To enable it for source builds, add a repository-root `.env`
or `.env.local` file:

```dotenv
SHUV2CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
SHUV2CODE_CLERK_JWT_TEMPLATE=<JWT template name>
SHUV2CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
SHUV2CODE_RELAY_URL=https://relay.example.com
```

The shared client loader projects these canonical values into framework-specific `VITE_*` and
`EXPO_PUBLIC_*` aliases. Existing aliases remain accepted as overrides for compatibility, but new
client configuration should use the canonical names.

Configuration precedence is:

1. Process or CI environment variables.
2. Repository-root `.env.local`.
3. Repository-root `.env`.

The Clerk publishable key, JWT template name, CLI OAuth client ID, and relay URL are public
identifiers, not secrets.
Web, desktop, mobile, and bundled server builds statically inject the values they consume during
their build step. A built artifact does not need an environment file at runtime. CI release builds
should set `SHUV2CODE_CLERK_PUBLISHABLE_KEY`, `SHUV2CODE_CLERK_JWT_TEMPLATE`,
`SHUV2CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and `SHUV2CODE_RELAY_URL` before building. EAS preview and
production builds only need the Clerk publishable key, JWT template name, and relay URL in their EAS
environment.

When any client-facing public value is absent, cloud UI is omitted. When the CLI public values are
absent, the `shuv2code connect` CLI command group is omitted. The bundled server still accepts runtime
overrides for self-hosted or operator-managed
deployments.

For a hosted relay deployment, copy `infra/relay/.env.example` to `infra/relay/.env`. The relay
deployment reads `RELAY_DOMAIN`, `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`,
`CLERK_PUBLISHABLE_KEY`, and `CLERK_JWT_AUDIENCE` through Effect `Config`. There are no checked-in
deployment defaults.
`vp run --filter shuv2code-relay deploy` invokes Alchemy from the relay directory, so Alchemy loads
`infra/relay/.env`. After a successful deployment, the wrapper updates the repository-root `.env`
with the deployed HTTPS relay URL. The relay still requires
`CLERK_SECRET_KEY` as an Alchemy secret. Never put `CLERK_SECRET_KEY` in a client application
environment or commit it to the repository.

The `prod` Alchemy stage owns the retained PlanetScale database. Non-production stages reference
that database and provision isolated PlanetScale branches, so deploy `prod` before creating a
personal developer stage.

## Headless CLI OAuth Application

The `shuv2code connect` commands authorize a headless environment with a separate Clerk OAuth application.
This uses an OAuth public client with PKCE, so the CLI stores no client secret.

In **Clerk Dashboard > OAuth applications**:

1. Create an OAuth application for the shuv2code CLI.
2. Enable the **Public** option so authorization-code exchange uses PKCE.
3. Add `http://127.0.0.1:34338/callback` as an allowed redirect URI.
4. Enable the `openid`, `profile`, and `email` scopes.
5. Set `SHUV2CODE_CLERK_CLI_OAUTH_CLIENT_ID` in the repository-root `.env` file and release build
   environment to the generated public client ID.

The CLI derives Clerk's frontend API URL from the publishable key and calls Clerk's
`/oauth/authorize` and `/oauth/token` endpoints directly. The relay is not involved in the OAuth
handshake; it only validates the issued Clerk bearer token when the CLI manages an environment link.

The CLI supports these headless operations:

```sh
shuv2code connect login
shuv2code connect link
shuv2code connect status
shuv2code connect unlink
shuv2code connect logout
shuv2code serve
```

`shuv2code connect login` opens the Clerk authorization flow and stores the CLI credential without enabling
cloud exposure. `shuv2code connect link` installs the pinned managed `cloudflared` binary when needed,
authorizes when needed, and records durable intent to expose the environment. It works without a
running shuv2code server. The next `shuv2code serve` or `shuv2code start` reconciles the relay link and launches the
managed tunnel. `shuv2code connect unlink` records disabled intent immediately, stops a reachable running
connector, and attempts to revoke the relay-side environment record. It retains the stored CLI
authorization so `shuv2code connect link` can re-enable exposure without another browser flow. `shuv2code connect
logout` performs the same cleanup and removes the stored CLI authorization.

The background service has an independent lifecycle. Connect setup may offer to install it, but
logout leaves it running; manage it with `shuv2code service status`, `install`, `update`, and `uninstall`.

The current OAuth callback listener binds to loopback port `34338`. When running the CLI over SSH,
forward that port before running `shuv2code connect login` or `shuv2code connect link`:

```sh
ssh -L 34338:127.0.0.1:34338 <host>
```

A relay-hosted callback broker can remove this port-forward requirement later without changing the
stored PKCE token model.

## JWT Template

In **Clerk Dashboard > JWT templates**, create a template with:

| Setting | Value                          |
| ------- | ------------------------------ |
| Name    | `shuv2code-relay`              |
| Claims  | `{ "aud": "shuv2code-relay" }` |

Set `SHUV2CODE_CLERK_JWT_TEMPLATE=shuv2code-relay` in the repository-root `.env`, and set
`CLERK_JWT_AUDIENCE=shuv2code-relay` in `infra/relay/.env`. Define `CLERK_JWT_TEMPLATE` and
`CLERK_JWT_AUDIENCE` in the production relay deployment environment as well. The stable `aud` value
is shared by production and non-production relay stages. The client-facing `SHUV2CODE_RELAY_URL` still
selects the concrete relay deployment, but changing that URL does not require a JWT template change.

## Desktop OAuth Redirect Allowlist

The desktop app opens OAuth in the system browser and returns to the app with a custom URL scheme.
In **Clerk Dashboard > Native applications**, enable the Native API and add these entries under the
mobile SSO redirect allowlist:

```text
shuv2code-dev://app/
shuv2code://app/
```

Local desktop development uses `shuv2code-dev://app`, while packaged builds use `shuv2code://app`. Add the
matching origin to each Clerk instance's Backend API `allowed_origins` array as well. The development
Clerk instance should only need `shuv2code-dev://app`; the production Clerk instance should only need
`shuv2code://app`. `@clerk/electron` owns the native request adapter, encrypted Clerk token persistence,
external-browser OAuth transport, and callback delivery for initial sign-in and linked-account flows.

There is currently no Dashboard UI for `allowed_origins`. Preserve any existing entries and update
the instance through the Backend API:

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -d '{"allowed_origins":["shuv2code://app"]}'
```

Never put `CLERK_SECRET_KEY` in the desktop app, a client-facing environment file, or a build
artifact.

## Desktop Passkeys

The production macOS bundle ID is `dev.shuv.shuv2code`. To enable native passkeys:

1. Create an explicit macOS App ID for `dev.shuv.shuv2code` in the Apple Developer portal and enable
   **Associated Domains**.
2. Create a compatible macOS provisioning profile for that App ID and the certificate used to sign
   the distributed app.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID. This is
   also the configuration point for Electron/macOS passkeys.
4. Confirm Clerk serves `https://<frontend-api>/.well-known/apple-app-site-association` and that
   `webcredentials.apps` contains `<TEAM_ID>.dev.shuv.shuv2code`.
5. Set the local or CI signing configuration described below.

For a local signed build, add these values to `.env.local` or export them before invoking the
desktop artifact command:

```dotenv
SHUV2CODE_APPLE_TEAM_ID=ABC1234567
SHUV2CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/shuv2code.provisionprofile
# Optional: comma-separated override when Clerk's RP ID differs from the Frontend API hostname.
SHUV2CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

When `SHUV2CODE_CLERK_PASSKEY_RP_DOMAINS` is absent, the build derives the RP domain from
`SHUV2CODE_CLERK_PUBLISHABLE_KEY`. Signed macOS builds fail early if the Team ID, provisioning profile,
or RP-domain configuration is missing. The generated main-app entitlements include every configured
`webcredentials:<domain>` entry; helper apps keep Electron's minimal default entitlements.

The normal `dev:desktop` launcher is unsigned and cannot complete macOS passkey ceremonies. For
renderer HMR, build and install a signed app first, run the renderer dev server, then launch the
installed app executable with `VITE_DEV_SERVER_URL` and `SHUV2CODE_PORT` set. Rebuild the signed app
after native dependency, main-process, preload, entitlement, provisioning, or signing changes;
renderer-only changes can reuse the installed app.

For the default development ports, run `pnpm dev:web` in one terminal and launch the installed
binary from another:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
SHUV2CODE_PORT=13773 \
  "/Applications/shuv2code (Alpha).app/Contents/MacOS/shuv2code (Alpha)"
```

After changing Associated Domains, bump the build version before rebuilding; macOS may otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/shuv2code (Alpha).app"
codesign -d --entitlements :- "/Applications/shuv2code (Alpha).app"
```

The current mobile UI uses Clerk's native authentication view. If a future mobile browser OAuth
flow uses a custom redirect URI, add that exact URI to the same allowlist.

## Enable Waitlist Access

For a private beta where people should request access, use **Clerk Dashboard > Waitlist**:

1. Toggle on **Enable waitlist** and save.
2. Review requests on the same page and select **Invite** or **Deny**.

Approved signed-in users manage shuv2code connect under **Connections**. The web and desktop sidebars do
not expose a dedicated account or waitlist control. Signed-out users reach Clerk's waitlist and
sign-in flow contextually from the shuv2code connect controls on the Connections page.

On mobile, signed-out users open **Settings > shuv2code Account** to reach `/settings/waitlist` within the
Settings form sheet. It submits enrollment through Clerk's `useWaitlist()` flow because the prebuilt
`<Waitlist />` component is web-only in the Expo SDK. Approved users can use **Sign in** from that
screen.

## Alternative: Known-User Allowlist

For a closed beta where all permitted users are known in advance, use an allowlist instead of a
request-and-approval waitlist:

To restrict the beta to permitted email addresses or domains:

1. In **Clerk Dashboard > Restrictions > Allowlist**, add each permitted email address or email
   domain.
2. Enable the allowlist and save.
3. Alternatively, enable **Restricted mode** when all new users must be explicitly invited or
   manually created without a waitlist request flow.

Do not enable an empty allowlist: it blocks all new sign-ups.

Clerk allowlists control who can sign up. They do not revoke an existing user's active cloud
access. To remove an already-created user's access, ban that user in Clerk so their active
sessions are ended and future sign-ins are rejected.
