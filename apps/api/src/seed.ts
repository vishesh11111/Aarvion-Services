/**
 * Development seed.
 *
 * Produces a tenant that looks like a real one: a team with different roles, a
 * few hundred leads with realistic gaps in the data (missing emails, free-mail
 * addresses, blank job titles), and an activity history. Seeding perfect data
 * hides exactly the bugs this application needs to handle.
 *
 * Idempotent: re-running replaces the seeded organization's leads rather than
 * duplicating them.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from './lib/db';
import {
  ActivityType,
  LeadActivityModel,
  LeadModel,
  LeadPriority,
  LeadSource,
  LeadStatus,
  OrganizationModel,
  Role,
  UserModel,
  UserStatus,
  valuesOf,
} from './models';
import { syncAllIndexes } from './scripts/sync-indexes';
import { buildDedupeKey, buildFullName } from './modules/leads/lead.normalizer';

const ORG_NAME = process.env.SEED_ORG_NAME ?? 'Acme Corporation';
const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL ?? 'admin@acme.test').toLowerCase();
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Password123!';
const LEAD_COUNT = Number(process.env.SEED_LEAD_COUNT ?? 250);

/* -------------------------------------------------------------------------- */
/* Deterministic pseudo-randomness                                            */
/* -------------------------------------------------------------------------- */

/**
 * Seeded PRNG (mulberry32) so `db:seed` produces the same dataset every run.
 * Reproducible fixtures make screenshots, demos and bug reports comparable.
 */
const makeRandom = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const random = makeRandom(20260806);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const chance = (probability: number): boolean => random() < probability;
const between = (min: number, max: number): number => Math.floor(random() * (max - min + 1)) + min;

/* -------------------------------------------------------------------------- */
/* Fixture vocabulary                                                         */
/* -------------------------------------------------------------------------- */

const FIRST_NAMES = [
  'Priya', 'Marcus', 'Sofia', 'Chen', 'Amara', 'Diego', 'Yuki', 'Fatima', 'Liam', 'Ingrid',
  'Rohan', 'Elena', 'Kwame', 'Hana', 'Tomas', 'Aisha', 'Noah', 'Mei', 'Omar', 'Freya',
  'Arjun', 'Camila', 'Dmitri', 'Zara', 'Felix', 'Nadia', 'Sean', 'Ling', 'Ibrahim', 'Astrid',
];

const LAST_NAMES = [
  'Sharma', 'Okafor', 'Rossi', 'Wei', 'Nakamura', 'Silva', 'Haddad', 'Murphy', 'Larsson', 'Patel',
  'Volkov', 'Dubois', 'Andersen', 'Costa', 'Kim', 'Novak', 'Fernandez', 'Bergman', 'Osei', 'Tan',
];

const COMPANIES = [
  ['Northwind Logistics', 'Transportation'], ['Helios Energy', 'Energy'],
  ['Vertex Financial', 'Financial Services'], ['BrightPath Health', 'Healthcare'],
  ['Quanta Robotics', 'Manufacturing'], ['Lumen Retail Group', 'Retail'],
  ['Cascade Software', 'Software'], ['Ironwood Construction', 'Construction'],
  ['Solstice Media', 'Media'], ['Meridian Insurance', 'Insurance'],
  ['Atlas Freight', 'Transportation'], ['Sable Biotech', 'Biotechnology'],
  ['Kestrel Analytics', 'Software'], ['Harbour Foods', 'Food & Beverage'],
  ['Pinnacle Education', 'Education'], ['Riverstone Legal', 'Legal Services'],
  ['Zenith Telecom', 'Telecommunications'], ['Copperline Mining', 'Mining'],
  ['Everbloom Agritech', 'Agriculture'], ['Nimbus Cloud Services', 'Software'],
] as const;

const TITLES = [
  'Chief Executive Officer', 'Chief Technology Officer', 'VP of Sales', 'VP of Engineering',
  'Head of Marketing', 'Director of Operations', 'Procurement Manager', 'IT Manager',
  'Senior Software Engineer', 'Product Manager', 'Business Analyst', 'Sales Representative',
  'Office Coordinator', 'Marketing Intern', 'Founder', 'Managing Director',
];

const CITIES = [
  ['London', 'England', 'United Kingdom'], ['Berlin', 'Berlin', 'Germany'],
  ['Austin', 'Texas', 'United States'], ['Toronto', 'Ontario', 'Canada'],
  ['Bengaluru', 'Karnataka', 'India'], ['Singapore', '', 'Singapore'],
  ['Sydney', 'New South Wales', 'Australia'], ['Amsterdam', 'North Holland', 'Netherlands'],
  ['Sao Paulo', 'Sao Paulo', 'Brazil'], ['Nairobi', 'Nairobi', 'Kenya'],
] as const;

const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
const TAG_POOL = [
  'enterprise', 'smb', 'inbound', 'outbound', 'high-intent',
  'renewal', 'competitor-switch', 'emea', 'apac', 'namer',
];

const NOTES_TEMPLATES = [
  'Requested pricing for a 50-seat deployment. Budget approved for next quarter.',
  'Met at the trade show booth. Interested but evaluating two competitors.',
  'Downloaded the whitepaper twice. No direct contact yet.',
  'Current contract expires in March — worth a renewal conversation in January.',
  'Asked for a technical deep-dive with their security team before proceeding.',
  'Went quiet after the demo. Follow up needed.',
  '',
];

const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Insert options that preserve the historical `createdAt` values in the fixture
 * data. Without `timestamps: false`, Mongoose stamps every document with "now"
 * and the dashboard's time-series chart shows all 250 leads arriving today.
 *
 * Typed via a cast because Mongoose's `InsertManyOptions` does not declare
 * `timestamps`, although the driver honours it.
 */
const INSERT_PRESERVING_TIMESTAMPS = { ordered: false, timestamps: false } as unknown as {
  ordered: boolean;
};

/* -------------------------------------------------------------------------- */
/* Seed                                                                       */
/* -------------------------------------------------------------------------- */

const main = async (): Promise<void> => {
  await connectDatabase();
  console.log('Seeding database…');

  // Indexes are not created implicitly (autoIndex is off), and the seed relies
  // on the unique dedupe index to behave correctly — so make sure it exists.
  await syncAllIndexes();

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const slug = slugify(ORG_NAME);

  const organization = await OrganizationModel.findOneAndUpdate(
    { slug },
    { $set: { name: ORG_NAME }, $setOnInsert: { slug, plan: 'pro' } },
    { upsert: true, new: true },
  );

  // Wipe this tenant's leads so re-seeding is deterministic rather than additive.
  await LeadModel.deleteMany({ organizationId: organization._id });
  await LeadActivityModel.deleteMany({ organizationId: organization._id });

  const domain = ADMIN_EMAIL.split('@')[1] ?? 'acme.test';
  const team = [
    { email: ADMIN_EMAIL, name: 'Alex Morgan', role: Role.OWNER },
    { email: `manager@${domain}`, name: 'Sam Rivera', role: Role.ADMIN },
    { email: `rep1@${domain}`, name: 'Jordan Blake', role: Role.MEMBER },
    { email: `rep2@${domain}`, name: 'Casey Nguyen', role: Role.MEMBER },
    { email: `viewer@${domain}`, name: 'Riley Chen', role: Role.VIEWER },
  ];

  const users = [];
  for (const member of team) {
    const user = await UserModel.findOneAndUpdate(
      { email: member.email },
      {
        $set: {
          name: member.name,
          role: member.role,
          organizationId: organization._id,
          status: UserStatus.ACTIVE,
        },
        $setOnInsert: { email: member.email, passwordHash },
      },
      { upsert: true, new: true },
    );
    users.push(user);
  }

  const reps = users.filter((u) => u.role === Role.MEMBER || u.role === Role.ADMIN);

  /* --- leads ------------------------------------------------------------ */

  const statusWeights: Array<[LeadStatus, number]> = [
    [LeadStatus.NEW, 0.34], [LeadStatus.CONTACTED, 0.24], [LeadStatus.QUALIFIED, 0.16],
    [LeadStatus.PROPOSAL, 0.09], [LeadStatus.WON, 0.08], [LeadStatus.LOST, 0.06],
    [LeadStatus.DISQUALIFIED, 0.03],
  ];

  const weightedStatus = (): LeadStatus => {
    const roll = random();
    let cumulative = 0;
    for (const [status, weight] of statusWeights) {
      cumulative += weight;
      if (roll <= cumulative) return status;
    }
    return LeadStatus.NEW;
  };

  const seenKeys = new Set<string>();
  const leads = [];

  for (let i = 0; i < LEAD_COUNT; i += 1) {
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const [company, industry] = pick(COMPANIES);
    const [city, state, country] = pick(CITIES);

    // Real data has holes. ~12% have no email, ~18% no phone, ~15% no title.
    const hasEmail = chance(0.88);
    const useFreeMail = chance(0.25);
    const emailDomain = useFreeMail
      ? pick(['gmail.com', 'outlook.com', 'yahoo.com'])
      : `${slugify(company)}.com`;
    const email = hasEmail
      ? `${firstName.toLowerCase()}.${lastName.toLowerCase()}${chance(0.15) ? between(1, 99) : ''}@${emailDomain}`
      : undefined;

    const phone = chance(0.82) ? `+1${between(200, 989)}${between(1000000, 9999999)}` : undefined;
    const jobTitle = chance(0.85) ? pick(TITLES) : undefined;
    const fullName = buildFullName(firstName, lastName);

    const dedupeKey = buildDedupeKey({ email, phone, fullName, company });
    if (seenKeys.has(dedupeKey)) continue; // collision — skip rather than fail the unique index
    seenKeys.add(dedupeKey);

    const status = weightedStatus();
    const daysAgo = between(0, 120);
    const createdAt = new Date(Date.now() - daysAgo * 86_400_000);

    leads.push({
      organizationId: organization._id,
      firstName,
      lastName,
      fullName,
      email: email ?? null,
      phone: phone ?? null,
      company,
      jobTitle: jobTitle ?? null,
      website: `https://www.${slugify(company)}.com`,
      industry,
      companySize: pick(COMPANY_SIZES),
      city,
      state: state || null,
      country,
      status,
      priority: pick(valuesOf(LeadPriority)),
      source: pick(valuesOf(LeadSource)),
      sourceDetail: 'seed-data',
      estimatedValue: chance(0.6) ? between(2, 240) * 500 : null,
      ownerId: chance(0.75) ? pick(reps)._id : null,
      tags: [...new Set(Array.from({ length: between(0, 3) }, () => pick(TAG_POOL)))],
      notes: pick(NOTES_TEMPLATES) || null,
      dedupeKey,
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: chance(0.7) ? new Date(createdAt.getTime() + between(1, 20) * 86_400_000) : null,
      // Deliberately left unscored so the AI scoring flow has something to do on
      // a fresh install — that is the first thing a reviewer will try.
      score: null,
      customFields: chance(0.3)
        ? { legacy_crm_id: randomUUID().slice(0, 8), lead_grade: pick(['A', 'B', 'C']) }
        : {},
    });
  }

  // `timestamps: false` so the handcrafted historical createdAt values survive —
  // otherwise Mongoose overwrites them all with "now" and the time-series chart
  // shows every seeded lead arriving today.
  //
  // The cast is required because Mongoose's `InsertManyOptions` type omits
  // `timestamps` even though the option is honoured at runtime. Documented here
  // rather than silently `any`-ing the call.
  await LeadModel.insertMany(leads, INSERT_PRESERVING_TIMESTAMPS);
  console.log(`  ${leads.length} leads created`);

  /* --- activity history -------------------------------------------------- */

  const created = await LeadModel.find({ organizationId: organization._id })
    .select('status ownerId createdAt')
    .lean();

  const activities = created.flatMap((lead) => {
    const rows: Record<string, unknown>[] = [
      {
        organizationId: organization._id,
        leadId: lead._id,
        userId: lead.ownerId,
        type: ActivityType.CREATED,
        title: 'Lead created',
        createdAt: lead.createdAt,
      },
    ];

    if (lead.status !== LeadStatus.NEW) {
      rows.push({
        organizationId: organization._id,
        leadId: lead._id,
        userId: lead.ownerId,
        type: pick([ActivityType.CALL, ActivityType.EMAIL, ActivityType.MEETING]),
        title: pick(['Intro call completed', 'Follow-up email sent', 'Discovery meeting held']),
        body: pick(NOTES_TEMPLATES) || null,
        createdAt: new Date(lead.createdAt.getTime() + between(1, 10) * 86_400_000),
      });
      rows.push({
        organizationId: organization._id,
        leadId: lead._id,
        userId: lead.ownerId,
        type: ActivityType.STATUS_CHANGE,
        title: `Status changed to ${lead.status}`,
        metadata: { from: LeadStatus.NEW, to: lead.status },
        createdAt: new Date(lead.createdAt.getTime() + between(2, 15) * 86_400_000),
      });
    }

    return rows;
  });

  await LeadActivityModel.insertMany(activities, INSERT_PRESERVING_TIMESTAMPS);
  console.log(`  ${activities.length} activities created`);

  console.log('\nSeed complete.\n');
  console.log(`  Organization : ${organization.name} (${organization.slug})`);
  console.log(`  Sign in      : ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(`  Team         : ${users.length} users across ${new Set(users.map((u) => u.role)).size} roles`);
  console.log('\n  Leads are intentionally unscored — run AI scoring from the dashboard to see it work.\n');

  await disconnectDatabase();
};

main().catch((error: Error) => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});
