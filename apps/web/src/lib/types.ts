/**
 * API contract types.
 *
 * Hand-mirrored from the API rather than imported from it. The web app and the
 * API are deployed independently, so a shared type package would couple their
 * release cycles — and the API's Mongoose document types carry server-only fields
 * (passwordHash, storageKey) that must never be reachable from client code.
 */

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
export type UserStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED';

export type LeadStatus =
  | 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'PROPOSAL' | 'WON' | 'LOST' | 'DISQUALIFIED';

export type LeadPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export type LeadSource =
  | 'CSV_IMPORT' | 'MANUAL' | 'WEBSITE' | 'REFERRAL' | 'WEBINAR'
  | 'ADVERTISING' | 'LINKEDIN' | 'EVENT' | 'API' | 'OTHER';

export type ImportStatus =
  | 'PENDING' | 'VALIDATING' | 'PROCESSING' | 'COMPLETED'
  | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'CANCELLED';

export const LEAD_STATUSES: LeadStatus[] = [
  'NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST', 'DISQUALIFIED',
];

export const LEAD_PRIORITIES: LeadPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export const LEAD_SOURCES: LeadSource[] = [
  'CSV_IMPORT', 'MANUAL', 'WEBSITE', 'REFERRAL', 'WEBINAR',
  'ADVERTISING', 'LINKEDIN', 'EVENT', 'API', 'OTHER',
];

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  organizationId: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string;
}

export interface Owner {
  id: string;
  name: string;
  email: string;
}

export interface Lead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  jobTitle: string | null;
  website: string | null;
  industry: string | null;
  companySize: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  status: LeadStatus;
  priority: LeadPriority;
  source: LeadSource;
  sourceDetail: string | null;
  estimatedValue: number | null;
  ownerId: string | null;
  owner?: Owner | null;
  tags: string[];
  notes: string | null;
  /** null means "not yet scored". 0 is a real, very low score. */
  score: number | null;
  scoreRationale: string | null;
  aiSummary: string | null;
  aiNextAction: string | null;
  scoredAt: string | null;
  customFields: Record<string, unknown>;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Activity {
  id: string;
  type: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  user?: { id: string; name: string } | null;
}

export interface LeadDetail extends Lead {
  activities: Activity[];
  importJob?: { id: string; filename: string; createdAt: string } | null;
}

export interface LeadStats {
  total: number;
  newLast30Days: number;
  unscored: number;
  byStatus: Record<LeadStatus, number>;
  bySource: Record<LeadSource, number>;
  averageScore: number | null;
  pipelineValue: number;
  conversionRate: number;
}

export interface ImportJob {
  id: string;
  filename: string;
  status: ImportStatus;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  progress: number;
  failureReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  createdBy?: { id: string; name: string };
}

export interface ImportError {
  id: string;
  rowNumber: number;
  field: string | null;
  message: string;
  rawRow: Record<string, string>;
}

export interface MappingSuggestion {
  csvColumn: string;
  leadField: string | null;
  confidence: number;
  reason: string;
}

export interface ImportCreateResponse {
  importJobId: string;
  filename: string;
  status: ImportStatus;
  preview: {
    headers: string[];
    sampleRows: Record<string, string>[];
    estimatedRows: number;
    delimiter: string;
  };
  mapping: {
    suggestions: MappingSuggestion[];
    detectedSourceHint?: string;
    degraded: boolean;
    degradedReason?: string;
  };
}

export interface AiStatus {
  enabled: boolean;
  available: boolean;
  model: string | null;
  dailyLimit: number;
  usedToday: number;
}

export interface LeadInsights {
  summary: string;
  talkingPoints: string[];
  risks: string[];
  suggestedNextAction: string;
  recommendedChannel: 'EMAIL' | 'CALL' | 'LINKEDIN' | 'WAIT';
  draftOpener: string;
}

export interface ScoredLead {
  id: string;
  score: number;
  rationale: string;
  nextAction: string;
  priority: LeadPriority;
  summary: string;
}

export interface FunnelData {
  stages: Array<{
    status: LeadStatus;
    count: number;
    value: number;
    conversionFromPrevious: number | null;
  }>;
  lost: number;
  disqualified: number;
}

export interface TimeseriesPoint {
  date: string;
  created: number;
  won: number;
}

export interface ScoreBucket {
  range: string;
  min: number;
  count: number;
}

export interface OwnerPerformance {
  ownerId: string | null;
  name: string;
  total: number;
  won: number;
  winRate: number;
  averageScore: number | null;
}

/** The `meta` block carried by every AI-backed response. */
export interface AiMeta {
  degraded?: boolean;
  degradedReason?: string;
  cached?: boolean;
  interpretation?: string;
  appliedFilters?: Record<string, unknown>;
  filtersRejected?: boolean;
}

export interface PaginationMeta extends AiMeta {
  nextCursor?: string | null;
  hasMore?: boolean;
  limit?: number;
  total?: number;
  totalIsApproximate?: boolean;
  offset?: number;
}
