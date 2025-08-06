import { powerMonitor } from "electron";
import log from "electron-log";
import moment from "moment";
import { BreakTime } from "../../types/breaks";
import { IpcChannel } from "../../types/ipc";
import {
  DayConfig,
  NotificationType,
  Settings,
  SoundType,
} from "../../types/settings";
import { sendIpc } from "./ipc";
import { showNotification } from "./notifications";
import { getSettings } from "./store";
import { buildTray } from "./tray";
import { createBreakWindows } from "./windows";

let breakTime: BreakTime = null;
let havingBreak = false;
let postponedCount = 0;
let idleStart: Date | null = null;
let lockStart: Date | null = null;
let lastTick: Date | null = null;

const logger = log.scope("Breaks");

export function getStatus() {
  return {
    breakTime,
    havingBreak,
    postponedCount,
    idleStart,
    lockStart,
    lastTick,
  };
}

export function getBreakTime(): BreakTime {
  logger.silly("Retrieving break time", { breakTime });
  return breakTime;
}

export function getBreakLength(): Date {
  const settings: Settings = getSettings();
  const breakLength = settings.breakLength;
  logger.silly("Retrieving break length", { breakLength });
  return breakLength;
}

function zeroPad(n: number) {
  const nStr = String(n);
  return nStr.length === 1 ? `0${nStr}` : nStr;
}

function getSeconds(date: Date): number {
  return (
    date.getHours() * 60 * 60 + date.getMinutes() * 60 + date.getSeconds() || 1
  ); // can't be 0
}

function getIdleResetSeconds(): number {
  const settings: Settings = getSettings();
  return getSeconds(new Date(settings.idleResetLength));
}

function getBreakSeconds(): number {
  const settings: Settings = getSettings();
  return getSeconds(new Date(settings.breakFrequency));
}

function createIdleNotification() {
  const settings: Settings = getSettings();

  if (!settings.idleResetEnabled || idleStart === null) {
    return;
  }

  let idleSeconds = Number(((+new Date() - +idleStart) / 1000).toFixed(0));
  let idleMinutes = 0;
  let idleHours = 0;

  if (idleSeconds > 60) {
    idleMinutes = Math.floor(idleSeconds / 60);
    idleSeconds -= idleMinutes * 60;
  }

  if (idleMinutes > 60) {
    idleHours = Math.floor(idleMinutes / 60);
    idleMinutes -= idleHours * 60;
  }

  if (settings.idleResetNotification) {
    logger.info("Showing idle notification", {
      idleHours,
      idleMinutes,
      idleSeconds,
      ...getStatus(),
    });

    showNotification(
      "Break countdown reset",
      `Idle for ${zeroPad(idleHours)}:${zeroPad(idleMinutes)}:${zeroPad(
        idleSeconds
      )}`
    );
  }
}

export function createBreak(isPostpone = false): void {
  logger.info("Creating a break", { isPostpone, ...getStatus() });
  const settings: Settings = getSettings();

  if (idleStart) {
    createIdleNotification();
    idleStart = null;
    postponedCount = 0;
  }

  const freq = new Date(
    isPostpone ? settings.postponeLength : settings.breakFrequency
  );

  breakTime = moment()
    .add(freq.getHours(), "hours")
    .add(freq.getMinutes(), "minutes")
    .add(freq.getSeconds(), "seconds");

  logger.info(`Next break time is ${breakTime}`, { ...getStatus() });

  buildTray();
}

export function endPopupBreak(): void {
  if (breakTime !== null && breakTime < moment()) {
    logger.info("Ending popup break", {
      ...getStatus(),
    });
    breakTime = null;
    havingBreak = false;
    postponedCount = 0;
  }
}

export function getAllowPostpone(): boolean {
  const settings = getSettings();
  logger.silly("Checking if user is allowed to postpone break", {
    postponedCount,
    postponeLimit: settings.postponeLimit,
  });
  return !settings.postponeLimit || postponedCount < settings.postponeLimit;
}

export function postponeBreak(): void {
  postponedCount++;
  logger.info("Postponing break", { ...getStatus() });
  havingBreak = false;
  createBreak(true);
}

function doBreak(): void {
  logger.info("Starting break now", { ...getStatus() });
  havingBreak = true;

  const settings: Settings = getSettings();

  if (settings.notificationType === NotificationType.Notification) {
    showNotification(settings.breakTitle, settings.breakMessage);
    if (settings.soundType !== SoundType.None) {
      sendIpc(IpcChannel.SoundStartPlay, settings.soundType);
    }
    havingBreak = false;
    createBreak();
  }

  if (settings.notificationType === NotificationType.Popup) {
    createBreakWindows();
  }
}

export function checkInWorkingHours(): boolean {
  logger.silly("Checking if currently in working hours");

  const settings: Settings = getSettings();

  if (!settings.workingHoursEnabled) {
    logger.silly("Working hours are currently disabled");
    return true;
  }

  const now = moment();
  const currentMinutes = now.hours() * 60 + now.minutes();
  const dayOfWeek = now.day();

  const dayMap: { [key: number]: DayConfig["key"] } = {
    0: "workingHoursSunday",
    1: "workingHoursMonday",
    2: "workingHoursTuesday",
    3: "workingHoursWednesday",
    4: "workingHoursThursday",
    5: "workingHoursFriday",
    6: "workingHoursSaturday",
  };

  const todaySettings = settings[dayMap[dayOfWeek]];

  if (!todaySettings.enabled) {
    logger.silly("Working hours are disabled for today", {
      day: dayMap[dayOfWeek],
      settings,
    });
    return false;
  }

  logger.silly("Checking today's working hours", {
    todaySettings,
    currentMinutes,
  });
  return todaySettings.ranges.some(
    (range) =>
      currentMinutes >= range.fromMinutes && currentMinutes <= range.toMinutes
  );
}

enum IdleState {
  Active = "active",
  Idle = "idle",
  Locked = "locked",
  Unknown = "unknown",
}

export function checkIdle(): boolean {
  const settings: Settings = getSettings();

  const state: IdleState = powerMonitor.getSystemIdleState(
    getIdleResetSeconds()
  ) as IdleState;

  logger.silly(`Current state is ${state}`);

  if (state === IdleState.Locked) {
    if (!lockStart) {
      logger.info(`Screen is now locked`, { ...getStatus() });
      lockStart = new Date();
      return false;
    } else {
      const lockSeconds = Number(
        ((+new Date() - +lockStart) / 1000).toFixed(0)
      );
      return lockSeconds > getIdleResetSeconds();
    }
  }

  lockStart = null;

  if (!settings.idleResetEnabled) {
    return false;
  }

  return state === IdleState.Idle;
}

function checkShouldHaveBreak(): boolean {
  const settings: Settings = getSettings();
  const inWorkingHours = checkInWorkingHours();
  const idle = checkIdle();

  logger.silly("Checking if user should can break", {
    havingBreak,
    breaksEnabled: settings.breaksEnabled,
    inWorkingHours,
    idle,
  });

  return !havingBreak && settings.breaksEnabled && inWorkingHours && !idle;
}

function checkBreak(): void {
  logger.silly(`Checking if break should run now`);
  const now = moment();

  if (breakTime !== null && now > breakTime) {
    doBreak();
  }
}

export function startBreakNow(): void {
  logger.info("Starting break now", { ...getStatus() });
  breakTime = moment();
}

function tick(): void {
  logger.silly("Running tick");
  try {
    const shouldHaveBreak = checkShouldHaveBreak();

    // This can happen if the computer is put to sleep. In this case, we want
    // to skip the break if the time the computer was unresponsive was greater
    // than the idle reset.
    const secondsSinceLastTick = lastTick
      ? Math.abs(+new Date() - +lastTick) / 1000
      : 0;
    const breakSeconds = getBreakSeconds();
    const lockSeconds = lockStart && Math.abs(+new Date() - +lockStart) / 1000;
    const idleResetSeconds = getIdleResetSeconds();

    logger.silly("Checking if computer has been asleep", {
      secondsSinceLastTick,
      breakSeconds,
      lockSeconds,
      idleResetSeconds,
      ...getStatus(),
    });
    if (lockStart && lockSeconds !== null && lockSeconds > breakSeconds) {
      // The computer has been locked for longer than the break period. In this
      // case, it's not particularly helpful to show an idle reset
      // notification, so unset idle start
      logger.info(
        "Computer has been locked longer than break period, resetting idle start",
        {
          secondsSinceLastTick,
          breakSeconds,
          lockSeconds,
          idleResetSeconds,
          ...getStatus(),
        }
      );
      idleStart = null;
      lockStart = null;
    } else if (secondsSinceLastTick > breakSeconds) {
      // The computer has been slept for longer than the break period. In this
      // case, it's not particularly helpful to show an idle reset
      // notification, so just reset the break
      logger.info(
        "Ticks have not run for longer than the break period, removing next break",
        {
          secondsSinceLastTick,
          breakSeconds,
          lockSeconds,
          idleResetSeconds,
          ...getStatus(),
        }
      );
      lockStart = null;
      breakTime = null;
    } else if (secondsSinceLastTick > idleResetSeconds) {
      //  If idleStart exists, it means we were idle before the computer slept.
      //  If it doesn't exist, count the computer going unresponsive as the
      //  start of the idle period.
      logger.info(
        "Ticks have not run for longer than idle reset period, resetting next break",
        {
          secondsSinceLastTick,
          breakSeconds,
          lockSeconds,
          idleResetSeconds,
          ...getStatus(),
        }
      );
      if (!idleStart) {
        logger.info("Setting idle start to last tick", { ...getStatus() });
        lockStart = null;
        idleStart = lastTick;
      }
      createBreak();
    }

    if (!shouldHaveBreak && !havingBreak && breakTime) {
      if (checkIdle()) {
        logger.info(`User is now idle`, { ...getStatus() });
        idleStart = new Date();
      }
      logger.info(`Clearing next break time`, { ...getStatus() });
      breakTime = null;
      buildTray();
      return;
    }

    if (shouldHaveBreak && !breakTime) {
      createBreak();
      return;
    }

    if (shouldHaveBreak) {
      checkBreak();
    }
  } catch (e) {
    logger.error("Caught error in tick", { error: e });
  } finally {
    logger.silly("Resetting last tick");
    lastTick = new Date();
  }
}

let tickInterval: NodeJS.Timeout;

export function initBreaks(): void {
  logger.info("Initializing breaks", { ...getStatus() });

  const settings: Settings = getSettings();

  if (settings.breaksEnabled) {
    createBreak();
  }

  if (tickInterval) {
    clearInterval(tickInterval);
  }

  tickInterval = setInterval(tick, 1000);
}

powerMonitor.addListener("suspend", () => {
  logger.info("System is suspending", { ...getStatus() });
});

powerMonitor.addListener("resume", () => {
  logger.info("System is resuming", { ...getStatus() });
});

powerMonitor.addListener("lock-screen", () => {
  logger.info("Screen is being locked", { ...getStatus() });
});

powerMonitor.addListener("unlock-screen", () => {
  logger.info("Screen is being unlocked", { ...getStatus() });
});
