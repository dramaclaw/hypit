import type { NewApiSetupInput } from "@dramaclaw/provider-newapi";

/** Submitted from the wizard to the main process. Never include this in an outbound IPC event. */
export type SetupInput = Omit<NewApiSetupInput, "relay"> & {
  readonly relay: Extract<NewApiSetupInput["relay"], { readonly enabled: true }>;
};

export type DiagnosticCode =
  | "bundle"
  | "launcher"
  | "version"
  | "ffmpeg"
  | "skill"
  | "profile"
  | "credentials"
  | "newapi"
  | "oss";

export type DiagnosticLabel =
  | "安装资源"
  | "命令入口"
  | "Hypit 版本"
  | "FFmpeg"
  | "Codex Skill"
  | "Runtime Profile"
  | "平台凭据"
  | "NewAPI"
  | "OSS";

export type DiagnosticItem = {
  readonly code: DiagnosticCode;
  readonly status: "pass" | "warning" | "fail";
  readonly label: DiagnosticLabel;
  readonly path?: string;
};

export type SetupStage =
  | "validating"
  | "testing-newapi"
  | "testing-oss"
  | "saving-credentials"
  | "writing-profile"
  | "installing-skill"
  | "installing-launcher"
  | "diagnosing"
  | "complete";

/** Every outbound variant has a fixed shape, so arbitrary errors or input cannot cross IPC. */
export type SetupProgress =
  | { readonly kind: "stage"; readonly stage: SetupStage }
  | { readonly kind: "model-count"; readonly count: number }
  | { readonly kind: "diagnostic"; readonly item: DiagnosticItem };

export type SetupResult = {
  readonly configured: boolean;
  readonly modelCount: number;
  readonly relayVerified: boolean;
  readonly profilePath: string;
  readonly skillPath: string;
  readonly launcherPath: string;
  readonly diagnostics: readonly DiagnosticItem[];
};

/** The only method that accepts secret-bearing input; all return values are redacted contracts. */
export type DesktopSetupPreload = import("./ipc.js").SetupBridge;
