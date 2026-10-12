# opencode-go-usage (TUI plugin)

**English** | [한국어](README.ko.md)

An [OpenCode](https://opencode.ai) CLI plugin that shows your **OpenCode Go / Go Plus** plan usage in the TUI **sidebar**: remaining usage, meter bars, and the time until each window resets.

```
5H   ▓▓▓▓▓░ 99% · 4h12m   ← 99% left, resets in 4h12m (5-hour window)
일   ▓▓▓▓▓░ 98% · 22h     ← daily (24h rolling)
주간  ▓▓▓▓▓░ 96% · 1d2h   ← weekly (next Monday 00:00)
월간  ▓▓▓▓▓░ 82% · 15d    ← monthly (1st of next month 00:00)
```

- Bars and `%` show **remaining quota**, using the Go rule of thumb (5-hour = 20% of the model's monthly limit, weekly = 50%, monthly = 100%)
- Color by headroom: green (≥40%) / yellow (<40%) / red (≤10%)
- Auto-refreshes every 40 seconds by default (configurable)
- No dollar amounts, no grand total — just percentage, bar, and reset ETA per row

- Labels (`5H`, `일`, `주간`, `월간`) mean the 5-hour, daily, weekly, and monthly windows. Set `"locale": "en"` to switch them to `5H/DAY/WEEK/MONTH`.

## Install (other machines)

**One-liner via git — no cli.json edits, no node_modules:**

```sh
git clone https://github.com/HaYanJongSeong/opencode-go-usage \
  ~/.config/opencode/plugins/opencode-go-usage
```

OpenCode discovers plugins under `<global-config>/plugins/<name>/tui.tsx` automatically, so this path alone is enough.

If you prefer `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    {
      "package": "~/.config/opencode/plugins/opencode-go-usage",
      "options": { "plan": "go" }
    }
  ]
}
```

## npm (planned / manual)

```sh
git clone https://github.com/HaYanJongSeong/opencode-go-usage
cd opencode-go-usage
npm publish
```

## Options

| Option        | Default | Notes                                                |
| ------------- | ------- | ---------------------------------------------------- |
| `plan`        | `"go"`  | `go` or `goplus` — switches the monthly limits table |
| `refreshSec`  | `40`    | Refresh cadence in seconds, minimum 10               |
| `locale`      | `"ko"`  | `"en"` switches row labels (`5H/DAY/WEEK/MONTH`)      |
| `monthlyLimits` | —     | Per-model overrides, e.g. `{ "glm-5.3": 60 }`        |

## When does the widget sync?

| When                        | What happens                                               |
| --------------------------- | ---------------------------------------------------------- |
| TUI start                   | One immediate compute + render                             |
| Every `refreshSec` seconds  | Re-read session/message history, recompute remaining + ETA |
| New usage recorded          | Picked up by the next polling cycle (pull, not push)       |

The widget polls local data — it does not stream from the console server. If you close the terminal, nothing visibly updates until you relaunch the TUI.

## Example screenshot

![Sidebar preview](assets/preview.svg)

## How the numbers are computed (and the catches)

It reads OpenCode's **local server DB**: each assistant message carries a `cost` and a timestamp (from opencode's own price tables), aggregated per model within the last 5h, 24h, 7d, and 30d. Per-model headroom uses the [Go plan monthly dollar limits](https://opencode.ai/v2/docs/console/go) minus your spend, then picks the worst (most-consumed) model per window.

Caveats:

- Sessions made in **other project directories** (separate worktrees/instances) live in their own DB and are missed from this sum
- Reset times are approximations based on window anchors, not the server-issued `resetsAt` value
- Not identical to the Console's official dashboard at [opencode.ai/console](https://opencode.ai/console) → **Usage**

## License

MIT
