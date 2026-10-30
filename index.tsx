/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Popout, useEffect, useRef, useState } from "@webpack/common";

import managedStyle from "./style.css?managed";

const logger = new Logger("ScheduledStatus");

// No toasts on purpose: Discord changed how its toast function is called (Vencord 2026-10-14),
// so the countdown in the button and panel, and notifications, give the feedback instead

type Status = "online" | "idle" | "dnd" | "invisible";

interface Schedule {
    status: Status;
    /** When the status is applied (Date.now() milliseconds) */
    at: number;
}

const PRESETS = [5, 10, 15, 30, 60, 120];
const MAX_MINUTES = 7 * 24 * 60;
const DATASTORE_KEY = "ScheduledStatus_schedule";
/** Longest wait between two looks at the clock: a long timer can run late after the PC sleeps */
const MAX_WAIT = 30_000;
/** A status missed while Discord was closed is only applied if its time passed less than this long ago */
const MAX_MISSED = 12 * 60 * 60_000;

// The same setting Discord changes when you pick a status under your avatar
const StatusSetting = getUserSettingLazy<string>("status", "status")!;
// Discord's button for the mic / headset row (the one GameActivityToggle uses)
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const settings = definePluginSettings({
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Show the clock button next to the mic and headset buttons (the /statusin command works either way)",
        default: true
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a notification when the scheduled status is applied",
        default: true
    },
    whenMissed: {
        type: OptionType.SELECT,
        description: "If Discord was closed when the time came",
        options: [
            { label: "Apply the status when Discord opens again (if it was less than 12 hours ago)", value: "apply", default: true },
            { label: "Forget it", value: "forget" }
        ]
    }
});

/* ---------- Statuses and icons ---------- */

function ClockIcon({ color = "currentColor" }: { color?: string; }) {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24">
            <path
                fill={color}
                d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-1 3a1 1 0 0 1 2 0v4.59l2.7 2.7a1 1 0 0 1-1.4 1.42l-3-3A1 1 0 0 1 11 12V7Z"
            />
        </svg>
    );
}

// Each icon is made once: a new one on every redraw would make React rebuild the button's icon each time
const PlainClockIcon = () => <ClockIcon />;

function makeStatus(value: Status, label: string, color: string) {
    return { value, label, color, Icon: () => <ClockIcon color={color} /> };
}

const STATUSES = [
    makeStatus("online", "Online", "var(--status-positive, #23a55a)"),
    makeStatus("idle", "Idle", "var(--status-warning, #f0b232)"),
    makeStatus("dnd", "Do Not Disturb", "var(--status-danger, #f23f43)"),
    makeStatus("invisible", "Invisible (appear offline)", "#80848e"),
];

const statusInfo = (status: Status) => STATUSES.find(s => s.value === status)!;
const isStatus = (value: unknown): value is Status => STATUSES.some(s => s.value === value);

/* ---------- Time formatting ---------- */

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const formatTime = (at: number) => timeFormat.format(at);
const pad = (n: number) => String(n).padStart(2, "0");

/** Time left, e.g. "45 s", "12 min 30 s" (with seconds) or "13 min", "1 h 05 min" */
function formatRemaining(ms: number, withSeconds: boolean) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    if (withSeconds && seconds < 3600) return `${Math.floor(seconds / 60)} min ${pad(seconds % 60)} s`;
    const minutes = Math.ceil(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

/* ---------- Schedule ---------- */

let schedule: Schedule | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach(l => l());
}

function save() {
    (schedule ? DataStore.set(DATASTORE_KEY, schedule) : DataStore.del(DATASTORE_KEY))
        .catch(e => logger.error("Could not save the schedule", e));
}

/**
 * Waits for the time of the scheduled status. No timer runs while nothing is scheduled.
 * While waiting, it looks at the clock again at least every 30 seconds instead of trusting
 * one long timer, so it stays on time after the PC wakes from sleep.
 */
function arm() {
    clearTimeout(timer);
    timer = undefined;
    if (!running || !schedule) return;

    const left = schedule.at - Date.now();
    if (left <= 0) void applySchedule();
    else timer = setTimeout(arm, Math.min(left, MAX_WAIT));
}

function setSchedule(status: Status, minutes: number) {
    schedule = { status, at: Date.now() + minutes * 60_000 };
    save();
    arm();
    emit();
    logger.info(`${status} scheduled at ${new Date(schedule.at).toLocaleString()}`);
}

function cancelSchedule() {
    if (!schedule) return;
    schedule = null;
    save();
    arm();
    emit();
}

async function applySchedule(late = false) {
    if (!schedule) return;
    const { status } = schedule;
    schedule = null;
    save();
    emit();

    try {
        // Nothing to send to Discord if that's already your status
        if (StatusSetting.getSetting() !== status)
            await StatusSetting.updateSetting(status);
    } catch (e) {
        logger.error("Could not change the status", e);
        showNotification({ title: "Scheduled status", body: "Could not change your status.", noPersist: true });
        return;
    }

    logger.info(`Status changed to ${status}${late ? " (missed while Discord was closed)" : ""}`);
    if (settings.store.notify) {
        showNotification({
            title: "Scheduled status",
            body: late
                ? `Your status is now ${statusInfo(status).label} (the time passed while Discord was closed).`
                : `Your status is now ${statusInfo(status).label}.`,
            noPersist: true
        });
    }
}

/**
 * Returns the waiting status, and redraws the component when it changes or when the countdown it
 * shows changes: every second with seconds shown, otherwise once a minute until the last minute.
 */
function useSchedule(withSeconds: boolean) {
    const [, redraw] = useState(0);

    useEffect(() => {
        const listener = () => redraw(n => n + 1);
        listeners.add(listener);
        return () => void listeners.delete(listener);
    }, []);

    useEffect(() => {
        if (!schedule) return;
        const left = schedule.at - Date.now();
        if (left <= 0) return; // the status is being applied, which redraws anyway

        const step = withSeconds || left <= 60_000 ? 1000 : 60_000;
        // Just after the shown number goes down
        const id = setTimeout(() => redraw(n => n + 1), (left - 1) % step + 20);
        return () => clearTimeout(id);
    });

    return schedule;
}

/* ---------- Button and panel ---------- */

function SchedulePanel({ close }: { close(): void; }) {
    const current = useSchedule(true);
    const [status, setStatus] = useState<Status>(() => current?.status ?? "invisible");
    const [minutes, setMinutes] = useState(() =>
        current ? String(Math.max(1, Math.round((current.at - Date.now()) / 60_000))) : "30"
    );

    const value = Number(minutes);
    const valid = Number.isFinite(value) && value > 0 && value <= MAX_MINUTES;

    const submit = () => {
        if (!valid) return;
        setSchedule(status, value);
        close();
    };

    return (
        <div className="vc-scheduledStatus-panel">
            <div className="vc-scheduledStatus-title">Change my status in…</div>

            {current && (
                <div className="vc-scheduledStatus-current">
                    <span className="vc-scheduledStatus-dot" style={{ background: statusInfo(current.status).color }} />
                    <span className="vc-scheduledStatus-currentText">
                        {statusInfo(current.status).label} in <b>{formatRemaining(current.at - Date.now(), true)}</b> ({formatTime(current.at)})
                    </span>
                    <button className="vc-scheduledStatus-link" onClick={cancelSchedule}>
                        Cancel
                    </button>
                </div>
            )}

            <div className="vc-scheduledStatus-statuses">
                {STATUSES.map(s => (
                    <button
                        key={s.value}
                        className={classes("vc-scheduledStatus-option", status === s.value && "vc-scheduledStatus-selected")}
                        onClick={() => setStatus(s.value)}
                    >
                        <span className="vc-scheduledStatus-dot" style={{ background: s.color }} />
                        {s.label}
                    </button>
                ))}
            </div>

            <div className="vc-scheduledStatus-row">
                <input
                    className="vc-scheduledStatus-input"
                    type="number"
                    min={1}
                    max={MAX_MINUTES}
                    value={minutes}
                    autoFocus
                    onChange={e => setMinutes(e.currentTarget.value)}
                    onKeyDown={e => { if (e.key === "Enter") submit(); }}
                />
                <span>minutes</span>
            </div>

            <div className="vc-scheduledStatus-presets">
                {PRESETS.map(p => (
                    <button key={p} className="vc-scheduledStatus-chip" onClick={() => setMinutes(String(p))}>
                        {p < 60 ? `${p} min` : `${p / 60} h`}
                    </button>
                ))}
            </div>

            <button className="vc-scheduledStatus-submit" disabled={!valid} onClick={submit}>
                {valid
                    ? `${current ? "Replace with" : "Schedule"}: ${statusInfo(status).label} at ${formatTime(Date.now() + value * 60_000)}`
                    : `Enter 1 to ${MAX_MINUTES} minutes`}
            </button>
        </div>
    );
}

function ScheduledStatusButton(props: { nameplate?: any; }) {
    const { showButton } = settings.use(["showButton"]);
    const current = useSchedule(false);
    const buttonRef = useRef<HTMLDivElement | null>(null);

    if (!showButton || !running) return null;

    const info = current ? statusInfo(current.status) : null;

    return (
        <Popout
            position="top"
            align="center"
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => <SchedulePanel close={closePopout} />}
        >
            {popoutProps => (
                <div ref={buttonRef} className="vc-scheduledStatus-anchor">
                    <PanelButton
                        tooltipText={current && info
                            ? `${info.label} in ${formatRemaining(current.at - Date.now(), false)} (${formatTime(current.at)})`
                            : "Schedule a status"}
                        icon={info ? info.Icon : PlainClockIcon}
                        plated={props?.nameplate != null}
                        onClick={popoutProps.onClick}
                    />
                </div>
            )}
        </Popout>
    );
}

/* ---------- Plugin ---------- */

export default definePlugin({
    name: "ScheduledStatus",
    description: "Change your status (Online, Idle, Do Not Disturb, Invisible) automatically after a number of minutes, from a clock button next to the mic or with /statusin.",
    tags: ["Utility", "Shortcuts"],
    authors: [{ name: "TheUnknownMurda", id: 338163169782398977n }],
    dependencies: ["UserSettingsAPI"],
    settings,

    managedStyle,

    patches: [
        {
            // Account panel at the bottom left (avatar, mic, headset, settings)
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                // Puts the button right before the mic button. Doesn't use "children:[" like
                // GameActivityToggle does, so both plugins (and SpotifyActivityToggle) can be on together.
                match: /(?=\(0,\i\.jsxs?\)\(\i,\{accountContainerRef:)/,
                replace: "$self.ScheduledStatusButton(arguments[0]),"
            }
        }
    ],

    commands: [
        {
            name: "statusin",
            description: "Change your status after a number of minutes",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "status",
                    description: "The status to switch to",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                    choices: STATUSES.map(s => ({ name: s.label, label: s.label, displayName: s.label, value: s.value }))
                },
                {
                    name: "minutes",
                    description: "In how many minutes",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                }
            ],
            execute(args, ctx) {
                const status = findOption<string>(args, "status", "");
                const minutes = Number(findOption(args, "minutes", 0));
                if (!isStatus(status) || !(minutes > 0 && minutes <= MAX_MINUTES)) {
                    sendBotMessage(ctx.channel.id, { content: `Pick a status and 1 to ${MAX_MINUTES} minutes.` });
                    return;
                }
                setSchedule(status, minutes);
                sendBotMessage(ctx.channel.id, {
                    content: `Your status will change to **${statusInfo(status).label}** in ${minutes} min (at ${formatTime(Date.now() + minutes * 60_000)}). Cancel with /statuscancel.`
                });
            }
        },
        {
            name: "statuscancel",
            description: "Cancel the scheduled status",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute(_args, ctx) {
                const had = schedule;
                cancelSchedule();
                sendBotMessage(ctx.channel.id, {
                    content: had ? `Cancelled: ${statusInfo(had.status).label} at ${formatTime(had.at)}.` : "No status was scheduled."
                });
            }
        }
    ],

    async start() {
        running = true;
        emit();

        try {
            const saved = await DataStore.get<Schedule>(DATASTORE_KEY);
            // Turned off meanwhile, or a new schedule was made while this was loading
            if (!running || !saved || schedule) return;

            const late = Date.now() - saved.at;
            if (late < 0 && isStatus(saved.status)) {
                schedule = saved;
                arm();
                emit();
            } else if (settings.store.whenMissed === "apply" && late < MAX_MISSED && isStatus(saved.status)) {
                schedule = saved;
                await applySchedule(true);
            } else {
                logger.info("Forgot a scheduled status missed while Discord was closed");
                await DataStore.del(DATASTORE_KEY);
            }
        } catch (e) {
            logger.error("Could not load the saved schedule", e);
        }
    },

    stop() {
        // Turning the plugin off cancels the waiting status
        cancelSchedule();
        running = false;
        emit();
    },

    ScheduledStatusButton: ErrorBoundary.wrap(ScheduledStatusButton, { noop: true }),
});
