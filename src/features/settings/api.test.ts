import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { getConfig, saveConfig } from "./api";
import type { AppConfig } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe("settings api", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  test("gets config through Rust", async () => {
    const config: AppConfig = {
      locale: "zh-CN",
      notesDir: "D:\\notes",
      globalShortcut: "Ctrl+Space",
      closeToTray: true,
      autostart: false,
      noteSurfaceAutoSave: true,
      tileColor: "#f6f3ec",
      tileColorMode: "system",
      theme: "light",
      fontSize: 14,
      surfaceFontSize: 14,
      tabIndentSize: 2,
      tileCtrlClose: true,
      toggleVisibilityShortcut: "",
      tileRenderMarkdown: false,
    };
    mockedInvoke.mockResolvedValue(config);

    await expect(getConfig()).resolves.toBe(config);

    expect(invoke).toHaveBeenCalledWith("config_get");
  });

  test("saves config through Rust", async () => {
    const config: AppConfig = {
      locale: "zh-CN",
      notesDir: "D:\\notes",
      globalShortcut: "Alt+Space",
      closeToTray: false,
      autostart: true,
      noteSurfaceAutoSave: false,
      tileColor: "#efe8dc",
      tileColorMode: "custom",
      theme: "dark",
      fontSize: 16,
      surfaceFontSize: 16,
      tabIndentSize: 4,
      tileCtrlClose: true,
      toggleVisibilityShortcut: "",
      tileRenderMarkdown: false,
    };
    mockedInvoke.mockResolvedValue(config);

    await expect(saveConfig(config)).resolves.toBe(config);

    expect(invoke).toHaveBeenCalledWith("config_save", { config });
  });
});
