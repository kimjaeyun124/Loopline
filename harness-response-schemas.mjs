import { BROWSER_QA_EXECUTOR, QA_CATEGORIES } from './browser-qa.mjs';

const string = { type: 'string' };
const array = (items) => ({ type: 'array', items });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const enumeration = (values) => ({ type: 'string', enum: values });
const step = { anyOf: BROWSER_QA_EXECUTOR.actions.map((action) => object({
  action: enumeration([action]),
  ...(!['reset', 'reload', 'press'].includes(action) ? { selector: string } : {}),
  ...(['fill', 'text', 'value'].includes(action) ? { value: string } : {}),
  ...(action === 'count' ? { value: { type: 'integer', minimum: 0, maximum: 1000 } } : {}),
  ...(action === 'press' ? { key: enumeration(BROWSER_QA_EXECUTOR.keys) } : {}),
})) };
const check = object({ id: string, categories: array(enumeration(QA_CATEGORIES)), steps: array(step) });
// Each variant has only applicable exemption keys. Strict output does not force
// null placeholders into validators that correctly reject contradictory claims.
const notApplicable = { anyOf: Array.from({ length: 2 ** QA_CATEGORIES.length }, (_, mask) =>
  object(Object.fromEntries(QA_CATEGORIES.filter((_, index) => mask & (1 << index)).map((category) => [category, string])))) };

export const RESPONSE_SCHEMAS = {
  project: object({ folderName: string, reason: string }),
  verification: object({ verifyCommand: string, reason: string }),
  browserPlan: object({ entry: string, checks: array(check), notApplicable }),
  browserPatch: object({ addChecks: array(check), replaceChecks: array(check), extendChecks: array(object({ id: string, steps: array(step) })), notApplicable }),
  milestones: object({ tasks: array(object({ id: string, title: string, dependsOn: array(string), paths: array(string), criteria: array(string), integrationCriteria: array(string), verifyCommand: string })) }),
  worker: object({ done: { type: 'boolean' }, summary: string, operations: array({ anyOf: [
    object({ type: enumeration(['list']) }),
    object({ type: enumeration(['read', 'delete']), path: string }),
    object({ type: enumeration(['write']), path: string, content: string }),
    object({ type: enumeration(['edit']), path: string, oldText: string, newText: string }),
  ] }) }),
};

export function decisionResponseSchema(checks) {
  return object({ answers: object(Object.fromEntries(Object.keys(checks).map((id) => [id,
    object({ choice: enumeration(['pass', 'revise', 'uncertain']), reason: string }),
  ]))) });
}
