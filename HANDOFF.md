# HANDOFF

## Objective

Obtain and install the missing **Developer ID Application** certificate (and related macOS signing inputs) so this machine can produce a **signed, notarized** production macOS desktop DMG for shuv2code via:

```bash
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --signed
```

This handoff is for a **computer-use / GUI agent** driving Safari/Chrome + Keychain Access + Xcode/Apple Developer portal on the local Mac (owner account already has team access).

## Current status

- **Done:** Dependencies installed; macOS **unsigned** production artifacts built:
  - `release/shuv2code-0.1.0-alpha.1-arm64.dmg`
  - `release/shuv2code-0.1.0-alpha.1-arm64.zip`
- **Done:** Desktop dev app was runnable via `vp run dev:desktop`.
- **Done:** iOS development device build uploaded to Sqim (separate from this task).
- **Blocked:** Signed macOS desktop build. Keychain has **no** `Developer ID Application` identity. Only:
  1. `Apple Distribution: Kevin Crommett (7H54B326YZ)`
  2. `Apple Development: Created via API (FS8S8T7847)`
  3. `Apple Development: Kevin Crommett (Z9ZSRFYPB9)`
- Team ID observed from certs/Xcode: **`7H54B326YZ`** (Kevin Crommett).
- No local `.env` / `.env.local` with signing vars. Repo expects secrets listed in `docs/operations/release.md` (Signing inputs).

## Key context

| Need                                                                           | Why                                                                             | Present?                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Developer ID Application** cert                                              | electron-builder / Gatekeeper distribution outside App Store                    | **No**                                              |
| Notarization API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) | Stapled notarization on DMG/ZIP                                                 | Unknown / not in env                                |
| `SHUV2CODE_APPLE_TEAM_ID=7H54B326YZ`                                           | Passkey-capable signed mac config                                               | Not in env file                                     |
| `SHUV2CODE_MACOS_PROVISIONING_PROFILE`                                         | Associated Domains profile for app id `dev.shuv.shuv2code`                      | **No** macOS profile found (only iOS team profiles) |
| `SHUV2CODE_CLERK_PUBLISHABLE_KEY` or `SHUV2CODE_CLERK_PASSKEY_RP_DOMAINS`      | Required when `--signed` enables passkey entitlements                           | Missing locally                                     |
| Optional `CSC_LINK` + `CSC_KEY_PASSWORD`                                       | CI-style .p12 import; local Keychain identity can substitute if named correctly | Missing                                             |

**Important:** Apple **Development** / **Distribution** (App Store) certs are **not** substitutes for **Developer ID Application**. Do not “force” signing with Development for a shareable DMG.

App identity for desktop: `dev.shuv.shuv2code` (`DESKTOP_APP_ID` in `scripts/build-desktop-artifact.ts`).

## Important files

- `scripts/build-desktop-artifact.ts` — `--signed` path; requires mac passkey signing config when signed.
- `docs/operations/release.md` — canonical secret list and acceptance (signature + notarization stapled).
- `docs/reference/scripts.md` — local `dist:desktop:dmg` / `--signed` notes.
- `.env.example` — documents `SHUV2CODE_APPLE_TEAM_ID`, `SHUV2CODE_MACOS_PROVISIONING_PROFILE`.
- `release/shuv2code-0.1.0-alpha.1-arm64.dmg` — current unsigned prod build (leave in place).

## Next steps (computer-use agent)

Work as the logged-in Mac user. Prefer Apple Developer website + Keychain Access. **Do not commit certs, .p12, API keys, or profiles into git.**

### A. Developer ID Application certificate

1. Open [Apple Developer Certificates](https://developer.apple.com/account/resources/certificates/list) signed in as the account on team **Kevin Crommett / 7H54B326YZ**.
2. Inventory existing certs. If **Developer ID Application** already exists for this team:
   - If the private key is on another machine only, you cannot download a usable identity from the portal alone — need the original `.p12` or CSR machine. Prefer locating an existing exported `.p12` in the owner’s password manager / secure store / CI secrets (`CSC_LINK`) rather than revoking.
3. If none exists (or owner authorizes a new one):
   - Keychain Access → Certificate Assistant → **Request a Certificate From a Certificate Authority** → save CSR to disk (email = owner; Common Name descriptive; “Saved to disk”).
   - Developer portal → Certificates → **+** → **Developer ID Application** → upload CSR → download `.cer`.
   - Double-click `.cer` to install into **login** keychain.
4. Verify:

   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```

   Expect a line containing `Developer ID Application: … (7H54B326YZ)`.

5. Optional export for CI (only if owner asks): Keychain → export identity as `.p12` → base64 for `CSC_LINK`; store password as `CSC_KEY_PASSWORD`. **Never paste secrets into HANDOFF or chat logs.**

### B. Notarization credentials (App Store Connect API key)

1. [App Store Connect → Users and Access → Integrations → Team Key](https://appstoreconnect.apple.com/access/integrations/api) (or existing Developer API key with notary access).
2. Create or locate a key that can notarize. Download the `.p8` **once** if new.
3. Record locally (owner-only path, e.g. `~/.private/shuv2code-signing/`, gitignored):
   - `APPLE_API_KEY` = path to `.p8` **or** file contents per electron-builder convention used in this project’s CI
   - `APPLE_API_KEY_ID`
   - `APPLE_API_ISSUER` (Issuer UUID)
4. Confirm electron-builder env names match `docs/operations/release.md`.

### C. macOS provisioning profile (Associated Domains / passkeys)

Signed builds call `resolveMacPasskeySigningConfiguration()` and need:

- Bundle / app id: `dev.shuv.shuv2code`
- Team: `7H54B326YZ`
- Profile type suitable for **Developer ID** + **Associated Domains** (passkey RP)

Steps:

1. Developer portal → Identifiers → ensure Mac app id `dev.shuv.shuv2code` exists with **Associated Domains** enabled.
2. Profiles → create **Developer ID** provisioning profile for that App ID (or the profile type this app already uses in CI — match GitHub secret `MACOS_PROVISIONING_PROFILE` / env `SHUV2CODE_MACOS_PROVISIONING_PROFILE` if recoverable from CI).
3. Download `.provisionprofile` to a stable path, e.g. `~/.private/shuv2code-signing/shuv2code.provisionprofile`.

### D. Local env (do not commit)

Create **gitignored** repo-root `.env.local` (or export in the shell) with at least:

```bash
SHUV2CODE_APPLE_TEAM_ID=7H54B326YZ
SHUV2CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/shuv2code.provisionprofile
# One of:
# SHUV2CODE_CLERK_PUBLISHABLE_KEY=pk_...
# SHUV2CODE_CLERK_PASSKEY_RP_DOMAINS=clerk.example.com
```

Plus notarization vars from B. If using .p12 instead of Keychain discovery, set `CSC_LINK` / `CSC_KEY_PASSWORD`.

Unlock keychain before long builds if codesign fails with `errSecInternalComponent`:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
```

### E. Rebuild signed DMG

```bash
cd /Volumes/shuvbot-data/repos/shuv2code
export PATH="$PWD/node_modules/.bin:$PATH"
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --signed
```

Validate:

```bash
codesign -dv --verbose=4 release/shuv2code-*.app 2>&1 | head   # if app unpacked
spctl -a -vv -t install release/shuv2code-0.1.0-alpha.1-arm64.dmg
xcrun stapler validate release/shuv2code-0.1.0-alpha.1-arm64.dmg
```

## Risks / open questions

- **Private key locality:** Creating a new Developer ID cert without the CSR machine’s private key orphans the cert. Prefer recovering existing CI `CSC_LINK` over minting duplicates.
- **Account / 2FA:** Portal actions may need owner approval or hardware 2FA; computer-use agent must pause for human challenge, not bypass.
- **Passkey domains:** Without Clerk publishable key or explicit `SHUV2CODE_CLERK_PASSKEY_RP_DOMAINS`, `--signed` fails even with Developer ID installed.
- **CI vs local:** Release publish path uses GitHub secrets; local `.env.local` is only for this machine’s rebuild. Do not write secrets into the repo or this file.
- **Unsigned DMG** remains usable for local smoke tests; Gatekeeper will warn/block on other Macs until Developer ID + notarization succeed.

## Validation

Success criteria for the follow-up agent:

1. `security find-identity -v -p codesigning` lists **Developer ID Application** for team `7H54B326YZ`.
2. Provisioning profile path exists and team/app id match `dev.shuv.shuv2code`.
3. `node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --signed` exits 0.
4. DMG passes `spctl` / stapler validate (notarization stapled).
5. No certs, p12, p8, or profiles committed to git (`git status` clean of secrets).

## Resume prompt

```
You are a computer-use agent on the shuv2code Mac.

Read /Volumes/shuvbot-data/repos/shuv2code/HANDOFF.md and execute sections A–E.

Goal: install Developer ID Application for team 7H54B326YZ, obtain notarization API creds and macOS Associated Domains profile for dev.shuv.shuv2code, write gitignored env, then run:

  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --signed

Do not commit secrets. Pause for any 2FA/owner confirmation. Prefer recovering an existing Developer ID .p12 / CI CSC_LINK over creating a new cert if one already exists on the team.
```
