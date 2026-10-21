/**
 * Shape of the Conductor workflow definitions the linter consumes.
 *
 * The definitions come from JSON, so every field is *nominal*: the server may
 * send something unexpected and the linter must survive it. The declared types
 * describe the expected shape; the accessors in `util.ts` do the runtime
 * checking.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** A single task in a workflow definition. */
export interface WorkflowTask {
  [key: string]: unknown;
  name?: string;
  taskReferenceName?: string;
  type?: string;
  inputParameters?: JsonObject;
  taskDefinition?: JsonObject;
  decisionCases?: Record<string, WorkflowTask[]>;
  defaultCase?: WorkflowTask[];
  forkTasks?: WorkflowTask[][];
  loopOver?: WorkflowTask[];
  joinOn?: string[];
  optional?: boolean;
  evaluatorType?: string;
  expression?: string;
  caseValueParam?: string;
  caseExpression?: string;
  loopCondition?: string;
  subWorkflowParam?: JsonObject;
  dynamicTaskNameParam?: string;
  dynamicForkJoinTasksParam?: string;
  dynamicForkTasksParam?: string;
  dynamicForkTasksInputParamName?: string;
  sink?: string;
  defaultExclusiveJoinTask?: string;
}

/** A whole workflow definition (`WorkflowDef` on the server). */
export interface WorkflowDefinition {
  [key: string]: unknown;
  name?: string;
  version?: number;
  schemaVersion?: number;
  tasks?: WorkflowTask[];
  outputParameters?: JsonObject | JsonValue[];
}
