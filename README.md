# opencode-go-usage

Read Go and Codex quota limits in OpenCode. The recommended setup pairs a source-built OpenCode 2.0.22 browser UI with this project's server quota RPC. You can also use the original embedded UI, but its chat fallback consumes one model response. The legacy Go TUI sidebar is a separate component.

[한국어](README.ko.md)

## Termux shell commands

With Python 3.14 available and the [server plugin](#install-the-server-plugin) already loaded, run this from the checkout:

```sh
bash scripts/install-left.sh
```

The installer adds three names for the same program:

| Termux or OpenCode shell mode | OpenCode normal input |
| --- | --- |
| `left` | `!left` |
| `Left` | `!Left` |
| `사용량` | `!사용량` |

In OpenCode, `!` enters shell mode from an empty normal composer. If the composer is already in shell mode, enter only the command name, without another `!`.

Each run reads fresh Go and Codex quotas through `go-codex-quota.read` and prints remaining percentages and reset times in Korean. It does not call a model or add a chat message. The existing `/left` and `/사용량` slash commands are separate and unchanged. No browser patch is needed for the shell commands.

The command also replaces `~/left-snapshot.md` with permissions `0600`. A failed read or cancellation removes the old figures from that snapshot. Attaching the file does not refresh it; run the command again for a new reading. Codex figures are Codex quota, not total ChatGPT usage.

The installed names link to `scripts/left.py` in this checkout. Keep the checkout at the same path. On reinstall, the installer leaves matching links alone and refuses to overwrite another file, link or directory with the same name. See [the shell guide](scripts/left.md) for the local connection checks and settings-restore command.

```sh
python -m unittest discover -s scripts/tests -p 'test_left*.py' -v
```

## Browser UI

Submit `/left` or `/사용량` in the normal composer with no arguments. The patched UI reads `go-codex-quota.read` and shows remaining percentages and bars above the composer without creating a model request or chat message. `/usage` is not registered.

Use the outlined "Close usage" button to hide the panel, even while a read is pending. Either alias opens it again. The panel has no expandable details.

Reset countdowns appear on the right. Below 24 hours, they show hours and minutes; from 24 hours onward, they show days and remaining hours, such as `2D 3H`. The visible countdown updates every minute without polling the quota API. "Refresh" reads a new snapshot.

When Go's 5h window has `resetsAt: null`, the panel shows "Starts on first use", as in the official deployed Console JavaScript. Other null reset times remain unavailable. The browser does not invent reset timestamps.

The panel shows "OpenAI connection required" or "OpenCode Go connection required" when that provider has no connection or uses unsupported authentication. Quotas from a connected provider stay visible. Timeouts, server errors and rejected credentials remain lookup errors, not missing-connection messages.

### Install the server plugin

Clone this repository, then add its absolute path to the V2 server's `opencode.json` or `opencode.jsonc` as an entry in the `plugins` array:

```sh
git clone https://github.com/HaYanJongSeong/opencode-go-usage.git
```

```json
{
  "plugins": ["/absolute/path/opencode-go-usage"]
}
```

Add this entry alongside your existing plugins, then reload or restart the server as you normally would. The default export loads `index.mjs` and registers both the RPC and the chat commands.

`./rpc` exports the RPC contract, but loading that contract alone does not install the server handler. `./tui` exports the legacy sidebar, not the browser panel. The package manifest currently uses the name `prometheus-side-bar`; these instructions use a local GitHub checkout rather than assuming an npm release.

### Build and serve the browser UI

You need Git and a working Bun installation supported on your platform. Use the pinned upstream commit below rather than an arbitrary OpenCode release:

```sh
git clone https://github.com/anomalyco/opencode.git opencode-source
cd opencode-source
git checkout 527f0b931d1f9b3ebd34e106c51b31ce5db5b075
git apply --check ../opencode-go-usage/web-ui-v2.0.22.patch
git apply ../opencode-go-usage/web-ui-v2.0.22.patch
bun install --frozen-lockfile --ignore-scripts --filter '@opencode/app'
OPENCODE_CHANNEL=latest VITE_OPENCODE_SERVER_MODE=origin bun --bun run --cwd packages/app build
cd ../opencode-go-usage
bun web-server.mjs ../opencode-source/packages/app/dist
```

Keep the original authenticated OpenCode server running on `127.0.0.1:49374` with the RPC plugin loaded. Open the patched UI at `http://127.0.0.1:49375/`. The proxy serves the built assets and forwards API/WebSocket traffic to the original server. The original embedded UI remains at `http://127.0.0.1:49374/`.

Use `127.0.0.1`, not `localhost`. If authentication is required, pair through the normal OpenCode flow. The proxy forwards only the original port-specific session cookie and does not create credentials. It checks Host, Origin and Fetch Metadata and binds only to loopback. Do not expose it as a public service.

The command runs in the foreground and does not set up reboot autostart.

## Quota sources and credentials

The server collector looks up the selected provider's active integration connection without listing credentials or reading a local database. Go and Codex reads run in parallel and fetch fresh data.

- Go Console OAuth/key credentials need metadata identifying `https://opencode.ai/console`. The collector reads `https://opencode.ai/console/api/go/status` and uses `access.meters` (`fiveHour`, `week`, `month`) with positive limits.
- A selected legacy `opencode-go` key uses `https://opencode.ai/zen/go/v1/usage`. Console OAuth is never sent to that endpoint.
- Codex uses the active official `openai` OAuth connection to read `https://chatgpt.com/backend-api/wham/usage`. Its quota windows come from the response. These values are Codex quota, not total ChatGPT consumption. The Pro label appears only when the API returns `pro`.

Failed reads return errors, not local estimates. HTTP reads reject redirects, time out after 10 seconds and cap response bodies at 128 KiB. The collector sends only parsed quota fields and fixed errors to the UI/tool, not raw responses, tokens or account/organization IDs.

Cancellation reaches HTTP reads, but the credential lookup may not stop immediately. The backend APIs may change their responses.

## Original embedded UI fallback

Without the browser patch, `/left` and `/사용량` run the server chat command. It collects a sanitized Markdown snapshot and asks the session's current model to echo it. This consumes one model response and may add usage or cost. The snapshot reflects quota before that response, and the model may not echo it exactly. The existing session and delivery mode stay the same.

The read-only `usage_status` tool returns a sanitized JSON snapshot without requesting a model response itself. It uses the same collector and does not make a local cost estimate. If a model invokes the tool, that invocation is still part of a model conversation.

In the unpatched interface, `/left test` and `/사용량 test` run mocked tests without real quota requests or a model response. The test suite writes results to its configured local output file rather than chat. The patched browser accepts only the bare aliases, so run the tests directly when using it:

```sh
bun -e 'const r = await (await import("./usage.test.mjs")).runTests(); console.log({ passed: r.passed, total: r.total }); if (!r.passed) process.exit(1)'
bun test web-server.test.mjs
bun web-ui-sw.test.mjs ../opencode-source/packages/app/dist/sw.js
```

## Legacy Go TUI sidebar

`tui.tsx` is unchanged. It shows Go remaining percentages, six-cell bars and reset ETAs, but no Codex quota. By default, it refreshes at startup and every 45 seconds, with a 15-second cache for Console responses.

Colors are green above 40% remaining, yellow above 10% through 40%, and red at 10% or less. Labels default to `5H / 주간 / 월간`; `locale: "en"` uses `5H / WEEK / MONTH`.

Load `tui.tsx` or the package's `./tui` export with a compatible TUI plugin loader. Registering the browser/server plugin does not add a TUI sidebar. This older implementation depends on the TUI APIs and peer dependencies in `package.json`. Automatic discovery across OpenCode versions has not been verified here.

| Option | Default | Behavior |
| --- | --- | --- |
| `plan` | `"go"` | `go` or `goplus`; built-in limits for local estimates only |
| `refreshSec` | `45` | Poll interval in seconds, minimum 10 |
| `locale` | `"ko"` | Korean or `"en"` row labels |
| `source` | `"auto"` | Console then local estimate; `"api"` disables estimates; `"local"` skips Console |
| `monthlyLimits` | unset | Per-model overrides for local estimates |

Unlike the V2 collector, the legacy widget can fall back from integration access to listing credentials and reading the local OpenCode database. With `source: "auto"` or `"local"`, it estimates usage from local message costs and built-in plan limits and marks the rows with `~`. Estimated reset times are local heuristics, not API reset times.

Use `source: "api"` to avoid estimates. The built-in limits may be outdated, and local records may be incomplete.

## Verification and limits

The publication checks include 25 collector/RPC tests, 41 proxy tests and 46 UI tests, plus a production build of the pinned upstream commit. Tests of the generated service worker cover online navigation, offline fallback and API/auth route exclusions.

On the deployed Android UI, the user confirmed that the old Details control was gone and the requested panel changes were visible. DOM tests cover the connection guidance; live account connections were not removed for testing.

Document navigation reads current HTML from the server and falls back to the runtime cache when offline. Hashed assets remain precached.

When updating an existing deployment, copy assets first, replace `index.html`, then replace `sw.js`. Keep older hashed assets for open tabs. The update does not force-reload a tab or clear cookies or conversation storage. After the new worker activates, you may need to close and reopen a tab that was already open.

Automated Brave/Gboard interaction, a light/dark mobile screenshot matrix and browser-cookie integration tests are unavailable in this environment. Full upstream typecheck still fails because of existing typing issues and missing Storybook dependencies from the filtered install.

The changed quota files have no reported diagnostics, and the service-worker configuration passes a separate typecheck. One upstream submission test also fails against the original source. The unavailable checks and failures are not reported as passes.

## License

MIT. See [LICENSE](LICENSE).
