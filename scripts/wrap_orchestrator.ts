import { Project, SyntaxKind } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const file = project.getSourceFileOrThrow("src/lib/orchestrator/loop/AgentOrchestrator.ts");
const executeFunc = file.getFunction("executeAgentLoop");

if (executeFunc) {
  const bodyText = executeFunc.getBodyText() || "";
  
  // Add the class
  file.addClass({
    name: "AgentOrchestrator",
    isExported: true,
    methods: [
      {
        name: "prepareTurn",
        isAsync: true,
        statements: `// TODO: Extract Phase 4 setup logic here in future iterations\n// Requires AgentTurnContext to pass 117+ variables`
      },
      {
        name: "invokeStream",
        isAsync: true,
        statements: `// TODO: Extract LLM fetch logic here`
      },
      {
        name: "evaluateResults",
        isAsync: true,
        statements: `// TODO: Extract tool evaluation logic here`
      },
      {
        name: "execute",
        isAsync: true,
        parameters: [
          { name: "callbacks", type: "OrchestratorCallbacks" },
          { name: "abortController", type: "AbortController" }
        ],
        statements: bodyText
      }
    ]
  });

  // Re-add the export function that wraps it
  file.addFunction({
    name: "executeAgentLoop",
    isExported: true,
    isAsync: true,
    parameters: [
      { name: "callbacks", type: "OrchestratorCallbacks" },
      { name: "abortController", type: "AbortController" }
    ],
    returnType: "Promise<void>",
    statements: `const orchestrator = new AgentOrchestrator();\nreturn orchestrator.execute(callbacks, abortController);`
  });

  executeFunc.remove();
  project.saveSync();
  console.log("Wrapped executeAgentLoop in class AgentOrchestrator inside loop/AgentOrchestrator.ts successfully.");
} else {
  console.log("executeAgentLoop not found.");
}
