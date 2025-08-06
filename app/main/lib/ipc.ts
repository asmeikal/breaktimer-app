import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { IpcChannel } from "../../types/ipc";
import { Settings, SoundType } from "../../types/settings";
import { getAllowPostpone, getBreakLength, postponeBreak } from "./breaks";
import { getSettings, setSettings } from "./store";
import { getWindows } from "./windows";

const logger = log.scope("IPC");

export function sendIpc(channel: IpcChannel, ...args: unknown[]): void {
  const windows: BrowserWindow[] = getWindows();

  logger.info(`Send event ${channel}`, args);

  for (const window of windows) {
    if (!window) {
      continue;
    }

    window.webContents.send(channel, ...args);
  }
}

ipcMain.handle(IpcChannel.AllowPostponeGet, (): boolean => {
  logger.info(IpcChannel.AllowPostponeGet);
  return getAllowPostpone();
});

ipcMain.handle(IpcChannel.BreakPostpone, (): void => {
  logger.info(IpcChannel.BreakPostpone);
  postponeBreak();
});

ipcMain.handle(
  IpcChannel.SoundStartPlay,
  (_event: IpcMainInvokeEvent, type: SoundType): void => {
    logger.info(IpcChannel.SoundStartPlay);
    sendIpc(IpcChannel.SoundStartPlay, type);
  }
);

ipcMain.handle(
  IpcChannel.SoundEndPlay,
  (_event: IpcMainInvokeEvent, type: SoundType): void => {
    logger.info(IpcChannel.SoundEndPlay);
    sendIpc(IpcChannel.SoundEndPlay, type);
  }
);

ipcMain.handle(IpcChannel.SettingsGet, (): Settings => {
  logger.info(IpcChannel.SettingsGet);
  return getSettings();
});

ipcMain.handle(
  IpcChannel.SettingsSet,
  (_event: IpcMainInvokeEvent, settings: Settings): void => {
    logger.info(IpcChannel.SettingsSet);
    setSettings(settings);
  }
);

ipcMain.handle(IpcChannel.BreakLengthGet, (): Date => {
  logger.info(IpcChannel.BreakLengthGet);
  return getBreakLength();
});
