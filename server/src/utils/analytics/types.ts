/**
 * Shared types of the analytics query layer (see README.md in this folder).
 *
 * A DATASET is a declarative description of one queryable table: which SQL
 * expression each field maps to, which joins it needs, which licence module
 * and area own it, and which permission key / scope shape guards its rows.
 * Nothing the caller (or a model) sends ever becomes SQL text: specs name
 * fields by key, the compiler looks the key up here and emits the static
 * expression, and every value travels as a bind parameter.
 */
import type { FeatureKey } from '../stripe';
import type { AreaKey } from '../modules';

export type FieldType =
  | 'number'    // plain numeric (counts, minutes, days…)
  | 'money'     // numeric in the org currency
  | 'date'      // a DATE column (no time zone)
  | 'datetime'  // a TIMESTAMP column stored in UTC — bucketed in the org's time zone
  | 'enum'      // closed set of values (Prisma enum or a status string with known values)
  | 'string'    // free text
  | 'boolean'
  | 'relation'; // an id pointing at a person/department/category… — grouped by id, shown by label

export type Aggregation = 'sum' | 'avg' | 'min' | 'max';
export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** SQL expression over alias `t` (and the dataset's join aliases). Static — never user input. */
  sql: string;
  /** relation fields: SQL for the display label (grouping uses `sql`, the id). */
  labelSql?: string;
  /** Join keys (DatasetDef.joins) the expressions above need. */
  joins?: string[];
  /** enum fields: the allowed values. */
  values?: string[];
  /** Model / Prisma field name used by the permission engine's field rules
   *  (FieldPermission `${resource}.${field}`). Defaults to `key`. */
  permField?: string;
  /** Number/money: which aggregations make sense. Defaults to all four. */
  aggregations?: Aggregation[];
  /** Can be a group-by dimension (enum, relation, boolean, low-cardinality string, dates by bucket). */
  groupable?: boolean;
  filterable?: boolean;
  /** relation fields whose id is a User id: the filter value "me" means the caller. */
  isUser?: boolean;
  /** Unit shown next to numbers ("minutes", "days", "%"). */
  unit?: string;
  /** Shown to people and the model. */
  description?: string;
  /** Included in list-mode output by default. */
  listDefault?: boolean;
}

export interface DatasetDef {
  key: string;
  label: string;          // "Leads"
  singular: string;       // "lead"
  description: string;
  /** null = shared (tasks, approvals, custom modules) — not area switched. */
  area: AreaKey | null;
  /** Licence module whose switch-off removes the dataset (utils/modules.ts). null = shared. */
  module: FeatureKey | null;
  table: string;          // SQL table name (whitelisted, from schema.prisma @@map)
  /** Permission key checked with the existing engine (utils/permissions.ts). */
  permission?: string;
  /** SCOPE_SHAPES resource name passed to scopedWhere(). */
  scopeResource?: string;
  /** scopedWhere() emits Prisma field names; this maps each to its SQL column. */
  scopeColumns?: Record<string, string>;
  /** FieldPermission resource used for redaction ("payslip", "employee"…). */
  fieldResource?: string;
  /** Only callers whose scope on `permission` is ALL may use it (no per-row owner exists). */
  requireAllScope?: boolean;
  /** Legacy UserRole values allowed (mirrors a router's requireRole) — when set, others don't get the dataset. */
  roles?: readonly string[];
  /** Extra static WHERE fragment (e.g. custom module id = a bind value). */
  baseWhere?: (p: ParamSink) => string;
  joins?: Record<string, string>;
  /** Join dependencies: a join key → keys it needs first. */
  joinRequires?: Record<string, string[]>;
  /** Joins every query needs (row scoping or baseWhere refer to them). */
  alwaysJoins?: string[];
  defaultDate: string;
  /** SQL column holding a per-row currency (payslips) — rows in another currency raise a warning. */
  currencySql?: string;
  fields: FieldDef[];
  /** A couple of example questions for the prompt/catalog. */
  examples?: string[];
}

export interface ParamSink {
  add(value: unknown): string;
}

/** Catalog entry as resolved for one caller (area-gated, permission-filtered). */
export interface ResolvedDataset {
  def: DatasetDef;
  /** Fields this caller may use (redacted ones removed). */
  fields: FieldDef[];
  /** Field keys removed by field-level permissions, for "why can't I…" messages. */
  redactedFields: string[];
  scope: string;
  /** Row-scope WHERE fragment builder (translated from scopedWhere()). */
  scopeSql: (p: ParamSink) => string;
}

export interface CatalogContext {
  orgId: string;
  userId: string;
  role: string;
  timezone: string;
  currency: string;
}
