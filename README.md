# ScheduledStatus for Vencord

Changes your Discord status automatically after a number of minutes: **Online**, **Idle**, **Do Not Disturb** or **Invisible** (appear offline). For example, "go Invisible in 30 minutes" or "go Online in 10 minutes".

## The clock button

A clock button sits in the account panel at the bottom left of Discord, just before the mic. Click it to open a small panel:

1. Pick the status (Online, Idle, Do Not Disturb, Invisible).
2. Type the number of minutes, or click a shortcut (5 min, 10 min, 15 min, 30 min, 1 h, 2 h).
3. Click **Schedule** (or press Enter). The button shows the exact time it will happen.

While a status is waiting:

| Where | What you see |
| :-- | :-- |
| Clock button | Takes the color of the status that's coming (green, yellow, red or grey) |
| Hovering the button | The status, the time left and the time it happens, e.g. "Invisible in 13 min (11:45 PM)" |
| Panel | A countdown to the second, and a **Cancel** link |

Scheduling a new status replaces the one waiting: only one status can wait at a time.

When the time comes, your status changes exactly as if you had picked it under your avatar, and a notification tells you.

## Commands

They work in any chat, and only you see the answers.

| Command | What it does |
| :-- | :-- |
| `/statusin status minutes` | Schedules a status, e.g. `/statusin Invisible 45` |
| `/statuscancel` | Cancels the status waiting |

## Settings

In Settings > Vencord > Plugins > ScheduledStatus:

| Setting | Default | What it does |
| :-- | :-- | :-- |
| Show Button | On | Shows the clock button. Turn it off if you only use the commands. |
| Notify | On | Shows a notification when the status is applied. |
| When Missed | Apply | If Discord was closed when the time came: apply the status when Discord opens again (only if that's less than 12 hours later), or forget it. |

The scheduled status is saved, so it survives a restart of Discord. While Discord is closed, nothing can change your status (the plugin only runs inside Discord), so the **When Missed** setting decides what happens when you open it again.

## Installation

This is a user plugin, so it needs Vencord [built from source](https://docs.vencord.dev/installing/).

1. Clone this repo into Vencord's `src/userplugins` folder:

   ```bash
   cd Vencord/src/userplugins
   git clone https://github.com/TheUnknownMurda/ScheduledStatus-Vencord scheduledStatus
   ```

2. Build Vencord from the Vencord folder:

   ```bash
   pnpm build
   ```

3. If Discord doesn't load Vencord from this folder yet, inject it:

   ```bash
   pnpm inject
   ```

4. Fully quit Discord (from the system tray) and start it again.
5. Turn on **ScheduledStatus** in Settings > Vencord > Plugins, and restart Discord when it asks.

### Updating

```bash
cd Vencord/src/userplugins/scheduledStatus
git pull
```

Then run `pnpm build` again and restart Discord.

## How it works

- The status is changed through Vencord's user settings API, with the same setting Discord's status menu uses. If the scheduled status is already yours when the time comes, nothing is sent to Discord.
- Nothing runs while no status is scheduled. While one is waiting, the plugin looks at the clock at least every 30 seconds instead of trusting one long timer, so it's still on time after your PC wakes from sleep.
- The clock button only redraws when the minute it shows changes (every second during the last minute).
- The clock button is added with a patch on Discord's account panel, at the same place as GameActivityToggle and SpotifyActivityToggle, and works next to both. If a Discord update changes that panel, the button may disappear until the patch is updated. The `/statusin` and `/statuscancel` commands don't depend on it and keep working.

## License

GPL-3.0-or-later, like Vencord. See [LICENSE](LICENSE).
