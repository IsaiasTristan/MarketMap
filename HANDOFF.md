# Cloudflare Tunnel Handoff — MarketMap

> **For:** the next AI agent (or human) picking up this work.
> **Written:** 2026-04-28, partway through setup.
> **Repo:** `C:\Users\isaia\Desktop\MarketMap` (git: `master`, GitHub: `IsaiasTristan/MarketMap`).
> **Out of scope of this doc:** the recent Prisma schema simplification and POST-positions error handling fix. Both are committed and pushed (`6bb1328`). The DB has been migrated. The dev app at `localhost:3000` is functional.

---

## 1. Goal

Expose the **Next.js dev server running on the user's home PC at `http://localhost:3000`** to the internet at `https://dev.itmarketmap.com`, so the user can reach it from a separate work computer. Access must be **locked down via Cloudflare Access** (email one-time-PIN, allow-list `isaiastristan@live.com`).

The user's editing workflow on the work computer is **git pull / git push** — they have *not* asked for remote-editing tooling like VS Code Tunnels.

---

## 2. Configuration values (the truth)

| Key | Value |
|---|---|
| Cloudflare account email | `Isaiastristan@live.com` |
| Domain (already on Cloudflare DNS) | `itmarketmap.com` |
| Tunnel hostname | `dev.itmarketmap.com` |
| Tunnel name | `marketmap-dev` |
| **Tunnel ID** | `1320628f-8a1e-47d6-b510-c2e6d0c98a48` |
| Local service to forward | `http://localhost:3000` |
| Access allow-list email | `isaiastristan@live.com` |
| `cloudflared` install path | `C:\Program Files (x86)\cloudflared\cloudflared.exe` |
| User's cloudflared config dir | `C:\Users\isaia\.cloudflared\` |
| Files in that dir | `config.yml`, `cert.pem`, `1320628f-8a1e-47d6-b510-c2e6d0c98a48.json` |
| Cloudflare nameservers (verified) | `darl.ns.cloudflare.com`, `davina.ns.cloudflare.com` |
| Cloudflared version installed | `2025.8.1` (newer 2026.3.0 exists, not blocking) |

`config.yml` content (already on disk):

```yaml
tunnel: 1320628f-8a1e-47d6-b510-c2e6d0c98a48
credentials-file: C:\Users\isaia\.cloudflared\1320628f-8a1e-47d6-b510-c2e6d0c98a48.json

ingress:
  - hostname: dev.itmarketmap.com
    service: http://localhost:3000
  - service: http_status:404
```

---

## 3. What's been done ✅

1. **`cloudflared` installed** via `winget install --id Cloudflare.cloudflared` — at `C:\Program Files (x86)\cloudflared\cloudflared.exe`. Note: PATH not refreshed in current shells; use the full path until a new terminal is opened.
2. **Authenticated** via `cloudflared tunnel login` → `cert.pem` written to `C:\Users\isaia\.cloudflared\cert.pem`.
3. **Tunnel created**: `cloudflared tunnel create marketmap-dev` → tunnel ID above, credentials JSON in same dir.
4. **`config.yml` written** (see section 2).
5. **DNS routed**: `cloudflared tunnel route dns marketmap-dev dev.itmarketmap.com` → CNAME exists in Cloudflare.
6. **Smoke test passed** by manually running `cloudflared tunnel run marketmap-dev` — `curl -L https://dev.itmarketmap.com` returned **HTTP 200** and Next.js redirected `/` → `/market-map`. **Tunnel works end-to-end.**

---

## 4. What's broken 🟠

**The Windows service install is in a half-state.** Specifically:

- `Get-Service Cloudflared` exists but `START_TYPE` is `4 DISABLED`.
- `STATE` is `STOP_PENDING`.
- `BINARY_PATH_NAME` is `"C:\Program Files (x86)\cloudflared\cloudflared.exe"` — it does **not** include the `--config` argument.

**Root cause:** the Windows service runs as `LocalSystem`, whose home is `C:\Windows\System32\config\systemprofile\`, *not* `C:\Users\isaia\`. So when the service launches cloudflared without `--config`, cloudflared looks in `C:\Windows\System32\config\systemprofile\.cloudflared\config.yml` and finds nothing → returns HTTP 530 to Cloudflare's edge.

Two attempts were made to fix this and **both were interrupted**:

- **Attempt A:** elevated PowerShell that copies `config.yml` + creds JSON + `cert.pem` into the LocalSystem profile, then restarts the service. The window completed with exit code 0 but a follow-up curl still returned 530 — *unclear if the copy actually landed* (the dir is admin-only and unreadable from the non-elevated shell, so verification was inconclusive).
- **Attempt B:** elevated PowerShell that uninstalls the service, reinstalls with `--config "C:\Users\isaia\.cloudflared\config.yml" service install`, then `Start-Service`. The user accidentally closed the window before it finished; this likely left the service half-uninstalled (matches the disabled/stop-pending state we observe).

A third attempt was queued (combining both fixes in a hidden window) but was **rejected by the user** to pause and ask whether to stop or continue.

---

## 5. What's left ⏳

In **strict order** for security:

### Step A — Configure Cloudflare Access (do this *before* fixing the service)

The DNS record is live and points at the tunnel. As soon as the tunnel is up, anyone who guesses the URL can reach the dev app *unless* Access is in front. Do Access first; tunnel-fix second.

1. Go to **https://one.dash.cloudflare.com/** → pick the right account.
2. Sidebar: **Access** → **Applications** → **Add an application** → **Self-hosted**.
3. Configure:
   - **Application name:** `MarketMap Dev`
   - **Session duration:** `24 hours` (or preference)
   - **Application domain:** subdomain `dev`, domain `itmarketmap.com` (full: `dev.itmarketmap.com`)
   - **Identity providers:** enable **One-time PIN** at minimum (no Google/etc. needed unless preferred)
   - Click **Next**.
4. Add an Access policy:
   - **Policy name:** `Allow Isaias`
   - **Action:** `Allow`
   - **Configure rules → Include:** Selector `Emails`, value `isaiastristan@live.com`.
   - Click **Next** → **Add application**.
5. Verify by hitting `https://dev.itmarketmap.com` from any browser. You should see a Cloudflare-branded login that asks for an email and emails a 6-digit PIN.

(If the tunnel is still down at this point, you'll get the Access page → email PIN → and *then* a 530. Access works regardless of whether origin is up.)

### Step B — Fix the Windows service

Pick **one** of these two approaches. Both need an elevated (Run-as-Administrator) PowerShell.

**Approach 1: copy config to LocalSystem profile (recommended — minimal service config).**

```powershell
# In elevated PowerShell:
Stop-Service Cloudflared -Force -ErrorAction SilentlyContinue
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service uninstall

$dest = "C:\Windows\System32\config\systemprofile\.cloudflared"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "C:\Users\isaia\.cloudflared\config.yml" "$dest\config.yml" -Force
Copy-Item "C:\Users\isaia\.cloudflared\1320628f-8a1e-47d6-b510-c2e6d0c98a48.json" "$dest\" -Force
Copy-Item "C:\Users\isaia\.cloudflared\cert.pem" "$dest\cert.pem" -Force

& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install
Set-Service -Name Cloudflared -StartupType Automatic
Start-Service Cloudflared
Get-Service Cloudflared
```

**Approach 2: install service with explicit `--config` flag.**

```powershell
# In elevated PowerShell:
Stop-Service Cloudflared -Force -ErrorAction SilentlyContinue
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service uninstall
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" --config "C:\Users\isaia\.cloudflared\config.yml" service install
Set-Service -Name Cloudflared -StartupType Automatic
Start-Service Cloudflared
Get-Service Cloudflared
sc.exe qc Cloudflared   # verify BINARY_PATH_NAME contains --config
```

After either approach, verify:

```powershell
# From any shell, with next dev running on :3000:
curl -L https://dev.itmarketmap.com
```

Expected: HTTP 200 (or Cloudflare Access login page if you already did Step A and aren't logged in).

### Step C — Add `allowedDevOrigins` to Next.js config

Next.js 15.5 will warn (and may eventually block dev assets) when the dev server is reached via a non-localhost origin. Edit `next.config.ts` (or `next.config.js`) at the project root:

```ts
const nextConfig: NextConfig = {
  // ...existing options
  allowedDevOrigins: ["dev.itmarketmap.com"],
};
```

Then restart `next dev`. This eliminates the "Cross-origin request detected" warning and ensures HMR works over the tunnel. Not strictly required for pages to render, but should be done.

---

## 6. Three paths (the user paused here — they wanted to choose)

The user explicitly asked the previous agent to be **neutral** about which path to take. Present these three options and let them pick:

### Path 1 — Stop and leave it
Service is dead, URL returns 530, no exposure. Resume any time. Lowest effort, no progress lost. Just close out.

### Path 2 — Roll back fully (zero trace)

```powershell
# Elevated:
Stop-Service Cloudflared -Force -ErrorAction SilentlyContinue
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service uninstall
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel delete marketmap-dev
# Then in Cloudflare dashboard → DNS → delete the dev.itmarketmap.com CNAME.
winget uninstall Cloudflare.cloudflared
Remove-Item -Recurse -Force "C:\Users\isaia\.cloudflared"
```

After this, nothing remains.

### Path 3 — Continue (Step A → Step B → Step C in section 5)

5–10 minutes if nothing weird happens. Recommended order is **Access first, then service** to avoid an exposure window.

---

## 7. Important context the next agent should know

- **Home PC must stay on and not sleep** for the tunnel to be reachable from work. May want to set "never sleep" on AC power.
- **`next dev` must be running** on `localhost:3000`. The tunnel only forwards traffic; it doesn't start the app.
- **Postgres is local** to the home PC — that's fine, the app talks to it locally and renders results to the work browser.
- **The user closed an elevated PowerShell window early during the previous service-install attempt.** If you spawn an elevated process via `Start-Process -Verb RunAs`, do **not** use `Read-Host` or `-NoExit` — the user thought the work was incomplete and closed the window manually. Use `-WindowStyle Hidden` and write any verification output to a file the unelevated shell can read (e.g. `C:\Users\isaia\.cloudflared\service-install.log`).
- **The deferred-tools harness:** `TaskCreate`, `TaskUpdate`, `TaskStop`, etc. are deferred tools that need `ToolSearch` to load. The previous agent had a task list of 9 items; only #7 (service install) and #8 (`allowedDevOrigins`) and #9 (Access policy) remain.
- **Subagent / web fetch:** the previous agent did not need either; everything was local file edits and shell commands.

---

## 8. Useful one-liners for diagnosing state

```powershell
# Service status (Bash or PS):
sc.exe queryex Cloudflared
sc.exe qc Cloudflared

# Files in user's cloudflared dir:
ls C:\Users\isaia\.cloudflared\

# Check if next dev is up:
curl -s -o NUL -w "HTTP %{http_code}`n" http://localhost:3000

# Check tunnel from outside:
curl -L https://dev.itmarketmap.com

# Tail cloudflared service logs (if any):
Get-EventLog -LogName Application -Source Cloudflared -Newest 30 -ErrorAction SilentlyContinue
```

---

## 9. Open question to ask the user first

Before doing anything, ask:

> "I've read the handoff. Three options: stop here (Path 1), roll back fully (Path 2), or continue and finish setup (Path 3, ~10 min). The user paused at this exact decision. Which do you want?"

If they say continue: **do Step A first, then Step B, then Step C.** Do not skip the order — Step A locks the URL down before Step B brings it online.
