export type ThemeOption = "light" | "dark" | "system";

export type TileColorMode = "system" | "custom";

export interface AppConfig {
  locale: string;
  notesDir: string;
  globalShortcut: string;
  closeToTray: boolean;
  autostart: boolean;
  noteSurfaceAutoSave: boolean;
  tileColor: string;
  tileColorMode: TileColorMode;
  theme: ThemeOption;
  fontSize: number;
  surfaceFontSize: number;
  tabIndentSize: number;
  tileCtrlClose: boolean;
  tileRenderMarkdown: boolean;
  surfaceWidth?: number;
  surfaceHeight?: number;
  surfaceX?: number;
  surfaceY?: number;
  toggleVisibilityShortcut: string;
}
