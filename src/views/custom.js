/**
 * The account's own tabs. This file belongs to the dashboard's owner: the
 * template creates it once and never changes it, so a template update never
 * conflicts here. Each id is a folder under src/views/ whose name starts
 * with `custom-`, so a tab the template adds later never takes its folder.
 */

/** The account's tabs, in order, shown after the template's. */
export const CUSTOM_VIEWS = [];

/** Template tabs this dashboard does not show. Their folders stay, so a template update still applies to them. */
export const HIDDEN_VIEWS = [];
