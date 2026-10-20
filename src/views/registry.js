/**
 * The tabs, in order: the template's, minus the ones src/views/custom.js
 * hides, then the account's own from custom.js. Each id is a folder under
 * src/views/ holding a view.js that exports `view`.
 *
 * This file belongs to the template and changes with its updates. In a
 * dashboard, add or hide a tab in src/views/custom.js, never here. In the
 * template repository itself, template tabs are added here, to
 * TEMPLATE_VIEWS (CLAUDE.md, "Working on the template itself").
 */
import { CUSTOM_VIEWS, HIDDEN_VIEWS } from './custom.js';

export const TEMPLATE_VIEWS = ['report', 'crm', 'scale', 'account'];

export const VIEWS = [...TEMPLATE_VIEWS.filter((id) => !HIDDEN_VIEWS.includes(id)), ...CUSTOM_VIEWS];
