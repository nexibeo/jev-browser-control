import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionSpace, buildStep, validateChoice, readDecision, isIrreversible, buildFind } from '../extension/lib/policy.js';

export const page = (extra = {}) => ({
  url: 'https://example.com/search',
  title: 'Book search',
  text: 'Search books',
  scroll: { y: 0, height: 2000, canDown: true, canUp: false },
  canGoBack: true,
  elements: [
    { ref: 11, role: 'searchbox', label: 'Title', editable: true, value: '', inView: true, guard: 'g11' },
    { ref: 12, role: 'button', label: 'Search', inView: true, guard: 'g12' },
    { ref: 13, role: 'checkbox', label: 'In stock only', checked: 'false', inView: true, guard: 'g13' },
    { ref: 14, role: 'combobox', label: 'Sort', inView: true, guard: 'g14', options: [
      { i: 0, label: 'Relevance', value: 'rel', selected: true, disabled: false },
      { i: 1, label: 'Price', value: 'price', selected: false, disabled: false },
      { i: 2, label: 'Hidden', value: 'x', selected: false, disabled: true },
    ] },
    { ref: 15, role: 'link', label: 'Far below', inView: false, guard: 'g15' },
  ],
  ...extra,
});

const dist = (ids, pick) => ({ choice: pick, confidence: 0.9, probabilities: Object.fromEntries(ids.map((k) => [k, k === pick ? 1 : 0])) });

test('one index per node; editable fields get TYPE_TEXT and CLICK; selects list only choosable options', () => {
  const s = actionSpace(page());
  assert.deepEqual(s.elements.map((e) => e.index), ['1', '2', '3', '4']); // off-screen link excluded
  assert.deepEqual(s.elements[0].operations, ['TYPE_TEXT', 'CLICK']);
  assert.deepEqual(Object.keys(s.targets.SELECT), ['4:1']);
  assert.equal(s.targets.SELECT['4:1'].option.value, 'price');
  assert.equal(s.targets.CLICK['1'].label, 'Open Title');
  assert.equal(s.elements[3].value, 'Relevance');
});

test('operations are offered only when they can work', () => {
  const first = buildStep({ goal: 'g', page: page(), history: [], jevModel: 'm' });
  assert.deepEqual(Object.keys(first.operations), ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']);
  const later = buildStep({ goal: 'g', page: page({ scroll: { y: 500, height: 900, canDown: false, canUp: true } }), history: [{ action: 'x' }], last: { kind: 'fill', ref: 11, label: 'Title' }, jevModel: 'm' });
  assert.ok(later.operations.PRESS_ENTER.includes('Title'));
  assert.ok('SCROLL_UP' in later.operations && !('SCROLL_DOWN' in later.operations) && 'BACK' in later.operations);
  assert.deepEqual(Object.keys(later.body.questions).sort(), ['click_target', 'goal_done', 'operation', 'select_target', 'type_text_target']);
  assert.equal(later.body.questions.click_target.criteria['3'].checked, 'false');
  assert.equal(later.body.model, 'm');
});

test('validateChoice rejects invented options and malformed distributions', () => {
  assert.throws(() => validateChoice({ choice: 'x', confidence: 1, probabilities: { a: 1 } }, ['a']), /Invalid Jev/);
  assert.throws(() => validateChoice({ choice: 'a', confidence: 1, probabilities: { a: 0.5, b: 0.2 } }, ['a', 'b']), /Invalid Jev/);
  assert.throws(() => validateChoice({ choice: 'b', confidence: 1, probabilities: { a: 0.7, b: 0.3 } }, ['a', 'b']), /Invalid Jev/);
  assert.ok(validateChoice(dist(['a', 'b'], 'b'), ['a', 'b']));
});

test('readDecision uses only the target head matching the operation', () => {
  const step = buildStep({ goal: 'g', page: page(), history: [], jevModel: 'm' });
  const answers = {
    operation: dist(Object.keys(step.operations), 'TYPE_TEXT'),
    type_text_target: dist(['1'], '1'),
    click_target: { choice: 'invented' }, // unused head: can't cause an action
    goal_done: { type: 'noul', noul: 0.1 },
  };
  const d = readDecision({ answers }, step);
  assert.equal(d.operation, 'TYPE_TEXT');
  assert.equal(d.target.ref, 11);
  assert.equal(d.goal_done, 0.1);
  const bad = { ...answers, operation: dist(Object.keys(step.operations), 'CLICK') };
  assert.throws(() => readDecision({ answers: bad }, step), /Invalid Jev/);
});

test('irreversible clicks are recognised, ordinary ones are not', () => {
  const t = (label, kind = 'click') => ({ kind, label, element: { label } });
  for (const l of ['Place order', 'Buy now', 'Pay €12.00', 'Delete account', 'Send', 'Confirm booking', 'Publish']) assert.ok(isIrreversible(t(l)), l);
  for (const l of ['Posts', 'Search', 'Next', 'Add filter', 'Sender name', 'PayPal info', 'Open Title']) assert.ok(!isIrreversible(t(l)), l);
  assert.ok(!isIrreversible(t('Buy now', 'fill')));
});

test('buildFind offers every visible element plus none', () => {
  const f = buildFind({ description: 'the search button', page: page(), jevModel: 'm' });
  assert.deepEqual(Object.keys(f.criteria), ['1', '2', '3', '4', 'none']);
  assert.equal(f.space.byIndex['2'].ref, 12);
});
