# qwen-discord-channel

A [Qwen Code](https://github.com/QwenLM/qwen-code) **channel plugin** that lets you drive the
agent from Discord — DMs and guild channels — instead of the terminal. It implements the
official channel-plugin contract (`@qwen-code/channel-base`), so it plugs into the same shared
pipeline as Qwen Code's built-in channels (Telegram, DingTalk, Feishu, …): sender gating,
pairing, session routing, slash commands, permission relay, and crash recovery come for free.

Send a message from your phone; the agent works in your repo and answers in the chat. Tool
approval requests are relayed into Discord, so you can approve or deny agent actions from
anywhere.

## Features

- **DMs and guild channels** — DMs are open (per your policy); in guilds the bot answers only
  when @mentioned or replied to.
- **Access control** — `pairing` (unknown senders get a one-time code you approve via CLI),
  `allowlist`, or `open` (not recommended).
- **Sessions** — one agent session per Discord user by default (`user` scope); `thread` and
  `single` scopes also work.
- **Media** — images are passed to the model as vision input (with a multimodal `model`);
  files/attachments are downloaded and handed to the agent as file paths.
- **Working indicators** — Discord typing indicator while the agent thinks.
- **Slash commands** — `/help`, `/status`, `/clear`, `/cancel`, `/loop …` out of the box.
  These are plain-text commands parsed by the channel pipeline, *not* Discord native
  application commands — you type them as ordinary messages, and the `applications.commands`
  OAuth scope is not required.
- **Permission relay** — when the agent needs tool approval, the request lands in the chat and
  you answer it there.

## Requirements

- Qwen Code CLI **≥ 0.22** (`qwen --version`). The plugin pins `@qwen-code/channel-base` to the
  0.22.x contract; see [Compatibility](#compatibility) if you run a different CLI version.
- A Discord application with a bot (free).
- Node ≥ 20 only if you build from source — the repo ships a compiled `dist/`, so plain
  installs need no toolchain.

## Install

```bash
qwen extensions install https://github.com/drscript/qwen-discord-channel
```

Or clone and link for development:

```bash
git clone https://github.com/drscript/qwen-discord-channel
cd qwen-discord-channel
npm install --ignore-scripts && npm run build
qwen extensions link .
```

Restart Qwen Code if the extension isn't visible yet (`qwen extensions list` should show
*Qwen Discord Channel*).

## Discord app setup (one-time)

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** → **Add Bot**.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. **Reset Token** → copy it. Keep it secret; expose it to the CLI as an environment variable:

   ```bash
   export DISCORD_BOT_TOKEN="..."
   ```

5. **OAuth2 → URL Generator**: scope `bot`; permissions **View Channels**, **Send Messages**,
   **Read Message History**. Open the generated URL and invite the bot to a (private) server.
   The `applications.commands` scope is not needed — the slash commands in this doc are
   plain-text messages, not native application commands.

## Configuration

Add a channel entry to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "discord": {
      "type": "discord",
      "token": "$DISCORD_BOT_TOKEN",
      "senderPolicy": "pairing",
      "sessionScope": "user",
      "cwd": "/path/to/working/directory",
      "groupPolicy": "open",
      "dmPolicy": "open",
      "groups": { "*": { "requireMention": true } }
    }
  }
}
```

| Option         | Default      | Meaning                                                            |
| -------------- | ------------ | ------------------------------------------------------------------ |
| `type`         | —            | Must be `discord` (the type this extension registers).             |
| `token`        | required     | Bot token; `$ENV_VAR` syntax supported (never inline the secret).  |
| `senderPolicy` | `allowlist`  | `pairing` recommended for personal bots; `open` is dangerous.      |
| `allowedUsers` | `[]`         | Numeric Discord user IDs (for `allowlist`).                        |
| `sessionScope` | `user`       | `user`, `thread`, or `single`.                                     |
| `cwd`          | current dir  | Working directory the agent runs in.                               |
| `model`        | default      | Set a multimodal model to let the bot *see* images.                |
| `groupPolicy`  | `disabled`   | `disabled` = DMs only; `allowlist`/`pairing`/`open` enable guilds. |
| `dmPolicy`     | `open`       | `open` or `disabled` (group-only bots).                            |
| `groups`       | `{}`         | Per-guild settings; `"*"` sets defaults, e.g. `requireMention`.    |
| `instructions` | —            | Prepended to the first message of each session.                    |

Full option reference (dispatch modes, block streaming, webhooks, …): the *Channels* page of
the Qwen Code docs bundled with your CLI.

## Run

```bash
qwen channel start discord        # this channel only
qwen channel start                # all configured channels
qwen channel status               # check it's up
qwen channel stop                 # shut down
```

First contact: DM the bot (invite it to a server first, then click its profile → **Message**)
or @mention it in a guild channel. With `senderPolicy: "pairing"` the bot replies with an
8-character code; approve it once from a terminal in the channel's workspace:

```bash
qwen channel pairing approve discord <CODE>
```

Everything after that goes straight to the agent.

## Watching the agent work

- **Typing indicator** — Discord shows the bot typing while a prompt is running.
- **Tool activity lines** — each tool call posts one short line as it starts
  (`🔧 shell: npm test`), plus a `❌` line if a tool fails.
- **Block streaming** — with `"blockStreaming": "on"` in the channel config, the response
  arrives as several shorter messages while the agent works, instead of one big reply at the
  end. Tune with `blockStreamingChunk` / `blockStreamingCoalesce`.
- **Permission relay** — when a tool needs approval, the request (with approve/deny options)
  lands in the chat, so you also see *what* the agent is about to do.
- **`/status`** — shows the session's current state; `/help` lists everything available.
- **Service logs** — the terminal running `qwen channel start` logs gateway and pipeline
  activity, including preflight rejections (e.g. `reason=group_disabled`).

## Security notes

- The agent executes real tools on your machine — treat the bot like a remote shell.
  **Never** use `senderPolicy: "open"` on a bot anyone else can reach, and keep guilds on
  `requireMention` + a tight `groupPolicy`.
- Keep the token in an environment variable; `$DISCORD_BOT_TOKEN` in settings.json is a
  reference, not a copy.
- Pairing approvals persist per workspace in
  `~/.qwen/channels/<workspace-scope>/<name>-allowlist.json` — treat that file as sensitive.

## Development

```bash
npm install --ignore-scripts
npm run build          # tsc → dist/
qwen extensions link . # live-reload your local copy
```

The manifest `channels.discord.entry` points at `dist/index.js` (committed so installs need no
build). The entry exports a `plugin` object (`channelType: "discord"`) whose adapter extends
`ChannelBase` from `@qwen-code/channel-base`: `connect()` logs the discord.js client in and
maps `messageCreate` events to inbound *envelopes*; `sendMessage()` posts chunked (2000-char)
messages via the Discord REST API.

## Compatibility

`@qwen-code/channel-base` is pinned to the CLI version the plugin was built against (0.22.2).
If your `qwen --version` differs, bump the dependency to the matching version and rebuild —
the contract is stable within a minor line but not guaranteed across majors.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with the Qwen Code project, Alibaba, or Discord.
