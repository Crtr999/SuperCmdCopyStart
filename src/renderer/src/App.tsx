/**
 * Launcher App
 *
 * Dynamically displays all applications and System Settings.
 * Shows category labels like Raycast.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, ArrowRight, Loader2, File as FileIcon } from 'lucide-react';
import type { CommandInfo, ExtensionBundle, AppSettings } from '../types/electron';
import ExtensionView from './ExtensionView';
import ClipboardManager from './ClipboardManager';
import SnippetManager from './SnippetManager';
import OnboardingExtension from './OnboardingExtension';
import FileSearchExtension from './FileSearchExtension';
import SuperCmdWhisper from './SuperCmdWhisper';
import SuperCmdRead from './SuperCmdRead';
import { tryCalculate, tryCalculateAsync } from './smart-calculator';
import { isBibleReference, lookupBibleVerse, type BibleResult } from './bible-lookup';
import { useDetachedPortalWindow } from './useDetachedPortalWindow';
import { useAppViewManager } from './hooks/useAppViewManager';
import { useAiChat } from './hooks/useAiChat';
import { useCursorPrompt } from './hooks/useCursorPrompt';
import { useMenuBarExtensions } from './hooks/useMenuBarExtensions';
import { useBackgroundRefresh } from './hooks/useBackgroundRefresh';
import { useSpeakManager } from './hooks/useSpeakManager';
import { useWhisperManager } from './hooks/useWhisperManager';
import { LAST_EXT_KEY, MAX_RECENT_COMMANDS } from './utils/constants';
import { resetAccessToken } from './raycast-api';
import {
  type LauncherAction, type MemoryFeedback,
  filterCommands, formatShortcutLabel, getCategoryLabel,
  renderCommandIcon, getCommandDisplayTitle,
  getCommandAccessoryLabel,
  renderShortcutLabel,
} from './utils/command-helpers';
import {
  readJsonObject, writeJsonObject,
  getScriptCmdArgsKey,
  hydrateExtensionBundlePreferences,
  shouldOpenCommandSetup,
  getMissingRequiredScriptArguments, toScriptArgumentMapFromArray,
} from './utils/extension-preferences';
import ScriptCommandSetupView from './views/ScriptCommandSetupView';
import ScriptCommandOutputView from './views/ScriptCommandOutputView';
import ExtensionPreferenceSetupView from './views/ExtensionPreferenceSetupView';
import AiChatView from './views/AiChatView';
import CursorPromptView from './views/CursorPromptView';

const STALE_OVERLAY_RESET_MS = 60_000;

// ─── Inline file search helpers ──────────────────────────────────────
interface InlineFileResult {
  path: string;
  name: string;
  dir: string;
  location: string; // friendly label: "iCloud Drive", "Documents", etc.
}

const ICLOUD_DRIVE_SUBPATH = '/Library/Mobile Documents/com~apple~CloudDocs';

// ─── Pinned file helpers ────────────────────────────────────────────
const FILE_PIN_PREFIX = 'file:';

interface PinnedFileItem {
  id: string;          // "file:<path>"
  path: string;
  name: string;
  location: string;
  iconDataUrl?: string;
}

function isPinnedFileId(id: string): boolean {
  return id.startsWith(FILE_PIN_PREFIX);
}

function pinnedFileIdToPath(id: string): string {
  return id.slice(FILE_PIN_PREFIX.length);
}

function pathToPinnedFileId(filePath: string): string {
  return FILE_PIN_PREFIX + filePath;
}

function pinnedFileToCommandInfo(file: PinnedFileItem): CommandInfo {
  return {
    id: file.id,
    title: file.name,
    subtitle: file.location,
    iconDataUrl: file.iconDataUrl,
    category: 'file',
    path: file.path,
  };
}

function fileBasename(filePath: string): string {
  const normalized = filePath.replace(/\/$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function fileDirname(filePath: string): string {
  const normalized = filePath.replace(/\/$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx > 0 ? normalized.slice(0, idx) : '/';
}

function asTildePath(filePath: string): string {
  const home = (window.electron as any).homeDir || '';
  if (home && filePath.startsWith(home)) {
    return '~' + (filePath.slice(home.length) || '/');
  }
  return filePath;
}

function getFileLocation(filePath: string): string {
  const home = (window.electron as any).homeDir || '';
  const icloudRoot = home + ICLOUD_DRIVE_SUBPATH;
  if (filePath.startsWith(icloudRoot + '/') || filePath === icloudRoot) {
    const relative = filePath.slice(icloudRoot.length + 1);
    const firstDir = relative.split('/')[0] || '';
    return firstDir ? `iCloud Drive / ${firstDir}` : 'iCloud Drive';
  }
  if (home) {
    const relative = filePath.startsWith(home + '/') ? filePath.slice(home.length + 1) : '';
    if (relative.startsWith('Desktop/') || relative === 'Desktop') return 'Desktop';
    if (relative.startsWith('Documents/') || relative === 'Documents') return 'Documents';
    if (relative.startsWith('Downloads/') || relative === 'Downloads') return 'Downloads';
    if (relative.startsWith('Applications/') || relative === 'Applications') return 'Applications';
  }
  if (filePath.startsWith('/Applications/')) return 'Applications';
  return asTildePath(fileDirname(filePath));
}

function buildInlineSpotlightQuery(rawQuery: string): string {
  const terms = rawQuery
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return 'kMDItemFSName == "*"cd';
  return terms
    .map((t) => `kMDItemFSName == "*${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}*"cd`)
    .join(' && ');
}

function matchesAllTerms(fileName: string, terms: string[]): boolean {
  const lower = fileName.toLowerCase();
  return terms.every((t) => lower.includes(t));
}

/** Score a file path for relevance to search terms (higher = better match). */
function scoreFileResult(filePath: string, terms: string[]): number {
  const name = fileBasename(filePath).toLowerCase();
  const nameNoExt = name.replace(/\.[^.]+$/, '');
  let score = 0;

  for (const t of terms) {
    if (nameNoExt === t) {
      score += 200;               // exact name match (sans extension)
    } else if (nameNoExt.startsWith(t)) {
      score += 100;               // prefix match
    } else if (name.startsWith(t)) {
      score += 90;                // prefix with extension
    } else if (nameNoExt.includes(t)) {
      score += 50;                // substring match
    } else {
      score += 10;                // display-name-only / fallback match
    }
  }

  // Bonus: shorter names are more specific / likely what user wants
  score += Math.max(0, 60 - name.length);

  return score;
}
// ─────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [pinnedCommands, setPinnedCommands] = useState<string[]>([]);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const {
    extensionView, extensionPreferenceSetup, scriptCommandSetup, scriptCommandOutput,
    showClipboardManager, showSnippetManager, showFileSearch, showCursorPrompt,
    showWhisper, showSpeak, showWhisperOnboarding, showWhisperHint, showOnboarding, aiMode,
    openOnboarding, openWhisper, openClipboardManager,
    openSnippetManager, openFileSearch, openCursorPrompt, openSpeak,
    setExtensionView, setExtensionPreferenceSetup, setScriptCommandSetup, setScriptCommandOutput,
    setShowClipboardManager, setShowSnippetManager, setShowFileSearch, setShowCursorPrompt,
    setShowWhisper, setShowSpeak, setShowWhisperOnboarding, setShowWhisperHint,
    setShowOnboarding, setAiMode,
  } = useAppViewManager();
  const {
    whisperOnboardingPracticeText, setWhisperOnboardingPracticeText,
    whisperSpeakToggleLabel, setWhisperSpeakToggleLabel,
    whisperSessionRef,
    appendWhisperOnboardingPracticeText,
    whisperPortalTarget,
  } = useWhisperManager({
    showWhisper, setShowWhisper,
    showWhisperOnboarding, setShowWhisperOnboarding,
    showWhisperHint, setShowWhisperHint,
  });
  const {
    speakStatus, speakOptions,
    setConfiguredEdgeTtsVoice, setConfiguredTtsModel,
    readVoiceOptions,
    handleSpeakVoiceChange, handleSpeakRateChange,
    speakPortalTarget,
  } = useSpeakManager({ showSpeak, setShowSpeak });
  const [onboardingRequiresShortcutFix, setOnboardingRequiresShortcutFix] = useState(false);
  const [onboardingHotkeyPresses, setOnboardingHotkeyPresses] = useState(0);
  const [launcherShortcut, setLauncherShortcut] = useState('Alt+Space');
  const [showActions, setShowActions] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    commandId: string;
  } | null>(null);
  const [selectedActionIndex, setSelectedActionIndex] = useState(0);
  const [selectedContextActionIndex, setSelectedContextActionIndex] = useState(0);
  const {
    menuBarExtensions,
    backgroundNoViewRuns, setBackgroundNoViewRuns,
    isMenuBarExtensionMounted,
    hideMenuBarExtension,
    upsertMenuBarExtension,
  } = useMenuBarExtensions();
  const [selectedTextSnapshot, setSelectedTextSnapshot] = useState('');
  const [memoryFeedback, setMemoryFeedback] = useState<MemoryFeedback>(null);
  const [memoryActionLoading, setMemoryActionLoading] = useState(false);

  // Inline file search state
  const [fileResults, setFileResults] = useState<InlineFileResult[]>([]);
  const [fileIcons, setFileIcons] = useState<Record<string, string>>({});

  // Resolved pinned file items (from file: IDs in pinnedCommands)
  const [pinnedFiles, setPinnedFiles] = useState<Map<string, PinnedFileItem>>(new Map());
  const fileSearchSeqRef = useRef(0);
  /** Cache last mdfind raw paths so refinements (adding chars) skip mdfind entirely. */
  const mdfindCacheRef = useRef<{ query: string; rawPaths: string[] }>({ query: '', rawPaths: [] });
  const memoryFeedbackTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const commandsRef = useRef<CommandInfo[]>([]);
  commandsRef.current = commands;

  const restoreLauncherFocus = useCallback(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  const onExitAiMode = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const {
    aiResponse, aiStreaming, aiAvailable, aiQuery, setAiQuery,
    aiResponseRef, aiInputRef, setAiAvailable,
    startAiChat, submitAiQuery, exitAiMode,
  } = useAiChat({
    setAiMode,
    onExitAiMode,
  });

  const {
    cursorPromptText, setCursorPromptText,
    cursorPromptStatus,
    cursorPromptResult,
    cursorPromptError,
    cursorPromptInputRef,
    submitCursorPrompt, applyCursorPromptResultToEditor,
    closeCursorPrompt, resetCursorPromptState,
  } = useCursorPrompt({
    showCursorPrompt,
    setShowCursorPrompt,
    setAiAvailable,
  });

  const acceptCursorPrompt = applyCursorPromptResultToEditor;

  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const actionsOverlayRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const lastWindowHiddenAtRef = useRef<number>(0);
  const calcRequestSeqRef = useRef(0);
  const pinnedCommandsRef = useRef<string[]>([]);
  const extensionViewRef = useRef<ExtensionBundle | null>(null);
  extensionViewRef.current = extensionView;
  pinnedCommandsRef.current = pinnedCommands;


  const cursorPromptPortalTarget = useDetachedPortalWindow(showCursorPrompt, {
    name: 'supercmd-prompt-window',
    title: 'SuperCmd Prompt',
    width: 500,
    height: 132,
    anchor: 'caret',
    onClosed: () => {
      setShowCursorPrompt(false);
    },
  });

  const showMemoryFeedback = useCallback((type: 'success' | 'error', text: string) => {
    if (memoryFeedbackTimerRef.current !== null) {
      window.clearTimeout(memoryFeedbackTimerRef.current);
      memoryFeedbackTimerRef.current = null;
    }
    setMemoryFeedback({ type, text });
    memoryFeedbackTimerRef.current = window.setTimeout(() => {
      setMemoryFeedback(null);
      memoryFeedbackTimerRef.current = null;
    }, 2800);
  }, []);

  const refreshSelectedTextSnapshot = useCallback(async () => {
    try {
      const selected = String(await window.electron.getSelectedTextStrict() || '').trim();
      setSelectedTextSnapshot(selected);
    } catch {
      setSelectedTextSnapshot('');
    }
  }, []);

  const loadLauncherPreferences = useCallback(async () => {
    try {
      const settings = (await window.electron.getSettings()) as AppSettings;
      const shortcutStatus = await window.electron.getGlobalShortcutStatus();
      setPinnedCommands(settings.pinnedCommands || []);
      setRecentCommands(settings.recentCommands || []);
      setLauncherShortcut(settings.globalShortcut || 'Alt+Space');
      const speakToggleHotkey = settings.commandHotkeys?.['system-supercmd-whisper-speak-toggle'] || 'Fn';
      setWhisperSpeakToggleLabel(formatShortcutLabel(speakToggleHotkey));
      setConfiguredEdgeTtsVoice(String(settings.ai?.edgeTtsVoice || 'en-US-EricNeural'));
      setConfiguredTtsModel(String(settings.ai?.textToSpeechModel || 'edge-tts'));
      const shouldShowOnboarding = !settings.hasSeenOnboarding;
      setShowOnboarding(shouldShowOnboarding);
      setOnboardingRequiresShortcutFix(shouldShowOnboarding && !shortcutStatus.ok);
    } catch (e) {
      console.error('Failed to load launcher preferences:', e);
      setPinnedCommands([]);
      setRecentCommands([]);
      setLauncherShortcut('Alt+Space');
      setConfiguredEdgeTtsVoice('en-US-EricNeural');
      setConfiguredTtsModel('edge-tts');
      setShowOnboarding(false);
      setOnboardingRequiresShortcutFix(false);
    }
  }, []);

  const fetchCommands = useCallback(async (options?: { showLoading?: boolean }) => {
    const shouldShowLoading = options?.showLoading ?? commandsRef.current.length === 0;
    if (shouldShowLoading) {
      setIsLoading(true);
    }
    try {
      const fetchedCommands = await window.electron.getCommands();
      setCommands(fetchedCommands);
    } catch (error) {
      console.error('Failed to fetch commands:', error);
    } finally {
      if (shouldShowLoading) {
        setIsLoading(false);
      }
    }
  }, []);

  // Restore last opened extension on initial mount (app restart)
  useEffect(() => {
    const saved = localStorage.getItem(LAST_EXT_KEY);
    if (saved) {
      try {
        const { extName, cmdName } = JSON.parse(saved);
        window.electron.runExtension(extName, cmdName).then(result => {
          if (result && result.code) {
            const hydrated = hydrateExtensionBundlePreferences(result);
            if (hydrated.mode === 'no-view') {
              localStorage.removeItem(LAST_EXT_KEY);
            }
            if (shouldOpenCommandSetup(hydrated)) {
              setShowFileSearch(false);
              setExtensionPreferenceSetup({
                bundle: hydrated,
                values: { ...(hydrated.preferences || {}) },
                argumentValues: { ...((hydrated as any).launchArguments || {}) },
              });
            } else {
              setShowFileSearch(false);
              setExtensionView(hydrated);
            }
          } else {
            localStorage.removeItem(LAST_EXT_KEY);
          }
        }).catch(() => {
          localStorage.removeItem(LAST_EXT_KEY);
        });
      } catch {
        localStorage.removeItem(LAST_EXT_KEY);
      }
    }
  }, []);

  // Mount-only initial load — must NOT re-run when callbacks are recreated
  // or the loading flash triggers on every aiStreaming state change.
  useEffect(() => {
    fetchCommands();
    loadLauncherPreferences();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve pinned file entries whenever pinnedCommands changes
  useEffect(() => {
    const fileIds = pinnedCommands.filter(isPinnedFileId);
    if (fileIds.length === 0) {
      setPinnedFiles(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const entries: [string, PinnedFileItem][] = [];
      for (const id of fileIds) {
        const filePath = pinnedFileIdToPath(id);
        try {
          const exists = await window.electron.fileExists(filePath);
          if (!exists) continue;
          const name = fileBasename(filePath);
          const location = getFileLocation(filePath);
          const iconDataUrl = await window.electron.getFileIconDataUrl(filePath, 20) || undefined;
          entries.push([id, { id, path: filePath, name, location, iconDataUrl }]);
        } catch {
          // Skip files that can't be resolved
        }
      }
      if (!cancelled) {
        setPinnedFiles(new Map(entries));
      }
    })();
    return () => { cancelled = true; };
  }, [pinnedCommands]);

  useEffect(() => {
    const cleanupWindowHidden = window.electron.onWindowHidden(() => {
      lastWindowHiddenAtRef.current = Date.now();
    });
    return cleanupWindowHidden;
  }, []);

  useEffect(() => {
    const cleanupWindowShown = window.electron.onWindowShown((payload) => {
      console.log('[WINDOW-SHOWN] fired', payload);
      const isWhisperMode = payload?.mode === 'whisper';
      const isSpeakMode = payload?.mode === 'speak';
      const isPromptMode = payload?.mode === 'prompt';
      const routedSystemCommandId = String(payload?.systemCommandId || '');
      if (isWhisperMode) {
        whisperSessionRef.current = true;
        setSelectedTextSnapshot('');
        setMemoryFeedback(null);
        setMemoryActionLoading(false);
        openWhisper();
        return;
      }
      if (isSpeakMode) {
        whisperSessionRef.current = false;
        setSelectedTextSnapshot('');
        setMemoryFeedback(null);
        setMemoryActionLoading(false);
        openSpeak();
        return;
      }
      if (isPromptMode) {
        whisperSessionRef.current = false;
        setSelectedTextSnapshot('');
        setMemoryFeedback(null);
        setMemoryActionLoading(false);
        openCursorPrompt();
        resetCursorPromptState();
        return;
      }
      if (routedSystemCommandId) {
        whisperSessionRef.current = false;
        setShowCursorPrompt(false);
        setShowWhisperHint(false);
        setMemoryFeedback(null);
        setMemoryActionLoading(false);
        setScriptCommandSetup(null);
        setScriptCommandOutput(null);
        setExtensionView(null);
        localStorage.removeItem(LAST_EXT_KEY);
        setSearchQuery('');
        setSelectedIndex(0);
        exitAiMode();
        if (routedSystemCommandId === 'system-clipboard-manager') {
          setShowSnippetManager(null);
          setShowFileSearch(false);
          openClipboardManager();
          return;
        }
        if (routedSystemCommandId === 'system-search-snippets') {
          setShowClipboardManager(false);
          setShowFileSearch(false);
          openSnippetManager('search');
          return;
        }
        if (routedSystemCommandId === 'system-create-snippet') {
          setShowClipboardManager(false);
          setShowFileSearch(false);
          openSnippetManager('create');
          return;
        }
        if (routedSystemCommandId === 'system-search-files') {
          setShowClipboardManager(false);
          setShowSnippetManager(null);
          openFileSearch();
          return;
        }
        if (routedSystemCommandId === 'system-open-onboarding') {
          openOnboarding();
          return;
        }
        if (routedSystemCommandId === 'system-whisper-onboarding') {
          openOnboarding();
          return;
        }
      }

      whisperSessionRef.current = false;
      setShowCursorPrompt(false);
      setShowWhisperHint(false);
      setMemoryFeedback(null);
      setMemoryActionLoading(false);
      setScriptCommandSetup(null);
      setScriptCommandOutput(null);
      setSelectedTextSnapshot(String(payload?.selectedTextSnapshot || '').trim());
      const shouldResetOverlays =
        lastWindowHiddenAtRef.current > 0 &&
        Date.now() - lastWindowHiddenAtRef.current > STALE_OVERLAY_RESET_MS;

      if (shouldResetOverlays) {
        setExtensionView(null);
        localStorage.removeItem(LAST_EXT_KEY);
        setShowActions(false);
        setContextMenu(null);
        setShowClipboardManager(false);
        setShowSnippetManager(null);
        setShowFileSearch(false);
        setShowCursorPrompt(false);
        setShowWhisper(false);
        setShowSpeak(false);
        setShowWhisperOnboarding(false);
      }

      // If an extension is open, keep it alive — don't reset
      if (extensionViewRef.current && !shouldResetOverlays) return;
      setSearchQuery('');
      setSelectedIndex(0);
      exitAiMode();
      setShowClipboardManager(false);
      setShowSnippetManager(null);
      setShowFileSearch(false);
      // Re-fetch commands every time the window is shown
      // so newly installed extensions appear immediately
      fetchCommands({ showLoading: false });
      loadLauncherPreferences();
      window.electron.aiIsAvailable().then(setAiAvailable);
      inputRef.current?.focus();
    });
    return cleanupWindowShown;
  }, [fetchCommands, loadLauncherPreferences, refreshSelectedTextSnapshot, openWhisper, openSpeak, openCursorPrompt, resetCursorPromptState, exitAiMode, setShowCursorPrompt, setShowWhisperHint, setMemoryFeedback, setMemoryActionLoading, setScriptCommandSetup, setScriptCommandOutput, setExtensionView, setSearchQuery, setSelectedIndex, setShowSnippetManager, setShowFileSearch, openClipboardManager, setShowClipboardManager, openSnippetManager, openFileSearch, openOnboarding]);

  useEffect(() => {
    const cleanupSelectionSnapshotUpdated = window.electron.onSelectionSnapshotUpdated((payload) => {
      setSelectedTextSnapshot(String(payload?.selectedTextSnapshot || '').trim());
    });
    return cleanupSelectionSnapshotUpdated;
  }, []);

  // Listen for OAuth logout events from the settings window.
  // When the user clicks "Logout" in settings, clear the in-memory token
  // and reset the extension view so the auth prompt shows on next launch.
  useEffect(() => {
    const cleanup = window.electron.onOAuthLogout?.((provider: string) => {
      try {
        localStorage.removeItem(`sc-oauth-token:${provider}`);
      } catch {}
      // Clear the in-memory OAuth token and tear down the extension view
      // so the auth prompt shows on next launch.
      resetAccessToken();
      setExtensionView(null);
      localStorage.removeItem(LAST_EXT_KEY);
    });
    return cleanup;
  }, [setExtensionView]);

  useEffect(() => {
    const onLaunchBundle = (event: Event) => {
      const custom = event as CustomEvent<{
        bundle?: ExtensionBundle;
        launchOptions?: { type?: string };
        source?: { commandMode?: string; extensionName?: string; commandName?: string };
      }>;
      const incoming = custom.detail?.bundle;
      if (!incoming) return;

      const hydrated = hydrateExtensionBundlePreferences(incoming);
      const launchType = custom.detail?.launchOptions?.type || 'userInitiated';
      const sourceMode = custom.detail?.source?.commandMode || '';

      if (hydrated.mode === 'menu-bar') {
        upsertMenuBarExtension(hydrated, { remount: launchType === 'background' });
        return;
      }

      if (launchType === 'background') {
        if (hydrated.mode === 'no-view') {
          const runId = `${hydrated.extensionName || hydrated.extName}/${hydrated.commandName || hydrated.cmdName}/${Date.now()}`;
          setBackgroundNoViewRuns((prev) => [...prev, { runId, bundle: hydrated }]);
        }
        return;
      }

      // Hidden menu-bar runners should not hijack the launcher by forcing
      // view commands into the foreground (e.g. pomodoro auto transitions).
      if (sourceMode === 'menu-bar' && hydrated.mode === 'view') {
        return;
      }

      if (shouldOpenCommandSetup(hydrated)) {
        setShowFileSearch(false);
        setExtensionPreferenceSetup({
          bundle: hydrated,
          values: { ...(hydrated.preferences || {}) },
          argumentValues: { ...((hydrated as any).launchArguments || {}) },
        });
      } else {
        setShowFileSearch(false);
        setExtensionView(hydrated);
      }
    };

    window.addEventListener('sc-launch-extension-bundle', onLaunchBundle as EventListener);
    return () => window.removeEventListener('sc-launch-extension-bundle', onLaunchBundle as EventListener);
  }, [upsertMenuBarExtension]);

  useEffect(() => {
    const onRunScript = (event: Event) => {
      const custom = event as CustomEvent<{
        commandId?: string;
        arguments?: string[];
      }>;
      const commandId = String(custom.detail?.commandId || '').trim();
      if (!commandId) return;
      void (async () => {
        let command = commands.find((cmd) => cmd.id === commandId && cmd.category === 'script');
        if (!command) {
          const all = await window.electron.getAllCommands();
          command = all.find((cmd) => cmd.id === commandId && cmd.category === 'script');
        }
        if (!command) return;
        const values = toScriptArgumentMapFromArray(command, custom.detail?.arguments || []);
        writeJsonObject(getScriptCmdArgsKey(command.id), values);
        const result = await window.electron.runScriptCommand({
          commandId: command.id,
          arguments: values,
          background: false,
        });
        if (!result) return;
        if (result.needsArguments) {
          setShowFileSearch(false);
          setScriptCommandSetup({
            command,
            values: { ...values },
          });
          return;
        }
        if (result.mode === 'fullOutput') {
          setShowFileSearch(false);
          setScriptCommandOutput({
            command,
            output: String(result.output || result.stdout || result.stderr || '').trim(),
            exitCode: Number(result.exitCode || 0),
          });
          return;
        }
        if (result.mode === 'inline') {
          await fetchCommands();
        }
      })();
    };
    window.addEventListener('sc-run-script-command', onRunScript as EventListener);
    return () => window.removeEventListener('sc-run-script-command', onRunScript as EventListener);
  }, [commands, fetchCommands]);

  useBackgroundRefresh({ commands, fetchCommands });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    void refreshSelectedTextSnapshot();
  }, [refreshSelectedTextSnapshot]);

  const saveLauncherPreferences = useCallback(
    async (next: { pinnedCommands?: string[]; recentCommands?: string[] }) => {
      const patch: Partial<AppSettings> = {};
      if (next.pinnedCommands) patch.pinnedCommands = next.pinnedCommands;
      if (next.recentCommands) patch.recentCommands = next.recentCommands;
      if (Object.keys(patch).length > 0) {
        await window.electron.saveSettings(patch);
      }
    },
    []
  );

  const updateRecentCommands = useCallback(
    async (commandId: string) => {
      const updated = [
        commandId,
        ...recentCommands.filter((id) => id !== commandId),
      ].slice(0, MAX_RECENT_COMMANDS);
      setRecentCommands(updated);
      await saveLauncherPreferences({ recentCommands: updated });
    },
    [recentCommands, saveLauncherPreferences]
  );

  const updatePinnedCommands = useCallback(
    async (nextPinned: string[]) => {
      setPinnedCommands(nextPinned);
      await saveLauncherPreferences({ pinnedCommands: nextPinned });
    },
    [saveLauncherPreferences]
  );

  const pinToggleForCommand = useCallback(
    async (command: CommandInfo) => {
      console.log('[PIN-TOGGLE] called for command:', command?.id, command?.name);
      const currentPinned = pinnedCommandsRef.current;
      const exists = currentPinned.includes(command.id);
      console.log('[PIN-TOGGLE] currentPinned:', currentPinned, 'exists:', exists);
      if (exists) {
        await updatePinnedCommands(
          currentPinned.filter((id) => id !== command.id)
        );
      } else {
        await updatePinnedCommands([command.id, ...currentPinned]);
      }
      console.log('[PIN-TOGGLE] done, new pinned:', pinnedCommandsRef.current);
    },
    [updatePinnedCommands]
  );

  const pinToggleForFile = useCallback(
    async (filePath: string) => {
      const fileId = pathToPinnedFileId(filePath);
      const currentPinned = pinnedCommandsRef.current;
      if (currentPinned.includes(fileId)) {
        await updatePinnedCommands(currentPinned.filter((id) => id !== fileId));
      } else {
        await updatePinnedCommands([fileId, ...currentPinned]);
      }
    },
    [updatePinnedCommands]
  );

  const disableCommand = useCallback(
    async (command: CommandInfo) => {
      await window.electron.toggleCommandEnabled(command.id, false);
      await updatePinnedCommands(pinnedCommands.filter((id) => id !== command.id));
      const nextRecent = recentCommands.filter((id) => id !== command.id);
      setRecentCommands(nextRecent);
      await saveLauncherPreferences({ recentCommands: nextRecent });
      await fetchCommands();
    },
    [
      pinnedCommands,
      recentCommands,
      updatePinnedCommands,
      saveLauncherPreferences,
      fetchCommands,
    ]
  );

  const uninstallExtensionCommand = useCallback(
    async (command: CommandInfo) => {
      if (command.category !== 'extension' || !command.path) return;
      const [extName] = command.path.split('/');
      if (!extName) return;
      await window.electron.uninstallExtension(extName);
      await updatePinnedCommands(pinnedCommands.filter((id) => id !== command.id));
      const nextRecent = recentCommands.filter((id) => id !== command.id);
      setRecentCommands(nextRecent);
      await saveLauncherPreferences({ recentCommands: nextRecent });
      await fetchCommands();
    },
    [
      pinnedCommands,
      recentCommands,
      updatePinnedCommands,
      saveLauncherPreferences,
      fetchCommands,
    ]
  );

  const movePinnedCommand = useCallback(
    async (command: CommandInfo, direction: 'up' | 'down') => {
      const idx = pinnedCommands.indexOf(command.id);
      if (idx === -1) return;
      const target = direction === 'up' ? idx - 1 : idx + 1;
      if (target < 0 || target >= pinnedCommands.length) return;
      const next = [...pinnedCommands];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      await updatePinnedCommands(next);
    },
    [pinnedCommands, updatePinnedCommands]
  );

  // ─── Drag-to-reorder pinned items ──────────────────────────────────
  const [dragState, setDragState] = useState<{
    draggedId: string;
    dropTargetId: string | null;
    dropPosition: 'before' | 'after' | null;
  } | null>(null);

  const handlePinnedDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, commandId: string) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', commandId);
      requestAnimationFrame(() => {
        setDragState({ draggedId: commandId, dropTargetId: null, dropPosition: null });
      });
    },
    []
  );

  const handlePinnedDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, commandId: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';
      setDragState((prev) =>
        prev ? { ...prev, dropTargetId: commandId, dropPosition: position } : null
      );
    },
    []
  );

  const handlePinnedDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const ds = dragState;
      if (!ds?.draggedId || !ds.dropTargetId || ds.draggedId === ds.dropTargetId) {
        setDragState(null);
        return;
      }
      // Map display IDs back to pinned array IDs
      const fromIdx = pinnedCommands.indexOf(ds.draggedId);
      let toIdx = pinnedCommands.indexOf(ds.dropTargetId);
      if (fromIdx === -1 || toIdx === -1) {
        setDragState(null);
        return;
      }
      if (ds.dropPosition === 'after') toIdx += 1;
      if (fromIdx < toIdx) toIdx -= 1;
      if (fromIdx !== toIdx) {
        const next = [...pinnedCommands];
        const [item] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, item);
        await updatePinnedCommands(next);
      }
      setDragState(null);
    },
    [dragState, pinnedCommands, updatePinnedCommands]
  );

  const handlePinnedDragEnd = useCallback(() => {
    setDragState(null);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const onMouseDown = () => setContextMenu(null);
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [contextMenu]);

  useEffect(() => {
    if (!showActions) return;
    setSelectedActionIndex(0);
    setTimeout(() => actionsOverlayRef.current?.focus(), 0);
  }, [showActions]);

  useEffect(() => {
    if (!contextMenu) return;
    setSelectedContextActionIndex(0);
    setTimeout(() => contextMenuRef.current?.focus(), 0);
  }, [contextMenu]);

  useEffect(() => {
    if (!showActions && !contextMenu && !aiMode && !extensionView && !showClipboardManager && !showSnippetManager && !showFileSearch && !showCursorPrompt && !showWhisper && !showSpeak && !showOnboarding) {
      restoreLauncherFocus();
    }
  }, [showActions, contextMenu, aiMode, extensionView, showClipboardManager, showSnippetManager, showFileSearch, showCursorPrompt, showWhisper, showSpeak, showOnboarding, showWhisperOnboarding, restoreLauncherFocus]);

  const isLauncherModeActive =
    !showActions &&
    !contextMenu &&
    !aiMode &&
    !extensionView &&
    !showClipboardManager &&
    !showSnippetManager &&
    !showFileSearch &&
    !showCursorPrompt &&
    !showWhisper &&
    !showSpeak &&
    !showOnboarding &&
    !showWhisperOnboarding;

  useEffect(() => {
    if (!isLauncherModeActive) return;
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!e.metaKey || String(e.key || '').toLowerCase() !== 'k' || e.repeat) return;

      const target = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      const searchInput = inputRef.current;
      if (searchInput && (target === searchInput || active === searchInput)) return;

      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      e.preventDefault();
      e.stopPropagation();
      setContextMenu(null);
      setShowActions((prev) => !prev);
    };

    window.addEventListener('keydown', onWindowKeyDown, true);
    return () => window.removeEventListener('keydown', onWindowKeyDown, true);
  }, [isLauncherModeActive]);

  useEffect(() => {
    return () => {
      if (memoryFeedbackTimerRef.current !== null) {
        window.clearTimeout(memoryFeedbackTimerRef.current);
        memoryFeedbackTimerRef.current = null;
      }
    };
  }, []);

  const syncCalcResult = useMemo(() => {
    return searchQuery ? tryCalculate(searchQuery) : null;
  }, [searchQuery]);
  const [asyncCalcResult, setAsyncCalcResult] =
    useState<Awaited<ReturnType<typeof tryCalculateAsync>>>(null);
  useEffect(() => {
    calcRequestSeqRef.current += 1;
    const requestSeq = calcRequestSeqRef.current;

    if (!searchQuery || syncCalcResult) {
      setAsyncCalcResult(null);
      return;
    }

    const timer = window.setTimeout(() => {
      void tryCalculateAsync(searchQuery)
        .then((result) => {
          if (calcRequestSeqRef.current !== requestSeq) return;
          setAsyncCalcResult(result);
        })
        .catch(() => {
          if (calcRequestSeqRef.current !== requestSeq) return;
          setAsyncCalcResult(null);
        });
    }, 120);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchQuery, syncCalcResult]);
  const calcResult = syncCalcResult ?? asyncCalcResult;

  // ─── Bible verse lookup ─────────────────────────────────────────
  const bibleSeqRef = useRef(0);
  const [bibleResult, setBibleResult] = useState<BibleResult | null>(null);

  useEffect(() => {
    bibleSeqRef.current += 1;
    const seq = bibleSeqRef.current;

    // Skip if calculator already matched, or query is empty
    if (!searchQuery || calcResult) {
      setBibleResult(null);
      return;
    }

    // Quick synchronous check: does this look like a Bible reference?
    const ref = isBibleReference(searchQuery);
    if (!ref) {
      setBibleResult(null);
      return;
    }

    // Fetch the verse (may be instant if book is cached)
    void lookupBibleVerse(searchQuery).then((result) => {
      if (bibleSeqRef.current !== seq) return;
      setBibleResult(result);
    }).catch(() => {
      if (bibleSeqRef.current !== seq) return;
      setBibleResult(null);
    });
  }, [searchQuery, calcResult]);

  /** Number of special result cards shown above the command list */
  const calcOffset = (calcResult ? 1 : 0) + (bibleResult ? 1 : 0);

  // ─── Inline file search via Spotlight (home + iCloud Drive) ─────
  // Renderer-side icon cache ref — survives across searches without causing re-renders
  const iconCacheRef = useRef<Record<string, string>>({});

  /** Helper: run mdfind with head limit + 1s timeout (SIGALRM kills stale searches) */
  const mdfindLimited = useCallback((dir: string, query: string, limit: number) => {
    const shellEsc = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    // perl alarm(1) sends SIGALRM after 1s, killing mdfind if it's still running;
    // head closes the pipe via SIGPIPE once we have enough results.
    // Whichever fires first stops the search — guarantees <1s worst-case.
    const cmd = `perl -e 'alarm(1); exec @ARGV' -- mdfind -onlyin ${shellEsc(dir)} ${shellEsc(query)} | head -${limit}`;
    return window.electron.execCommand('sh', ['-c', cmd], { shell: false })
      .catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));
  }, []);

  /** Helper: merge paths, build InlineFileResult[], set state, load icons */
  const applyFileResults = useCallback((
    paths: string[],
    requestId: number,
    lowerTerms: string[],
  ) => {
    const filtered = paths.filter((p) => matchesAllTerms(fileBasename(p), lowerTerms));
    // Deduplicate
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const p of filtered) {
      if (!seen.has(p)) { seen.add(p); unique.push(p); }
    }
    // Rank by relevance and take top results
    unique.sort((a, b) => scoreFileResult(b, lowerTerms) - scoreFileResult(a, lowerTerms));
    const merged = unique.slice(0, 12);

    const results: InlineFileResult[] = merged.map((p) => ({
      path: p,
      name: fileBasename(p),
      dir: fileDirname(p),
      location: getFileLocation(p),
    }));

    if (fileSearchSeqRef.current !== requestId) return;
    setFileResults(results);

    // Seed with cached icons instantly
    const alreadyCached: Record<string, string> = {};
    const needFetch: InlineFileResult[] = [];
    for (const file of results) {
      const cached = iconCacheRef.current[file.path];
      if (cached) {
        alreadyCached[file.path] = cached;
      } else {
        needFetch.push(file);
      }
    }
    if (Object.keys(alreadyCached).length > 0) {
      setFileIcons((prev) => ({ ...prev, ...alreadyCached }));
    }

    // Fetch only missing icons (fire-and-forget, don't block)
    if (needFetch.length > 0) {
      Promise.all(
        needFetch.map(async (file) => {
          try {
            const dataUrl = await window.electron.getFileIconDataUrl(file.path, 20);
            return [file.path, dataUrl || ''] as const;
          } catch {
            return [file.path, ''] as const;
          }
        }),
      ).then((iconEntries) => {
        if (fileSearchSeqRef.current !== requestId) return;
        const newIcons: Record<string, string> = {};
        for (const [path, icon] of iconEntries) {
          if (icon) {
            newIcons[path] = icon;
            iconCacheRef.current[path] = icon;
          }
        }
        if (Object.keys(newIcons).length > 0) {
          setFileIcons((prev) => ({ ...prev, ...newIcons }));
        }
      });
    }
  }, []);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    fileSearchSeqRef.current += 1;
    const requestId = fileSearchSeqRef.current;

    if (!trimmed || trimmed.length < 2) {
      setFileResults([]);
      mdfindCacheRef.current = { query: '', rawPaths: [] };
      return;
    }

    const lowerTerms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);

    // ── Fast path: query is a refinement of cached query → filter instantly, no mdfind.
    const cached = mdfindCacheRef.current;
    if (
      cached.query &&
      cached.rawPaths.length > 0 &&
      trimmed.toLowerCase().startsWith(cached.query.toLowerCase())
    ) {
      applyFileResults(cached.rawPaths, requestId, lowerTerms);
      return; // no timer to clean up
    }

    // ── Slow path: new/different query → run mdfind (debounced 30ms)
    const timer = window.setTimeout(async () => {
      try {
        const homeDir = (window.electron as any).homeDir || '/';
        const icloudPath = homeDir + ICLOUD_DRIVE_SUBPATH;
        const spotlightQuery = buildInlineSpotlightQuery(trimmed);

        const parsePaths = (stdout: string): string[] =>
          stdout.split('\n').map((l) => l.trim()).filter(Boolean);

        const homePromise = mdfindLimited(homeDir, spotlightQuery, 50);
        const icloudPromise = mdfindLimited(icloudPath, spotlightQuery, 30);

        let homePaths: string[] = [];
        let icloudPaths: string[] = [];

        const showMerged = () => {
          const combined = [...icloudPaths, ...homePaths];
          // Cache raw paths so subsequent refinements are instant
          mdfindCacheRef.current = { query: trimmed, rawPaths: combined };
          applyFileResults(combined, requestId, lowerTerms);
        };

        // Render as EACH search completes — not just the first
        homePromise.then((res) => {
          if (fileSearchSeqRef.current !== requestId) return;
          homePaths = parsePaths(res.stdout);
          showMerged();
        });

        icloudPromise.then((res) => {
          if (fileSearchSeqRef.current !== requestId) return;
          icloudPaths = parsePaths(res.stdout);
          showMerged();
        });

        // Final merge once both are done
        await Promise.all([homePromise, icloudPromise]);
        if (fileSearchSeqRef.current !== requestId) return;
        showMerged();
      } catch (error) {
        console.error('Inline file search failed:', error);
        if (fileSearchSeqRef.current === requestId) {
          setFileResults([]);
        }
      }
    }, 30);

    return () => window.clearTimeout(timer);
  }, [searchQuery, mdfindLimited, applyFileResults]);

  const contextualCommands = commands;
  const filteredCommands = useMemo(
    () => filterCommands(contextualCommands, searchQuery),
    [contextualCommands, searchQuery]
  );

  // When calculator/bible is showing but no commands match, show unfiltered list below
  const sourceCommands =
    (calcResult || bibleResult) && filteredCommands.length === 0 ? contextualCommands : filteredCommands;

  const groupedCommands = useMemo(() => {
    const sourceMap = new Map(sourceCommands.map((cmd) => [cmd.id, cmd]));
    const hasSelection = selectedTextSnapshot.trim().length > 0;
    const contextual = hasSelection
      ? (sourceMap.get('system-add-to-memory') ? [sourceMap.get('system-add-to-memory') as CommandInfo] : [])
      : [];
    const contextualIds = new Set(contextual.map((c) => c.id));

    const lowerQuery = searchQuery.toLowerCase().trim();

    const pinned = pinnedCommands
      .map((id): CommandInfo | null => {
        if (isPinnedFileId(id)) {
          const fileItem = pinnedFiles.get(id);
          if (!fileItem) return null;
          // When searching, filter pinned files that don't match
          if (lowerQuery) {
            const lowerName = fileItem.name.toLowerCase();
            if (!lowerName.includes(lowerQuery)) return null;
          }
          return pinnedFileToCommandInfo(fileItem);
        }
        const cmd = sourceMap.get(id);
        if (!cmd || contextualIds.has(id)) return null;
        return cmd;
      })
      .filter((cmd): cmd is CommandInfo => cmd !== null);
    const pinnedSet = new Set(pinned.map((c) => c.id));

    const recent = recentCommands
      .map((id) => sourceMap.get(id))
      .filter(
        (c): c is CommandInfo =>
          Boolean(c) &&
          !pinnedSet.has((c as CommandInfo).id) &&
          !contextualIds.has((c as CommandInfo).id)
      );
    const recentSet = new Set(recent.map((c) => c.id));

    const other = sourceCommands.filter(
      (c) => !pinnedSet.has(c.id) && !recentSet.has(c.id) && !contextualIds.has(c.id)
    );

    return { contextual, pinned, recent, other };
  }, [sourceCommands, pinnedCommands, pinnedFiles, recentCommands, selectedTextSnapshot, searchQuery]);

  const displayCommands = useMemo(
    () => [
      ...groupedCommands.contextual,
      ...groupedCommands.pinned,
      ...groupedCommands.recent,
      ...groupedCommands.other,
    ],
    [groupedCommands]
  );

  // Filter out already-pinned files from inline results to avoid duplication
  const unpinnedFileResults = useMemo(
    () => fileResults.filter((f) => !pinnedCommands.includes(pathToPinnedFileId(f.path))),
    [fileResults, pinnedCommands]
  );

  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, displayCommands.length + calcOffset + unpinnedFileResults.length);
  }, [displayCommands.length, calcOffset, unpinnedFileResults.length]);

  const scrollToSelected = useCallback(() => {
    const selectedElement = itemRefs.current[selectedIndex];
    const scrollContainer = listRef.current;

    if (selectedElement && scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const elementRect = selectedElement.getBoundingClientRect();

      if (elementRect.top < containerRect.top) {
        selectedElement.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } else if (elementRect.bottom > containerRect.bottom) {
        selectedElement.scrollIntoView({ block: 'end', behavior: 'smooth' });
      }
    }
  }, [selectedIndex]);

  useEffect(() => {
    scrollToSelected();
  }, [selectedIndex, scrollToSelected]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    const max = Math.max(0, displayCommands.length + calcOffset + unpinnedFileResults.length - 1);
    setSelectedIndex((prev) => (prev > max ? max : prev));
  }, [displayCommands.length, calcOffset, unpinnedFileResults.length]);

  const selectedCommand =
    selectedIndex >= calcOffset && selectedIndex < calcOffset + displayCommands.length
      ? displayCommands[selectedIndex - calcOffset]
      : null;

  const selectedFile =
    selectedIndex >= calcOffset + displayCommands.length
      ? unpinnedFileResults[selectedIndex - calcOffset - displayCommands.length] || null
      : null;

  const openFileResult = useCallback(async (filePath: string) => {
    try {
      await window.electron.execCommand('open', [filePath]);
      await window.electron.hideWindow();
      setSearchQuery('');
      setSelectedIndex(0);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  }, []);

  const togglePinSelectedCommand = useCallback(async () => {
    if (selectedCommand) {
      if (selectedCommand.category === 'file') {
        await pinToggleForFile(pinnedFileIdToPath(selectedCommand.id));
      } else {
        await pinToggleForCommand(selectedCommand);
      }
    } else if (selectedFile) {
      await pinToggleForFile(selectedFile.path);
    }
  }, [selectedCommand, selectedFile, pinToggleForCommand, pinToggleForFile]);

  const disableSelectedCommand = useCallback(async () => {
    if (!selectedCommand) return;
    await disableCommand(selectedCommand);
  }, [selectedCommand, disableCommand]);

  const uninstallSelectedExtension = useCallback(async () => {
    if (!selectedCommand) return;
    await uninstallExtensionCommand(selectedCommand);
  }, [selectedCommand, uninstallExtensionCommand]);

  const moveSelectedPinnedCommand = useCallback(
    async (direction: 'up' | 'down') => {
      if (!selectedCommand) return;
      await movePinnedCommand(selectedCommand, direction);
    },
    [selectedCommand, movePinnedCommand]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.metaKey && (e.key === 'k' || e.key === 'K') && !e.repeat) {
        e.preventDefault();
        setShowActions((prev) => !prev);
        setContextMenu(null);
        return;
      }
      if (showActions || contextMenu) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (showActions) setShowActions(false);
          if (contextMenu) setContextMenu(null);
          restoreLauncherFocus();
        }
        return;
      }
      if (e.metaKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        togglePinSelectedCommand();
        return;
      }
      if (e.metaKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        disableSelectedCommand();
        return;
      }
      if (e.metaKey && (e.key === 'Backspace' || e.key === 'Delete')) {
        if (selectedCommand?.category === 'extension') {
          e.preventDefault();
          uninstallSelectedExtension();
          return;
        }
      }
      if (e.metaKey && e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelectedPinnedCommand('up');
        return;
      }
      if (e.metaKey && e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelectedPinnedCommand('down');
        return;
      }

      switch (e.key) {
        case 'Tab':
          if (searchQuery.trim() && aiAvailable) {
            e.preventDefault();
            startAiChat(searchQuery);
          }
          break;

        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => {
            const max = displayCommands.length + calcOffset + unpinnedFileResults.length - 1;
            return prev < max ? prev + 1 : prev;
          });
          break;

        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
          break;

        case 'Enter':
          e.preventDefault();
          if (calcResult && selectedIndex === 0) {
            navigator.clipboard.writeText(calcResult.result);
            window.electron.hideWindow();
          } else if (bibleResult && selectedIndex === (calcResult ? 1 : 0)) {
            navigator.clipboard.writeText(bibleResult.verseText);
            window.electron.hideWindow();
          } else if (selectedIndex < calcOffset + displayCommands.length && displayCommands[selectedIndex - calcOffset]) {
            handleCommandExecute(displayCommands[selectedIndex - calcOffset]);
          } else {
            // File result selected
            const fileIdx = selectedIndex - calcOffset - displayCommands.length;
            const file = unpinnedFileResults[fileIdx];
            if (file) {
              openFileResult(file.path);
            }
          }
          break;

        case 'Escape':
          e.preventDefault();
          if (contextMenu) {
            setContextMenu(null);
            return;
          }
          if (showActions) {
            setShowActions(false);
            return;
          }
          setSearchQuery('');
          setSelectedIndex(0);
          window.electron.hideWindow();
          break;
      }
    },
    [
      displayCommands,
      selectedIndex,
      searchQuery,
      aiAvailable,
      startAiChat,
      calcResult,
      bibleResult,
      calcOffset,
      unpinnedFileResults,
      openFileResult,
      togglePinSelectedCommand,
      disableSelectedCommand,
      uninstallSelectedExtension,
      moveSelectedPinnedCommand,
      selectedCommand,
      contextMenu,
      showActions,
    ]
  );

  const runLocalSystemCommand = useCallback(async (commandId: string): Promise<boolean> => {
    if (commandId === 'system-open-onboarding') {
      await window.electron.setLauncherMode('onboarding');
      whisperSessionRef.current = false;
      openOnboarding();
      return true;
    }
    if (commandId === 'system-whisper-onboarding') {
      await window.electron.setLauncherMode('onboarding');
      whisperSessionRef.current = false;
      openOnboarding();
      return true;
    }
    if (commandId === 'system-clipboard-manager') {
      whisperSessionRef.current = false;
      openClipboardManager();
      return true;
    }
    if (commandId === 'system-search-snippets') {
      whisperSessionRef.current = false;
      openSnippetManager('search');
      return true;
    }
    if (commandId === 'system-create-snippet') {
      whisperSessionRef.current = false;
      openSnippetManager('create');
      return true;
    }
    if (commandId === 'system-search-files') {
      whisperSessionRef.current = false;
      openFileSearch();
      return true;
    }
    if (commandId === 'system-add-to-memory') {
      if (memoryActionLoading) return true;
      setMemoryActionLoading(true);
      setMemoryFeedback(null);
      const selectedText = String(await window.electron.getSelectedTextStrict() || '').trim();
      if (!selectedText) {
        setSelectedTextSnapshot('');
        setMemoryActionLoading(false);
        showMemoryFeedback('error', 'No selected text found.');
        return true;
      }
      try {
        const result = await window.electron.memoryAdd({
          text: selectedText,
          source: 'launcher-selection',
        });
        if (!result.success) {
          console.error('[Supermemory] Failed to add memory:', result.error || 'Unknown error');
          showMemoryFeedback('error', result.error || 'Failed to add to memory.');
          return true;
        }
        setSelectedTextSnapshot('');
        setSearchQuery('');
        setSelectedIndex(0);
        showMemoryFeedback('success', 'Added selected text to memory.');
      } finally {
        setMemoryActionLoading(false);
      }
      return true;
    }
    if (commandId === 'system-cursor-prompt') {
      await window.electron.executeCommand(commandId);
      return true;
    }
    if (commandId === 'system-supercmd-whisper') {
      whisperSessionRef.current = true;
      if (showOnboarding) {
        setShowWhisper(true);
        setShowWhisperOnboarding(true);
        setShowWhisperHint(true);
        return true;
      }
      openWhisper();
      return true;
    }
    if (commandId === 'system-supercmd-speak') {
      whisperSessionRef.current = false;
      if (showOnboarding) {
        setShowSpeak(true);
        return true;
      }
      openSpeak();
      return true;
    }
    if (commandId === 'system-supercmd-speak-close') {
      setShowSpeak(false);
      return true;
    }
    if (commandId === 'system-import-snippets') {
      await window.electron.snippetImport();
      return true;
    }
    if (commandId === 'system-export-snippets') {
      await window.electron.snippetExport();
      return true;
    }
    return false;
  }, [memoryActionLoading, showMemoryFeedback, showOnboarding, openOnboarding, openWhisper, setShowWhisper, setShowWhisperOnboarding, setShowWhisperHint, openClipboardManager, openSnippetManager, openFileSearch, openSpeak, setShowSpeak]);

  useEffect(() => {
    const cleanup = window.electron.onRunSystemCommand(async (commandId: string) => {
      try {
        await runLocalSystemCommand(commandId);
      } catch (error) {
        console.error('Failed to run system command from main process:', error);
      }
    });
    return cleanup;
  }, [runLocalSystemCommand]);

  useEffect(() => {
    const cleanup = window.electron.onOnboardingHotkeyPressed(() => {
      setOnboardingHotkeyPresses((prev) => prev + 1);
    });
    return cleanup;
  }, []);

  const runScriptCommand = useCallback(
    async (
      command: CommandInfo,
      values?: Record<string, any>,
      options?: { background?: boolean; skipRecent?: boolean }
    ) => {
      const payload = {
        commandId: command.id,
        arguments: values || {},
        background: Boolean(options?.background),
      };
      const result = await window.electron.runScriptCommand(payload);

      if (!result) return false;

      if (result.needsArguments) {
        if (!options?.background) {
          setShowFileSearch(false);
          setScriptCommandSetup({
            command,
            values: {
              ...readJsonObject(getScriptCmdArgsKey(command.id)),
              ...(values || {}),
            },
          });
        }
        return false;
      }

      if (result.mode === 'fullOutput') {
        setShowFileSearch(false);
        setScriptCommandOutput({
          command,
          output: String(result.output || result.stdout || result.stderr || '').trim(),
          exitCode: Number(result.exitCode || 0),
        });
      } else if (result.mode === 'inline') {
        await fetchCommands();
      } else if (!options?.background) {
        await window.electron.hideWindow();
        setSearchQuery('');
        setSelectedIndex(0);
      }

      if (!options?.background && !options?.skipRecent) {
        await updateRecentCommands(command.id);
      }

      return Boolean(result.success);
    },
    [fetchCommands, updateRecentCommands]
  );

  const handleCommandExecute = async (command: CommandInfo) => {
    try {
      // Pinned file — open directly
      if (command.category === 'file' && command.path) {
        await openFileResult(command.path);
        return;
      }

      if (await runLocalSystemCommand(command.id)) {
        await updateRecentCommands(command.id);
        return;
      }

      if (command.category === 'extension' && command.path) {
        // Extension command — build and show extension view
        const [extName, cmdName] = command.path.split('/');
        const result = await window.electron.runExtension(extName, cmdName);
        if (result && result.code) {
          const hydrated = hydrateExtensionBundlePreferences(result);
          if (shouldOpenCommandSetup(hydrated)) {
            setShowFileSearch(false);
            setExtensionPreferenceSetup({
              bundle: hydrated,
              values: { ...(hydrated.preferences || {}) },
              argumentValues: { ...((hydrated as any).launchArguments || {}) },
            });
            return;
          }

          // Menu-bar commands run in the hidden tray runners, not in the overlay.
          // Toggle behavior matches Raycast: running the same menu-bar command again hides it.
          if (hydrated.mode === 'menu-bar') {
            if (isMenuBarExtensionMounted(hydrated)) {
              hideMenuBarExtension(hydrated);
            } else {
              upsertMenuBarExtension(hydrated);
            }
            window.electron.hideWindow();
            setSearchQuery('');
            setSelectedIndex(0);
            await updateRecentCommands(command.id);
            return;
          }
          setShowFileSearch(false);
          setExtensionView(hydrated);
          if (hydrated.mode === 'view') {
            localStorage.setItem(LAST_EXT_KEY, JSON.stringify({ extName, cmdName }));
          } else {
            localStorage.removeItem(LAST_EXT_KEY);
          }
          await updateRecentCommands(command.id);
          return;
        }
        const errMsg = result?.error || 'Failed to build extension';
        console.error('Extension load failed:', errMsg);
        // Show the error in the extension view
        setShowFileSearch(false);
        setExtensionView({
          code: '',
          title: command.title,
          mode: 'view',
          extName,
          cmdName,
          error: errMsg,
        } as any);
        return;
      }

      if (command.category === 'script') {
        if (command.needsConfirmation) {
          const ok = window.confirm(`Run "${command.title}"?`);
          if (!ok) return;
        }
        const storedArgs = readJsonObject(getScriptCmdArgsKey(command.id));
        const missing = getMissingRequiredScriptArguments(command, storedArgs);
        if (missing.length > 0) {
          setShowFileSearch(false);
          setScriptCommandSetup({
            command,
            values: { ...storedArgs },
          });
          return;
        }
        await runScriptCommand(command, storedArgs);
        return;
      }

      await window.electron.executeCommand(command.id);
      await updateRecentCommands(command.id);
      setSearchQuery('');
      setSelectedIndex(0);
    } catch (error) {
      console.error('Failed to execute command:', error);
    }
  };

  const getActionsForCommand = useCallback(
    (command: CommandInfo | null): LauncherAction[] => {
      if (!command) return [];

      // File items get a simpler action set
      if (command.category === 'file') {
        const filePath = command.path || pinnedFileIdToPath(command.id);
        const isPinned = pinnedCommands.includes(isPinnedFileId(command.id) ? command.id : pathToPinnedFileId(filePath));
        const pinnedId = isPinnedFileId(command.id) ? command.id : pathToPinnedFileId(filePath);
        const pinnedIndex = pinnedCommands.indexOf(pinnedId);
        return [
          {
            id: 'open',
            title: 'Open File',
            shortcut: 'Enter',
            execute: () => openFileResult(filePath),
          },
          {
            id: 'pin',
            title: isPinned ? 'Unpin File' : 'Pin File',
            shortcut: 'Cmd+Shift+P',
            execute: () => pinToggleForFile(filePath),
          },
          {
            id: 'move-up',
            title: 'Move Up',
            shortcut: 'Cmd+Alt+Up',
            enabled: isPinned && pinnedIndex > 0,
            execute: () => movePinnedCommand(command, 'up'),
          },
          {
            id: 'move-down',
            title: 'Move Down',
            shortcut: 'Cmd+Alt+Down',
            enabled: isPinned && pinnedIndex >= 0 && pinnedIndex < pinnedCommands.length - 1,
            execute: () => movePinnedCommand(command, 'down'),
          },
        ].filter((action) => action.enabled !== false);
      }

      const isPinned = pinnedCommands.includes(command.id);
      const pinnedIndex = pinnedCommands.indexOf(command.id);
      return [
        {
          id: 'open',
          title: 'Open Command',
          shortcut: 'Enter',
          execute: () => handleCommandExecute(command),
        },
        {
          id: 'pin',
          title: isPinned
            ? 'Unpin Extension'
            : command.category === 'extension'
              ? 'Pin Extension'
              : 'Pin Command',
          shortcut: 'Cmd+Shift+P',
          execute: () => pinToggleForCommand(command),
        },
        {
          id: 'disable',
          title: 'Disable Command',
          shortcut: 'Cmd+Shift+D',
          execute: () => disableCommand(command),
        },
        {
          id: 'uninstall',
          title: 'Uninstall',
          shortcut: 'Cmd+Delete',
          style: 'destructive',
          enabled: command.category === 'extension',
          execute: () => uninstallExtensionCommand(command),
        },
        {
          id: 'move-up',
          title: 'Move Up',
          shortcut: 'Cmd+Alt+Up',
          enabled: isPinned && pinnedIndex > 0,
          execute: () => movePinnedCommand(command, 'up'),
        },
        {
          id: 'move-down',
          title: 'Move Down',
          shortcut: 'Cmd+Alt+Down',
          enabled: isPinned && pinnedIndex >= 0 && pinnedIndex < pinnedCommands.length - 1,
          execute: () => movePinnedCommand(command, 'down'),
        },
      ].filter((action) => action.enabled !== false);
    },
    [
      pinnedCommands,
      handleCommandExecute,
      pinToggleForCommand,
      pinToggleForFile,
      openFileResult,
      disableCommand,
      uninstallExtensionCommand,
      movePinnedCommand,
    ]
  );

  const selectedActions = useMemo(() => {
    if (selectedCommand) return getActionsForCommand(selectedCommand);
    // When a file result is selected, build a synthetic CommandInfo for actions
    if (selectedFile) {
      const syntheticCmd: CommandInfo = {
        id: pathToPinnedFileId(selectedFile.path),
        title: selectedFile.name,
        subtitle: selectedFile.location,
        iconDataUrl: fileIcons[selectedFile.path],
        category: 'file',
        path: selectedFile.path,
      };
      return getActionsForCommand(syntheticCmd);
    }
    return [];
  }, [getActionsForCommand, selectedCommand, selectedFile, fileIcons]);

  const contextCommand = useMemo(() => {
    if (!contextMenu) return null;
    const cmdId = contextMenu.commandId;

    // Check display commands first (includes pinned files already converted to CommandInfo)
    const found = displayCommands.find((cmd) => cmd.id === cmdId);
    if (found) return found;

    // Handle file IDs from inline file results (not yet pinned)
    if (isPinnedFileId(cmdId)) {
      const filePath = pinnedFileIdToPath(cmdId);
      const inlineResult = fileResults.find((f) => f.path === filePath);
      if (inlineResult) {
        return {
          id: cmdId,
          title: inlineResult.name,
          subtitle: inlineResult.location,
          iconDataUrl: fileIcons[inlineResult.path],
          category: 'file' as const,
          path: filePath,
        };
      }
    }

    return null;
  }, [contextMenu, displayCommands, fileResults, fileIcons]);

  const contextActions = useMemo(
    () => getActionsForCommand(contextCommand),
    [getActionsForCommand, contextCommand]
  );

  const handleActionsOverlayKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (selectedActions.length === 0) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedActionIndex((prev) =>
            Math.min(prev + 1, selectedActions.length - 1)
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedActionIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          await Promise.resolve(selectedActions[selectedActionIndex]?.execute());
          setShowActions(false);
          restoreLauncherFocus();
          break;
        case 'Escape':
          e.preventDefault();
          setShowActions(false);
          restoreLauncherFocus();
          break;
      }
    },
    [selectedActions, selectedActionIndex, restoreLauncherFocus]
  );

  const handleContextMenuKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (contextActions.length === 0) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedContextActionIndex((prev) =>
            Math.min(prev + 1, contextActions.length - 1)
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedContextActionIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          await Promise.resolve(contextActions[selectedContextActionIndex]?.execute());
          setContextMenu(null);
          restoreLauncherFocus();
          break;
        case 'Escape':
          e.preventDefault();
          setContextMenu(null);
          restoreLauncherFocus();
          break;
      }
    },
    [contextActions, selectedContextActionIndex, restoreLauncherFocus]
  );

  // ─── Hidden menu-bar extension runners (always mounted) ────────────
  // These run "invisibly" so that menu-bar extensions produce native Tray
  // menus via IPC even when the main window is hidden.
  const menuBarRunner = menuBarExtensions.length > 0 ? (
    <div style={{ display: 'none', position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {menuBarExtensions.map((entry) => (
        <ExtensionView
          key={`menubar-${entry.key}`}
          code={entry.bundle.code}
          title={entry.bundle.title}
          mode="menu-bar"
          extensionName={(entry.bundle as any).extensionName || entry.bundle.extName}
          extensionDisplayName={(entry.bundle as any).extensionDisplayName}
          extensionIconDataUrl={(entry.bundle as any).extensionIconDataUrl}
          commandName={(entry.bundle as any).commandName || entry.bundle.cmdName}
          assetsPath={(entry.bundle as any).assetsPath}
          supportPath={(entry.bundle as any).supportPath}
          owner={(entry.bundle as any).owner}
          preferences={(entry.bundle as any).preferences}
          launchArguments={(entry.bundle as any).launchArguments}
          launchContext={(entry.bundle as any).launchContext}
          fallbackText={(entry.bundle as any).fallbackText}
          launchType={(entry.bundle as any).launchType}
          onClose={() => {}}
        />
      ))}
    </div>
  ) : null;

  const backgroundNoViewRunner = backgroundNoViewRuns.length > 0 ? (
    <div style={{ display: 'none', position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {backgroundNoViewRuns.map((run) => (
        <ExtensionView
          key={`bg-no-view-${run.runId}`}
          code={run.bundle.code}
          title={run.bundle.title}
          mode="no-view"
          extensionName={(run.bundle as any).extensionName || run.bundle.extName}
          extensionDisplayName={(run.bundle as any).extensionDisplayName}
          extensionIconDataUrl={(run.bundle as any).extensionIconDataUrl}
          commandName={(run.bundle as any).commandName || run.bundle.cmdName}
          assetsPath={(run.bundle as any).assetsPath}
          supportPath={(run.bundle as any).supportPath}
          owner={(run.bundle as any).owner}
          preferences={(run.bundle as any).preferences}
          launchArguments={(run.bundle as any).launchArguments}
          launchContext={(run.bundle as any).launchContext}
          fallbackText={(run.bundle as any).fallbackText}
          launchType="background"
          onClose={() => {
            setBackgroundNoViewRuns((prev) => prev.filter((item) => item.runId !== run.runId));
          }}
        />
      ))}
    </div>
  ) : null;

  const hiddenExtensionRunners = (
    <>
      {menuBarRunner}
      {backgroundNoViewRunner}
    </>
  );

  const detachedOverlayRunners = (
    <>
      {showWhisper && whisperPortalTarget ? (
        <SuperCmdWhisper
          portalTarget={whisperPortalTarget}
          onboardingCaptureMode={showWhisperOnboarding}
          onOnboardingTranscriptAppend={appendWhisperOnboardingPracticeText}
          coachmarkText={
            showWhisperHint
              ? `Whisper sits here. Hold ${whisperSpeakToggleLabel} to talk, release to type.`
              : undefined
          }
          onClose={() => {
            whisperSessionRef.current = false;
            setShowWhisper(false);
            setShowWhisperOnboarding(false);
            setShowWhisperHint(false);
          }}
        />
      ) : null}
      {showSpeak && speakPortalTarget ? (
        <SuperCmdRead
          status={speakStatus}
          voice={speakOptions.voice}
          voiceOptions={readVoiceOptions}
          rate={speakOptions.rate}
          portalTarget={speakPortalTarget}
          onVoiceChange={handleSpeakVoiceChange}
          onRateChange={handleSpeakRateChange}
          onClose={() => {
            setShowSpeak(false);
            void window.electron.speakStop();
          }}
        />
      ) : null}
      {showCursorPrompt && cursorPromptPortalTarget
        ? createPortal(
            <CursorPromptView
              variant="portal"
              cursorPromptText={cursorPromptText}
              setCursorPromptText={setCursorPromptText}
              cursorPromptStatus={cursorPromptStatus}
              cursorPromptResult={cursorPromptResult}
              cursorPromptError={cursorPromptError}
              cursorPromptInputRef={cursorPromptInputRef}
              aiAvailable={aiAvailable}
              submitCursorPrompt={submitCursorPrompt}
              closeCursorPrompt={closeCursorPrompt}
              acceptCursorPrompt={acceptCursorPrompt}
            />,
            cursorPromptPortalTarget
          )
        : null}
    </>
  );

  const alwaysMountedRunners = (
    <>
      {hiddenExtensionRunners}
      {detachedOverlayRunners}
    </>
  );

  // ─── Script Command Setup ───────────────────────────────────────
  if (scriptCommandSetup) {
    return (
      <ScriptCommandSetupView
        setup={scriptCommandSetup}
        alwaysMountedRunners={alwaysMountedRunners}
        onBack={() => {
          setScriptCommandSetup(null);
          setSearchQuery('');
          setSelectedIndex(0);
        }}
        onContinue={(command, values) => {
          setScriptCommandSetup(null);
          void runScriptCommand(command, values);
        }}
        setScriptCommandSetup={setScriptCommandSetup}
      />
    );
  }

  // ─── Script Output ──────────────────────────────────────────────
  if (scriptCommandOutput) {
    return (
      <ScriptCommandOutputView
        output={scriptCommandOutput}
        alwaysMountedRunners={alwaysMountedRunners}
        onBack={() => {
          setScriptCommandOutput(null);
          setSearchQuery('');
          setSelectedIndex(0);
        }}
      />
    );
  }

  // ─── Extension Preferences Setup ────────────────────────────────
  if (extensionPreferenceSetup) {
    return (
      <ExtensionPreferenceSetupView
        setup={extensionPreferenceSetup}
        alwaysMountedRunners={alwaysMountedRunners}
        onBack={() => {
          setExtensionPreferenceSetup(null);
          setScriptCommandSetup(null);
          setScriptCommandOutput(null);
          setSearchQuery('');
          setSelectedIndex(0);
        }}
        onLaunchExtension={(updatedBundle) => {
          setExtensionPreferenceSetup(null);
          setScriptCommandSetup(null);
          setScriptCommandOutput(null);
          setExtensionView(updatedBundle);
          const extName = updatedBundle.extName || (updatedBundle as any).extensionName || '';
          const cmdName = updatedBundle.cmdName || (updatedBundle as any).commandName || '';
          if (updatedBundle.mode === 'view') {
            localStorage.setItem(LAST_EXT_KEY, JSON.stringify({ extName, cmdName }));
          } else {
            localStorage.removeItem(LAST_EXT_KEY);
          }
        }}
        onLaunchMenuBar={(updatedBundle) => {
          setExtensionPreferenceSetup(null);
          setScriptCommandSetup(null);
          setScriptCommandOutput(null);
          if (isMenuBarExtensionMounted(updatedBundle)) {
            hideMenuBarExtension(updatedBundle);
          } else {
            upsertMenuBarExtension(updatedBundle);
          }
          window.electron.hideWindow();
          setSearchQuery('');
          setSelectedIndex(0);
          localStorage.removeItem(LAST_EXT_KEY);
        }}
        setExtensionPreferenceSetup={setExtensionPreferenceSetup}
      />
    );
  }

  // ─── Extension view mode ──────────────────────────────────────────
  if (extensionView) {
    return (
      <>
        {alwaysMountedRunners}
        <div className="w-full h-full">
          <div className="glass-effect overflow-hidden h-full flex flex-col">
            <ExtensionView
              code={extensionView.code}
              title={extensionView.title}
              mode={extensionView.mode}
              error={(extensionView as any).error}
              extensionName={(extensionView as any).extensionName || extensionView.extName}
              extensionDisplayName={(extensionView as any).extensionDisplayName}
              extensionIconDataUrl={(extensionView as any).extensionIconDataUrl}
              commandName={(extensionView as any).commandName || extensionView.cmdName}
              assetsPath={(extensionView as any).assetsPath}
              supportPath={(extensionView as any).supportPath}
              owner={(extensionView as any).owner}
              preferences={(extensionView as any).preferences}
              launchArguments={(extensionView as any).launchArguments}
              launchContext={(extensionView as any).launchContext}
              fallbackText={(extensionView as any).fallbackText}
              launchType={(extensionView as any).launchType}
              onClose={() => {
                setExtensionView(null);
                localStorage.removeItem(LAST_EXT_KEY);
                setSearchQuery('');
                setSelectedIndex(0);
                setTimeout(() => inputRef.current?.focus(), 50);
              }}
            />
          </div>
        </div>
      </>
    );
  }

  // ─── Clipboard Manager mode ───────────────────────────────────────
  if (showClipboardManager) {
    return (
      <>
        {alwaysMountedRunners}
        <div className="w-full h-full">
          <div className="glass-effect overflow-hidden h-full flex flex-col">
            <ClipboardManager
              onClose={() => {
                setShowClipboardManager(false);
                setSearchQuery('');
                setSelectedIndex(0);
                setTimeout(() => inputRef.current?.focus(), 50);
              }}
            />
          </div>
        </div>
      </>
    );
  }

  // ─── Cursor Prompt mode ───────────────────────────────────────────
  if (showCursorPrompt && !cursorPromptPortalTarget) {
    return (
      <CursorPromptView
        variant="inline"
        cursorPromptText={cursorPromptText}
        setCursorPromptText={setCursorPromptText}
        cursorPromptStatus={cursorPromptStatus}
        cursorPromptResult={cursorPromptResult}
        cursorPromptError={cursorPromptError}
        cursorPromptInputRef={cursorPromptInputRef}
        aiAvailable={aiAvailable}
        submitCursorPrompt={submitCursorPrompt}
        closeCursorPrompt={closeCursorPrompt}
        acceptCursorPrompt={acceptCursorPrompt}
        alwaysMountedRunners={alwaysMountedRunners}
      />
    );
  }

  // ─── Snippet Manager mode ─────────────────────────────────────────
  if (showSnippetManager) {
    return (
      <>
        {alwaysMountedRunners}
        <div className="w-full h-full">
          <div className="glass-effect overflow-hidden h-full flex flex-col">
            <SnippetManager
              initialView={showSnippetManager}
              onClose={() => {
                setShowSnippetManager(null);
                setSearchQuery('');
                setSelectedIndex(0);
                setTimeout(() => inputRef.current?.focus(), 50);
              }}
            />
          </div>
        </div>
      </>
    );
  }

  // ─── File Search mode ─────────────────────────────────────────────
  if (showFileSearch) {
    return (
      <>
        {alwaysMountedRunners}
        <div className="w-full h-full">
          <div className="glass-effect overflow-hidden h-full flex flex-col">
            <FileSearchExtension
              onClose={() => {
                setShowFileSearch(false);
                setSearchQuery('');
                setSelectedIndex(0);
                setTimeout(() => inputRef.current?.focus(), 50);
              }}
            />
          </div>
        </div>
      </>
    );
  }

  // ─── AI Chat mode ──────────────────────────────────────────────
  if (aiMode) {
    return (
      <AiChatView
        alwaysMountedRunners={alwaysMountedRunners}
        aiQuery={aiQuery}
        setAiQuery={setAiQuery}
        aiResponse={aiResponse}
        aiStreaming={aiStreaming}
        aiInputRef={aiInputRef as React.RefObject<HTMLInputElement>}
        aiResponseRef={aiResponseRef as React.RefObject<HTMLDivElement>}
        submitAiQuery={submitAiQuery}
        exitAiMode={exitAiMode}
      />
    );
  }

  // ─── Onboarding mode ───────────────────────────────────────────
  if (showOnboarding) {
    return (
      <>
        {alwaysMountedRunners}
        <OnboardingExtension
          initialShortcut={launcherShortcut}
          requireWorkingShortcut={onboardingRequiresShortcutFix}
          dictationPracticeText={whisperOnboardingPracticeText}
          onDictationPracticeTextChange={setWhisperOnboardingPracticeText}
          onboardingHotkeyPresses={onboardingHotkeyPresses}
          onClose={async () => {
            await window.electron.setLauncherMode('onboarding');
            setShowOnboarding(true);
          }}
          onComplete={async () => {
            await window.electron.setLauncherMode('default');
            await window.electron.saveSettings({ hasSeenOnboarding: true, hasSeenWhisperOnboarding: true });
            setShowOnboarding(false);
            setShowWhisperOnboarding(false);
            setOnboardingRequiresShortcutFix(false);
            setSearchQuery('');
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 50);
          }}
        />
      </>
    );
  }

  // ─── Launcher mode ──────────────────────────────────────────────
  return (
    <>
    {alwaysMountedRunners}
    <div className="w-full h-full">
      <div className="glass-effect overflow-hidden h-full flex flex-col">
        {/* Search header - transparent background */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-white/[0.06]">
          <input
            ref={inputRef}
            type="text"
            placeholder="Search apps, files, and settings..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent border-none outline-none text-white/95 placeholder-white/45 text-[15px] font-medium tracking-[0.005em]"
            autoFocus
          />
          {searchQuery && aiAvailable && (
            <button
              onClick={() => startAiChat(searchQuery)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/[0.06] hover:bg-white/[0.10] transition-colors flex-shrink-0 group"
            >
              <Sparkles className="w-3 h-3 text-white/30 group-hover:text-purple-400 transition-colors" />
              <span className="text-[11px] text-white/30 group-hover:text-white/50 transition-colors">Ask AI</span>
              <kbd className="text-[10px] text-white/20 bg-white/[0.06] px-1 py-0.5 rounded font-mono leading-none">Tab</kbd>
            </button>
          )}
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="text-white/30 hover:text-white/60 transition-colors flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Command list */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto custom-scrollbar p-1.5 list-area"
        >
          {isLoading ? (
            <div className="flex items-center justify-center h-full text-white/50">
              <p className="text-sm">Discovering apps...</p>
            </div>
          ) : displayCommands.length === 0 && unpinnedFileResults.length === 0 && !calcResult && !bibleResult ? (
            <div className="flex items-center justify-center h-full text-white/50">
              <p className="text-sm">No matching results</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {/* Calculator card */}
              {calcResult && (
                <div
                  ref={(el) => (itemRefs.current[0] = el)}
                  className={`mx-1 mt-0.5 mb-2 px-6 py-4 rounded-xl cursor-pointer transition-colors border ${
                    selectedIndex === 0
                      ? 'bg-white/[0.08] border-white/[0.12]'
                      : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
                  }`}
                  onClick={() => {
                    navigator.clipboard.writeText(calcResult.result);
                    window.electron.hideWindow();
                  }}
                  onMouseMove={() => setSelectedIndex(0)}
                >
                  <div className="flex items-center justify-center gap-6">
                    <div className="text-center">
                      <div className="text-white/80 text-xl font-medium">{calcResult.input}</div>
                      <div className="text-white/35 text-xs mt-1">{calcResult.inputLabel}</div>
                    </div>
                    <ArrowRight className="w-5 h-5 text-white/25 flex-shrink-0" />
                    <div className="text-center">
                      <div className="text-white text-xl font-semibold">{calcResult.result}</div>
                      <div className="text-white/35 text-xs mt-1">{calcResult.resultLabel}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Bible verse card */}
              {bibleResult && (() => {
                const bibleIdx = calcResult ? 1 : 0;
                return (
                  <div
                    ref={(el) => (itemRefs.current[bibleIdx] = el)}
                    className={`mx-1 mt-0.5 mb-2 px-5 py-4 rounded-xl cursor-pointer transition-colors border ${
                      selectedIndex === bibleIdx
                        ? 'bg-white/[0.08] border-white/[0.12]'
                        : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
                    }`}
                    onClick={() => {
                      navigator.clipboard.writeText(bibleResult.verseText);
                      window.electron.hideWindow();
                    }}
                    onMouseMove={() => setSelectedIndex(bibleIdx)}
                  >
                    <div className="text-white/50 text-xs font-medium mb-2 tracking-wide uppercase">
                      {bibleResult.input}
                    </div>
                    <div className="text-white text-sm leading-relaxed line-clamp-4">
                      {bibleResult.segments.map((seg, i) =>
                        seg.red ? (
                          <span key={i} className="text-red-400">{seg.text}</span>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        )
                      )}
                    </div>
                    <div className="text-white/30 text-xs mt-2">
                      {bibleResult.resultLabel}
                      {bibleResult.segments.some((s) => s.red) && (
                        <span className="text-red-400/50 ml-2">Red Letter Edition</span>
                      )}
                    </div>
                  </div>
                );
              })()}

              {[
                { title: 'Selected Text', items: groupedCommands.contextual },
                { title: 'Pinned', items: groupedCommands.pinned },
                { title: 'Recent', items: groupedCommands.recent },
                { title: 'Other', items: groupedCommands.other },
              ]
                .filter((section) => section.items.length > 0)
                .map((section) => section)
                .reduce(
                  (acc, section) => {
                    const startIndex = acc.index;
                    acc.nodes.push(
                      <div
                        key={`section-${section.title}`}
                        className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider text-white/50 font-semibold"
                      >
                        {section.title}
                      </div>
                    );
                    section.items.forEach((command, i) => {
                      const flatIndex = startIndex + i;
                      const accessoryLabel = getCommandAccessoryLabel(command);
                      const fallbackCategory = getCategoryLabel(command.category);
                      const isPinnedSection = section.title === 'Pinned';
                      const isDragging = dragState?.draggedId === command.id;
                      const isDropTarget = dragState?.dropTargetId === command.id && dragState.draggedId !== command.id;
                      acc.nodes.push(
                        <div
                          key={command.id}
                          ref={(el) => (itemRefs.current[flatIndex + calcOffset] = el)}
                          className={`command-item px-3 py-2 rounded-lg cursor-pointer relative ${
                            flatIndex + calcOffset === selectedIndex ? 'selected' : ''
                          } ${isDragging ? 'opacity-40' : ''} ${isPinnedSection ? 'group' : ''}`}
                          draggable={isPinnedSection}
                          onDragStart={isPinnedSection ? (e) => handlePinnedDragStart(e, command.id) : undefined}
                          onDragOver={isPinnedSection ? (e) => handlePinnedDragOver(e, command.id) : undefined}
                          onDrop={isPinnedSection ? handlePinnedDrop : undefined}
                          onDragEnd={isPinnedSection ? handlePinnedDragEnd : undefined}
                          onClick={() => handleCommandExecute(command)}
                          onMouseMove={() => { if (!dragState) setSelectedIndex(flatIndex + calcOffset); }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setSelectedIndex(flatIndex + calcOffset);
                            setShowActions(false);
                            setContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              commandId: command.id,
                            });
                          }}
                        >
                          {isDropTarget && dragState?.dropPosition === 'before' && (
                            <div className="absolute left-2 right-2 -top-[1px] h-[2px] bg-blue-400 rounded-full pointer-events-none" />
                          )}
                          <div className="flex items-center gap-2.5">
                            {isPinnedSection && (
                              <div className="drag-handle w-3 flex items-center justify-center flex-shrink-0 cursor-grab">
                                <svg width="6" height="10" viewBox="0 0 6 10" fill="currentColor" className="text-white/40">
                                  <circle cx="1.5" cy="1.5" r="1" /><circle cx="4.5" cy="1.5" r="1" />
                                  <circle cx="1.5" cy="5" r="1" /><circle cx="4.5" cy="5" r="1" />
                                  <circle cx="1.5" cy="8.5" r="1" /><circle cx="4.5" cy="8.5" r="1" />
                                </svg>
                              </div>
                            )}
                            <div className="w-5 h-5 flex items-center justify-center flex-shrink-0 overflow-hidden">
                              {renderCommandIcon(command)}
                            </div>

                            <div className="min-w-0 flex-1 flex items-center gap-2">
                              <div className="text-white/95 text-[13px] font-semibold truncate tracking-[0.004em]">
                                {getCommandDisplayTitle(command)}
                              </div>
                              {accessoryLabel ? (
                                <div className="text-white/60 text-[12px] font-medium truncate">
                                  {accessoryLabel}
                                </div>
                              ) : (
                                <div className="text-white/50 text-[11px] font-medium truncate">
                                  {fallbackCategory}
                                </div>
                              )}
                            </div>
                          </div>
                          {isDropTarget && dragState?.dropPosition === 'after' && (
                            <div className="absolute left-2 right-2 -bottom-[1px] h-[2px] bg-blue-400 rounded-full pointer-events-none" />
                          )}
                        </div>
                      );
                    });
                    acc.index += section.items.length;
                    return acc;
                  },
                  { nodes: [] as React.ReactNode[], index: 0 }
                ).nodes}

              {/* Inline file search results (excluding already-pinned files) */}
              {unpinnedFileResults.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider text-white/50 font-semibold">
                    Files
                  </div>
                  {unpinnedFileResults.map((file, i) => {
                    const flatIndex = displayCommands.length + calcOffset + i;
                    const icon = fileIcons[file.path];
                    return (
                      <div
                        key={`file-${file.path}`}
                        ref={(el) => (itemRefs.current[flatIndex] = el)}
                        className={`command-item px-3 py-2 rounded-lg cursor-pointer ${
                          flatIndex === selectedIndex ? 'selected' : ''
                        }`}
                        onClick={() => openFileResult(file.path)}
                        onMouseMove={() => setSelectedIndex(flatIndex)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setSelectedIndex(flatIndex);
                          setShowActions(false);
                          setContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            commandId: pathToPinnedFileId(file.path),
                          });
                        }}
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="w-5 h-5 flex items-center justify-center flex-shrink-0 overflow-hidden">
                            {icon ? (
                              <img src={icon} alt="" className="w-5 h-5 object-contain" draggable={false} />
                            ) : (
                              <div className="w-5 h-5 rounded bg-blue-500/20 flex items-center justify-center">
                                <FileIcon className="w-3 h-3 text-blue-300" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1 flex items-center gap-2">
                            <div className="text-white/95 text-[13px] font-semibold truncate tracking-[0.004em]">
                              {file.name}
                            </div>
                            <div className="text-white/50 text-[11px] font-medium truncate">
                              {file.location}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>
        
        {/* Footer actions */}
        {!isLoading && (
          <div
            className="flex items-center px-4 py-3.5 border-t border-white/[0.06]"
            style={{ background: 'rgba(28,28,32,0.90)' }}
          >
            <div
              className={`flex items-center gap-2 text-xs flex-1 min-w-0 font-medium truncate ${
                memoryActionLoading
                  ? 'text-white/60'
                  : memoryFeedback
                  ? memoryFeedback.type === 'success'
                    ? 'text-emerald-300'
                    : 'text-red-300'
                  : 'text-white/50'
              }`}
            >
              {memoryActionLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                  <span>Adding to memory...</span>
                </>
              ) : memoryFeedback
                ? memoryFeedback.text
                : selectedFile
                  ? (
                    <>
                      <span className="w-5 h-5 flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {fileIcons[selectedFile.path] ? (
                          <img src={fileIcons[selectedFile.path]} alt="" className="w-5 h-5 object-contain" draggable={false} />
                        ) : (
                          <FileIcon className="w-3.5 h-3.5 text-blue-300" />
                        )}
                      </span>
                      <span className="truncate">{selectedFile.name}</span>
                    </>
                  )
                  : selectedCommand
                    ? (
                      <>
                        <span className="w-5 h-5 flex items-center justify-center flex-shrink-0 overflow-hidden">
                          {renderCommandIcon(selectedCommand)}
                        </span>
                        <span className="truncate">{getCommandDisplayTitle(selectedCommand)}</span>
                      </>
                    )
                    : `${displayCommands.length} results`}
            </div>
            {selectedFile ? (
              <div className="flex items-center gap-2 mr-3">
                <button
                  onClick={() => openFileResult(selectedFile.path)}
                  className="text-white text-xs font-semibold hover:text-white/85 transition-colors"
                >
                  Open
                </button>
                <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded bg-white/[0.08] text-[11px] text-white/40 font-medium">
                  ↩
                </kbd>
              </div>
            ) : selectedActions[0] ? (
              <div className="flex items-center gap-2 mr-3">
                <button
                  onClick={() => selectedActions[0].execute()}
                  className="text-white text-xs font-semibold hover:text-white/85 transition-colors"
                >
                  {selectedActions[0].title}
                </button>
                {selectedActions[0].shortcut && (
                  <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded bg-white/[0.08] text-[11px] text-white/40 font-medium">
                    {renderShortcutLabel(selectedActions[0].shortcut)}
                  </kbd>
                )}
              </div>
            ) : null}
            <button
              onClick={() => {
                setContextMenu(null);
                setShowActions(true);
              }}
              className="flex items-center gap-1.5 text-white/50 hover:text-white/70 transition-colors"
            >
              <span className="text-xs font-medium">Actions</span>
              <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded bg-white/[0.08] text-[11px] text-white/40 font-medium">⌘</kbd>
              <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded bg-white/[0.08] text-[11px] text-white/40 font-medium">K</kbd>
            </button>
          </div>
        )}
      </div>
    </div>
    {showActions && selectedActions.length > 0 && (
      <div
        className="fixed inset-0 z-50"
        onClick={() => setShowActions(false)}
        style={{ background: 'rgba(0,0,0,0.15)' }}
      >
        <div
          ref={actionsOverlayRef}
          className="absolute bottom-12 right-3 w-96 max-h-[65vh] rounded-xl overflow-hidden flex flex-col shadow-2xl outline-none focus:outline-none ring-0 focus:ring-0"
          tabIndex={0}
          onKeyDown={handleActionsOverlayKeyDown}
          style={{
            background: 'rgba(30,30,34,0.97)',
            backdropFilter: 'blur(40px)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex-1 overflow-y-auto py-1">
            {selectedActions.map((action, idx) => (
              <div
                key={action.id}
                className={`mx-1 px-2.5 py-1.5 rounded-lg flex items-center gap-2.5 cursor-pointer transition-colors ${
                  idx === selectedActionIndex
                    ? action.style === 'destructive'
                      ? 'bg-white/[0.10] text-red-400'
                      : 'bg-white/[0.10] text-white'
                    : action.style === 'destructive'
                      ? 'hover:bg-white/[0.06] text-red-400'
                      : 'hover:bg-white/[0.06] text-white/80'
                }`}
                onClick={async () => {
                  await Promise.resolve(action.execute());
                  setShowActions(false);
                  restoreLauncherFocus();
                }}
                onMouseMove={() => setSelectedActionIndex(idx)}
              >
                <span className="flex-1 text-sm truncate">{action.title}</span>
                {action.shortcut && (
                  <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded bg-white/[0.08] text-[11px] font-medium text-white/70">
                    {renderShortcutLabel(action.shortcut)}
                  </kbd>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    )}
    {contextMenu && contextActions.length > 0 && (
      <div
        className="fixed inset-0 z-50"
        onClick={() => setContextMenu(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu(null);
        }}
      >
        <div
          ref={contextMenuRef}
          className="absolute w-80 max-h-[60vh] rounded-xl overflow-hidden flex flex-col shadow-2xl outline-none focus:outline-none ring-0 focus:ring-0"
          tabIndex={0}
          onKeyDown={handleContextMenuKeyDown}
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 340),
            top: Math.min(contextMenu.y, window.innerHeight - 320),
            background: 'rgba(30,30,34,0.97)',
            backdropFilter: 'blur(40px)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="flex-1 overflow-y-auto py-1">
            {contextActions.map((action, idx) => (
              <div
                key={`ctx-${action.id}`}
                className={`mx-1 px-2.5 py-1.5 rounded-lg flex items-center gap-2.5 cursor-pointer transition-colors ${
                  idx === selectedContextActionIndex
                    ? action.style === 'destructive'
                      ? 'bg-white/[0.10] text-red-400'
                      : 'bg-white/[0.10] text-white'
                    : action.style === 'destructive'
                      ? 'hover:bg-white/[0.06] text-red-400'
                      : 'hover:bg-white/[0.06] text-white/80'
                }`}
                onClick={async () => {
                  console.log('[CTX-MENU] clicked action:', action.id, action.title);
                  try {
                    await Promise.resolve(action.execute());
                    console.log('[CTX-MENU] action executed successfully');
                  } catch (err) {
                    console.error('[CTX-MENU] action.execute() threw:', err);
                  }
                  setContextMenu(null);
                  restoreLauncherFocus();
                }}
                onMouseMove={() => setSelectedContextActionIndex(idx)}
              >
                <span className="flex-1 text-sm truncate">{action.title}</span>
                {action.shortcut && (
                  <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded bg-white/[0.08] text-[11px] font-medium text-white/70">
                    {renderShortcutLabel(action.shortcut)}
                  </kbd>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default App;
