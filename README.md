# opencode-go-usage

Read Go and Codex quota limits in OpenCode. The recommended setup is a source-built OpenCode 2.0.22 browser UI with this project's server quota RPC. The original embedded UI has a chat fallback that consumes one model response. The legacy Go TUI sidebar is separate.

[한국어](README.ko.md)

## Browser UI

Submit `/left` or `/사용량` in the normal composer, without arguments. The patched UI reads `go-codex-quota.read` and shows remaining percentages and bars above the composer. It creates no model request or chat message. `/usage` is not registered.

There are no expandable details. An outlined **Close usage** button hides the panel, including during a pending read; either alias opens it again. Reset countdowns appear on the right as total hours and minutes, rather than days. The visible countdown updates every minute without polling the quota API; **Refresh** reads a new snapshot.

For Go's 5h window, `resetsAt: null` means **Starts on first use**, matching the official deployed Console JavaScript. Other null reset times remain unavailable. The browser does not invent reset timestamps.

Missing connections or unsupported authentication show **OpenAI connection required** or **OpenCode Go connection required** for that provider. Quotas from a connected provider stay visible. Timeouts, server errors and rejected credentials remain lookup errors rather than being labelled as missing connections.

### Install the server plugin

Clone this repository, then add its absolute directory path to the V2 server's `opencode.json` or `opencode.jsonc` `plugins` array:

```sh
git clone https://github.com/HaYanJongSeong/opencode-go-usage.git
```

```json
{
  "plugins": ["/absolute/path/opencode-go-usage"]
}
```

Merge this entry with existing plugins. Reload or restart the server through your usual procedure. The default export loads `index.mjs`, which registers both the RPC and the chat commands. `./rpc` exports the RPC contract; loading that contract alone does not install the server handler. `./tui` exports the legacy sidebar, not the browser panel. The package manifest's name is currently `prometheus-side-bar`; these instructions use the local GitHub checkout, not an assumed npm release.

### Build and serve the browser UI

Requires Git and a working Bun installation supported by your platform. Use the pinned upstream commit, not an arbitrary OpenCode release:

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

Keep the original authenticated OpenCode server running on `127.0.0.1:49374` with the RPC plugin loaded. Open the patched UI at `http://127.0.0.1:49375/`. The proxy serves built assets and forwards API/WebSocket traffic to the original server. The original embedded UI remains at `http://127.0.0.1:49374/`.

Use `127.0.0.1`, not `localhost`. Pair through the normal OpenCode flow if authentication is required. The proxy forwards only the original port-specific session cookie, does not create credentials, and checks Host, Origin and Fetch Metadata. It binds to loopback only; do not expose it as a public service. The command runs in the foreground and does not install reboot autostart.

## Quota sources and credentials

The server collector resolves the selected provider's active integration connection, rather than listing credentials or reading a local database. Go and Codex reads run in parallel and fetch fresh data.

- Go Console OAuth/key credentials require metadata identifying `https://opencode.ai/console`. The collector reads `https://opencode.ai/console/api/go/status`, using `access.meters` (`fiveHour`, `week`, `month`) with positive limits.
- A selected legacy `opencode-go` key uses `https://opencode.ai/zen/go/v1/usage`. Console OAuth is never sent to that endpoint.
- Codex uses the active official `openai` OAuth connection and `https://chatgpt.com/backend-api/wham/usage`. Windows come from the response. This is Codex quota, not total ChatGPT consumption; the Pro label appears only when the API returns `pro`.

Failures remain errors, not local estimates. HTTP reads reject redirects, have a 10-second timeout and cap response bodies at 128 KiB. Parsed quota fields and fixed errors reach the UI/tool, not raw responses, tokens or account/organization IDs. Cancellation reaches HTTP reads, but immediate cancellation of credential resolution is not guaranteed. Backend response contracts can change.

## Original embedded UI fallback

Without the browser patch, `/left` and `/사용량` invoke the server chat command. It collects a sanitized Markdown snapshot, then asks the session's current model to echo it. This consumes one model response and may add usage or cost. The displayed values precede that response; exact model echo is not guaranteed. The existing session and delivery mode are retained.

The read-only `usage_status` tool returns a sanitized JSON snapshot without itself requesting a model response. It uses the same collector and no local cost estimate. A model-driven tool invocation is still part of a model conversation.

`/left test` and `/사용량 test` in the unpatched interface run mocked tests without real quota requests or a model response. Results go to the test suite's configured local output file, not chat. The patched browser accepts only the bare aliases, so run tests directly when using it:

```sh
bun -e 'const r = await (await import("./usage.test.mjs")).runTests(); console.log({ passed: r.passed, total: r.total }); if (!r.passed) process.exit(1)'
bun test web-server.test.mjs
bun web-ui-sw.test.mjs ../opencode-source/packages/app/dist/sw.js
```

## Legacy Go TUI sidebar

The unchanged `tui.tsx` implementation shows Go remaining percentages, six-cell bars and reset ETAs. It does not show Codex. It refreshes at startup and every 45 seconds by default, with a 15-second Console-response cache. Colors are green above 40% remaining, yellow above 10% through 40%, and red at 10% or less. Labels default to `5H / 주간 / 월간`; `locale: "en"` uses `5H / WEEK / MONTH`.

Load `tui.tsx` or the package's `./tui` export using a compatible TUI plugin loader. Browser/server plugin registration does not add a TUI sidebar. This older implementation depends on the TUI APIs and peer dependencies listed in `package.json`; automatic discovery across OpenCode versions is not verified here.

| Option | Default | Behavior |
| --- | --- | --- |
| `plan` | `"go"` | `go` or `goplus`; built-in limits for local estimates only |
| `refreshSec` | `45` | Poll interval in seconds, minimum 10 |
| `locale` | `"ko"` | Korean or `"en"` row labels |
| `source` | `"auto"` | Console then local estimate; `"api"` disables estimates; `"local"` skips Console |
| `monthlyLimits` | unset | Per-model overrides for local estimates |

Unlike the V2 collector, this legacy widget can fall back from integration access to credential listing and the local OpenCode database. With `source: "auto"` or `"local"`, it estimates usage from local message costs and built-in plan limits, marking rows with `~`. Its estimated reset times are local heuristics, not API reset times. Use `source: "api"` to avoid those estimates. Built-in limits may be outdated and local records may be incomplete.

## Verification and limits

The publication checks cover 25 collector/RPC tests, 41 proxy tests and 46 UI tests, plus the pinned upstream production build. The generated service worker is exercised with online navigation, offline fallback and API/auth route exclusions. On the deployed Android UI, the user confirmed that the old Details control disappeared and the requested panel changes became visible. Connection guidance is covered by DOM tests; live account connections were not removed for testing.

Document navigation reads current HTML from the server, with a runtime cache fallback when offline. Hashed assets remain precached. When updating an existing deployment, copy assets first, replace `index.html`, then replace `sw.js`; retain older hashed assets for open tabs. The update does not force-reload a tab or clear cookies and conversation storage. An old open tab may need to be closed and reopened after the new worker activates.

Automated Brave/Gboard interaction, a light/dark mobile screenshot matrix and browser-cookie integration tests are not available in this environment. Full upstream typecheck still fails on existing typing issues and missing Storybook dependencies from the filtered install. The changed quota files have no reported diagnostics, and the service-worker configuration passes a separate typecheck. One upstream submission test also fails against the original source. These limits are not presented as passing checks.

## License

MIT. See [LICENSE](LICENSE).
