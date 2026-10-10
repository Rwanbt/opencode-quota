/**
 * The server settings, one module: `loadSettings`, `saveSettings(patch)`, `watchSettings`,
 * `convertV5` and the schema the agent tools describe and check values with. Display settings
 * (looks) are not here; the TUI keeps them in OpenCode's plugin storage.
 */
export type { ConvertedKey, DisplayImport, SkippedKey, V5Conversion } from "./convert.js";
export {
  convertV5,
  type LoadedSettings,
  loadSettings,
  type SaveResult,
  type SettingsChange,
  type SettingsWatch,
  saveSettings,
  settingsPath,
  watchSettings,
} from "./file.js";
export {
  type CursorPlan,
  checkSetting,
  defaultSettings,
  describeRule,
  keysUnder,
  type PercentStyle,
  PROVIDER_IDS,
  type ResetStyle,
  SETTINGS_SCHEMA,
  type SettingRule,
  type Settings,
  type SettingsIssue,
} from "./schema.js";
