import type { DocumentEditorDebugTools } from "./utils/document-editor-debug-tools.js";

declare global {
  interface Window {
    documentEditorDebugTools?: DocumentEditorDebugTools;
    /** EIP-1193 provider (MetaMask, etc.) — used by Swarm Storage settings. */
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
  const PH_PACKAGE_REGISTRY_URL: string | null;
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
  const MAIN_WINDOW_VITE_NAME: string;
}
