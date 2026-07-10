export const CLOUD_SETTINGS_MODEL_SELECT_SCENARIO = "cloud-settings-model-select";
export const CLOUD_SETTINGS_EMPTY_SCENARIO = "cloud-settings-empty";
export const CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO = "cloud-status-active-server-model";

export type CloudSettingsScenario =
  | typeof CLOUD_SETTINGS_MODEL_SELECT_SCENARIO
  | typeof CLOUD_SETTINGS_EMPTY_SCENARIO
  | typeof CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO;

type E2EBridge = {
  initialized: boolean;
  events: Array<Record<string, unknown>>;
  savedDocuments: unknown[];
  completed: boolean;
  getSnapshot?: () => Record<string, unknown>;
  cleanup?: () => void;
};

type CloudSettingsSeedDependencies = {
  bridge: E2EBridge;
  store: {
    getState: () => any;
    setState: (updater: (state: any) => any) => void;
  };
  readSeedCount: (scenario: string) => number;
  incrementSeedCount: (scenario: string) => number;
};

const CLOUD_SETTINGS_SCENARIO_SET = new Set<string>([
  CLOUD_SETTINGS_MODEL_SELECT_SCENARIO,
  CLOUD_SETTINGS_EMPTY_SCENARIO,
  CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO,
]);

export function isCloudSettingsScenario(scenario: string): scenario is CloudSettingsScenario {
  return CLOUD_SETTINGS_SCENARIO_SET.has(scenario);
}

function prepareBridge(bridge: E2EBridge) {
  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;
}

function bindCleanup(bridge: E2EBridge): () => void {
  const cleanup = () => {
    bridge.initialized = false;
  };
  bridge.cleanup = cleanup;
  return cleanup;
}

function seedModelSelect({
  bridge,
  store,
  readSeedCount,
  incrementSeedCount,
}: CloudSettingsSeedDependencies): () => void {
  prepareBridge(bridge);
  incrementSeedCount(CLOUD_SETTINGS_MODEL_SELECT_SCENARIO);

  store.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      activeProfile: "cloud",
      activeCloudServerId: "demo-openai",
      cloudServers: [{
        id: "demo-openai",
        name: "Demo Gateway",
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "responses",
        endpoint: "https://demo-gateway.example/v1",
        apiKey: "demo-key",
        model: "",
        customHeaders: "",
        temperature: 0.6,
        topP: 0.95,
        reasoningEffort: "none",
        disableResponseStorage: true,
        toolProtocol: "auto",
        auth: { mode: "api_key", status: "disconnected" },
      }],
      cloud: {
        ...state.config.cloud,
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "responses",
        endpoint: "https://demo-gateway.example/v1",
        apiKey: "demo-key",
        model: "",
        reasoningEffort: "none",
        disableResponseStorage: true,
        toolProtocol: "auto",
        auth: { mode: "api_key", status: "disconnected" },
      },
    },
    currentWorkspace: "",
    currentSessionId: null,
    sessionsByWorkspace: {},
    taskFlow: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    isSettingsOpen: true,
    settingsTab: "cloud",
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bridge.getSnapshot = () => {
    const state = store.getState();
    return {
      isSettingsOpen: state.isSettingsOpen,
      settingsTab: state.settingsTab,
      selectedCloudModel: state.config.cloud.model,
      activeCloudServerId: state.config.activeCloudServerId,
      activeCloudServerModel: state.config.cloudServers.find((server: any) => server.id === state.config.activeCloudServerId)?.model ?? null,
      cloudServerCount: state.config.cloudServers.length,
      cloudServers: state.config.cloudServers,
      seedCount: readSeedCount(CLOUD_SETTINGS_MODEL_SELECT_SCENARIO),
    };
  };

  return bindCleanup(bridge);
}

function seedEmpty({
  bridge,
  store,
  readSeedCount,
  incrementSeedCount,
}: CloudSettingsSeedDependencies): () => void {
  prepareBridge(bridge);
  incrementSeedCount(CLOUD_SETTINGS_EMPTY_SCENARIO);

  store.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      activeProfile: "cloud",
      activeCloudServerId: "",
      cloudServers: [],
      cloud: {
        ...state.config.cloud,
        model: "",
        apiKey: "",
        customHeaders: "",
      },
    },
    currentWorkspace: "",
    currentSessionId: null,
    sessionsByWorkspace: {},
    taskFlow: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    isSettingsOpen: true,
    settingsTab: "cloud",
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bridge.getSnapshot = () => {
    const state = store.getState();
    return {
      isSettingsOpen: state.isSettingsOpen,
      settingsTab: state.settingsTab,
      selectedCloudModel: state.config.cloud.model,
      activeCloudServerId: state.config.activeCloudServerId,
      cloudServerCount: state.config.cloudServers.length,
      cloudServers: state.config.cloudServers,
      seedCount: readSeedCount(CLOUD_SETTINGS_EMPTY_SCENARIO),
    };
  };

  return bindCleanup(bridge);
}

function seedActiveServerModel({
  bridge,
  store,
  readSeedCount,
  incrementSeedCount,
}: CloudSettingsSeedDependencies): () => void {
  prepareBridge(bridge);
  incrementSeedCount(CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO);

  store.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      activeProfile: "cloud",
      activeCloudServerId: "qwen-gateway",
      cloudServers: [{
        id: "qwen-gateway",
        name: "Qwen3.6",
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "chat_completions",
        endpoint: "https://qwen-gateway.example/v1",
        apiKey: "qwen-key",
        model: "qwen3.6-coder",
        customHeaders: "",
        temperature: 0.6,
        topP: 0.95,
        reasoningEffort: "none",
        disableResponseStorage: true,
        toolProtocol: "auto",
        auth: { mode: "api_key", status: "disconnected" },
      }],
      cloud: {
        ...state.config.cloud,
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "chat_completions",
        endpoint: "https://qwen-gateway.example/v1",
        apiKey: "qwen-key",
        model: "",
        auth: { mode: "api_key", status: "disconnected" },
      },
    },
    currentWorkspace: "",
    currentSessionId: null,
    sessionsByWorkspace: {},
    taskFlow: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    isSettingsOpen: false,
    settingsTab: "cloud",
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bridge.getSnapshot = () => {
    const state = store.getState();
    const activeServer = state.config.cloudServers.find((server: any) => server.id === state.config.activeCloudServerId);
    return {
      selectedCloudModel: state.config.cloud.model,
      activeCloudServerModel: activeServer?.model ?? null,
      activeCloudServerName: activeServer?.name ?? null,
      seedCount: readSeedCount(CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO),
    };
  };

  return bindCleanup(bridge);
}

const CLOUD_SETTINGS_SEEDS: Record<
  CloudSettingsScenario,
  (dependencies: CloudSettingsSeedDependencies) => () => void
> = {
  [CLOUD_SETTINGS_MODEL_SELECT_SCENARIO]: seedModelSelect,
  [CLOUD_SETTINGS_EMPTY_SCENARIO]: seedEmpty,
  [CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO]: seedActiveServerModel,
};

export function seedCloudSettingsScenario(
  scenario: CloudSettingsScenario,
  dependencies: CloudSettingsSeedDependencies,
): () => void {
  return CLOUD_SETTINGS_SEEDS[scenario](dependencies);
}
