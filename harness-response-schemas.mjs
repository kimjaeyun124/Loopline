import { BROWSER_QA_EXECUTOR, QA_CATEGORIES } from './browser-qa.mjs';

const string = { type: 'string' };
const array = (items, bounds = {}) => ({ type: 'array', items, ...bounds });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const enumeration = (values) => ({ type: 'string', enum: values });
const milestoneCriterion = { type: 'string', minLength: 8, maxLength: 600 };
const step = { anyOf: BROWSER_QA_EXECUTOR.actions.map((action) => object({
  action: enumeration([action]),
  ...(!['reset', 'reload', 'press', 'set-storage'].includes(action) ? { selector: string } : {}),
  ...(['fill', 'text', 'value', 'set-storage'].includes(action) ? { value: string } : {}),
  ...(action === 'count' ? { value: { type: 'integer', minimum: 0, maximum: 1000 } } : {}),
  ...(action === 'press' ? { key: enumeration(BROWSER_QA_EXECUTOR.keys) } : {}),
  ...(action === 'set-storage' ? { key: string } : {}),
})) };
// Match the executor's existing bounds during generation so an otherwise
// structured response does not spend a model call on an unexecutable plan.
const check = object({ id: string, categories: array(enumeration(QA_CATEGORIES)), steps: array(step, { minItems: 1, maxItems: 24 }) });
// Each variant has only applicable exemption keys. Strict output does not force
// null placeholders into validators that correctly reject contradictory claims.
const notApplicable = { anyOf: Array.from({ length: 2 ** QA_CATEGORIES.length }, (_, mask) =>
  object(Object.fromEntries(QA_CATEGORIES.filter((_, index) => mask & (1 << index)).map((category) => [category, string])))) };

export const RESPONSE_SCHEMAS = {
  project: object({ folderName: string, reason: string }),
  verification: object({ verifyCommand: string, reason: string }),
  verificationProposal: {
    type: 'object',
    properties: {
      operations: array({ anyOf: [
      object({ type: enumeration(['list']), path: string }),
      object({ type: enumeration(['read']), path: string }),
      ] }, { maxItems: 12 }),
      verifyCommand: { type: 'string', maxLength: 1000 },
      reason: string,
    },
    required: ['operations', 'verifyCommand', 'reason'],
    anyOf: [
      { properties: { operations: { minItems: 1 } } },
      { properties: { verifyCommand: { minLength: 1 }, reason: { minLength: 1 } } },
    ],
    additionalProperties: false,
  },
  browserPlan: object({ entry: string, checks: array(check, { minItems: 1, maxItems: 16 }), notApplicable }),
  // The executor still validates the combined patch size and the remaining
  // capacity of each existing case; these are per-array generation ceilings.
  browserPatch: object({ addChecks: array(check, { maxItems: 16 }), replaceChecks: array(check, { maxItems: 16 }), extendChecks: array(object({ id: string, steps: array(step, { minItems: 1, maxItems: 24 }) }), { maxItems: 16 }), notApplicable }),
  milestones: object({ tasks: array(object({ id: { type: 'string', pattern: '^[a-z0-9-]{1,48}$' }, title: { type: 'string', minLength: 1, maxLength: 160 },
    dependsOn: array(string, { maxItems: 8 }), paths: array(string, { minItems: 1, maxItems: 16 }),
    criteria: array(milestoneCriterion, { minItems: 1, maxItems: 8 }), integrationCriteria: array(milestoneCriterion, { maxItems: 8 }),
    verifyCommand: { type: 'string', minLength: 5, maxLength: 1600 } }), { minItems: 2, maxItems: 8 }) }),
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
