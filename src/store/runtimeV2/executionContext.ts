/**
 * Compatibility facade for Runtime v2 execution ports.
 *
 * Keep behavior in the narrow protocol modules below. Existing adapters import
 * this facade so responsibility splits do not create a broad migration diff.
 */
export * from "./executionAggregate";
export * from "./executionAuthorization";
export * from "./executionEvidence";
export * from "./executionProviderContext";
export * from "./executionProviderHistory";
export * from "./executionSubagentScopes";
export * from "./executionText";
export * from "./executionTypes";
