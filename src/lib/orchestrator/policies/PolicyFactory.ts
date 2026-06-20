import type { AppConfig } from "../../../store/useAppStore";
import type { ExecutionPolicy } from "./ExecutionPolicy";
import { CloudModelPolicy } from "./CloudModelPolicy";
import { LocalModelPolicy } from "./LocalModelPolicy";

export class PolicyFactory {
  static createPolicy(config: AppConfig): ExecutionPolicy {
    // Determine if the current active profile is local
    if (config.activeProfile === "local") {
      // Heuristic to detect reasoning or specific local models
      // Currently treats all local models as "LocalModelPolicy" for stricter constraints,
      // but can be refined if some local models behave perfectly like cloud.
      return new LocalModelPolicy();
    }
    
    // Default to cloud policy
    return new CloudModelPolicy();
  }
}
