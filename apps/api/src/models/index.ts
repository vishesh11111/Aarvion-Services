/**
 * Model barrel.
 *
 * Importing models from here (rather than from individual files) guarantees
 * every schema is registered with Mongoose before any query runs — `populate()`
 * resolves references by model name, so a model that has not been imported yet
 * fails at runtime with `MissingSchemaError`, and only on the code path that
 * happens to populate it.
 */
export * from './enums';
export * from './base';

export { OrganizationModel, type Organization, type OrganizationDoc } from './organization.model';
export { UserModel, type User, type UserDoc } from './user.model';
export { RefreshTokenModel, type RefreshToken, type RefreshTokenDoc } from './refresh-token.model';
export { LeadModel, type Lead, type LeadDoc } from './lead.model';
export { LeadActivityModel, type LeadActivity, type LeadActivityDoc } from './lead-activity.model';
export {
  ImportJobModel,
  ImportErrorModel,
  type ImportJob,
  type ImportJobDoc,
  type ImportError,
  type ImportErrorDoc,
} from './import-job.model';
export {
  AuditLogModel,
  AiInteractionModel,
  SavedViewModel,
  type AuditLog,
  type AiInteraction,
  type SavedView,
} from './audit-log.model';
