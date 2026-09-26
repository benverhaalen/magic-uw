import type { AppBridge } from "@magic/contracts";

declare global {
  interface Window {
    magic: AppBridge;
  }
}
