'use client';

/**
 * Settings: profile, team management and AI usage.
 *
 * Actions the current role cannot perform are hidden rather than shown-disabled.
 * The API enforces the same rules regardless — this is about not presenting a
 * user with controls that will only ever reject them.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { formatNumber, formatRelative, humanise, initials } from '@/lib/format';
import { useSession, useToast } from '@/components/providers';
import { Badge, Button, Card, Field, Input, Modal, Select, Skeleton } from '@/components/ui';
import type { AiStatus, Role, User } from '@/lib/types';

interface AiUsage {
  periodDays: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  degradedCalls: number;
  usedToday: number;
  dailyLimit: number;
  byFeature: Array<{
    feature: string;
    calls: number;
    averageLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: 'Full control, including billing and ownership transfer',
  ADMIN: 'Manage the team and all leads',
  MEMBER: 'Create and edit leads they own or that are unassigned',
  VIEWER: 'Read-only access to leads and reports',
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user, organization, can } = useSession();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<{ members: User[] }>('/auth/members'),
  });

  const aiStatus = useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<AiStatus>('/ai/status') });
  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: () => api.get<AiUsage>('/ai/usage') });

  const updateMember = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api.patch(`/auth/members/${id}`, patch),
    onSuccess: () => {
      toast('Member updated.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Update failed.', 'error'),
  });

  const canManageTeam = can('ADMIN');

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">{organization?.name}</p>
      </div>

      {/* --- profile ------------------------------------------------------ */}
      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold">Your account</h2>
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand">
            {initials(user?.name ?? '?')}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{user?.name}</div>
            <div className="truncate text-sm text-muted">{user?.email}</div>
          </div>
          <Badge className="bg-surface-2 text-muted">{humanise(user?.role ?? '')}</Badge>
          <Button variant="secondary" onClick={() => setPasswordOpen(true)}>
            Change password
          </Button>
        </div>
      </Card>

      {/* --- team --------------------------------------------------------- */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Team</h2>
            <p className="mt-0.5 text-xs text-muted">
              {members.data ? `${members.data.members.length} member(s)` : 'Loading…'}
            </p>
          </div>
          {canManageTeam && <Button onClick={() => setInviteOpen(true)}>Invite member</Button>}
        </div>

        {members.isLoading ? (
          <Skeleton className="h-32" />
        ) : (
          <div className="divide-y divide-border">
            {members.data?.members.map((member) => {
              const isSelf = member.id === user?.id;
              return (
                <div key={member.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">
                    {initials(member.name)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{member.name}</span>
                      {isSelf && <span className="text-xs text-muted">(you)</span>}
                      {member.status !== 'ACTIVE' && (
                        <Badge
                          className={
                            member.status === 'SUSPENDED'
                              ? 'bg-danger/12 text-danger'
                              : 'bg-warning/12 text-warning'
                          }
                        >
                          {humanise(member.status)}
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {member.email}
                      {member.lastLoginAt && ` · last seen ${formatRelative(member.lastLoginAt)}`}
                    </div>
                  </div>

                  {/* You cannot change your own role — that is how an org ends
                      up with zero owners. The API enforces it too. */}
                  {canManageTeam && !isSelf ? (
                    <div className="flex gap-2">
                      <Select
                        className="h-8 w-auto py-0 text-xs"
                        value={member.role}
                        onChange={(event) =>
                          updateMember.mutate({ id: member.id, patch: { role: event.target.value } })
                        }
                        aria-label={`Role for ${member.name}`}
                      >
                        {(['ADMIN', 'MEMBER', 'VIEWER'] as Role[]).map((role) => (
                          <option key={role} value={role}>{humanise(role)}</option>
                        ))}
                        {member.role === 'OWNER' && <option value="OWNER">Owner</option>}
                      </Select>

                      <Button
                        variant="ghost"
                        className="h-8 py-0 text-xs"
                        onClick={() =>
                          updateMember.mutate({
                            id: member.id,
                            patch: { status: member.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED' },
                          })
                        }
                      >
                        {member.status === 'SUSPENDED' ? 'Reactivate' : 'Suspend'}
                      </Button>
                    </div>
                  ) : (
                    <Badge className="bg-surface-2 text-muted">{humanise(member.role)}</Badge>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 grid gap-1.5 border-t border-border pt-4 text-xs text-muted sm:grid-cols-2">
          {(Object.keys(ROLE_DESCRIPTIONS) as Role[]).map((role) => (
            <div key={role}>
              <strong className="text-fg">{humanise(role)}</strong> — {ROLE_DESCRIPTIONS[role]}
            </div>
          ))}
        </div>
      </Card>

      {/* --- AI ----------------------------------------------------------- */}
      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold">AI</h2>

        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div>
            <span className="text-muted">Status: </span>
            <span
              className={
                aiStatus.data?.available
                  ? 'font-medium text-success'
                  : aiStatus.data?.enabled
                    ? 'font-medium text-warning'
                    : 'font-medium text-muted'
              }
            >
              {aiStatus.data?.available
                ? 'Connected'
                : aiStatus.data?.enabled
                  ? 'Provider unreachable — using fallbacks'
                  : 'Not configured — using fallbacks'}
            </span>
          </div>
          {aiStatus.data?.model && (
            <div>
              <span className="text-muted">Model: </span>
              <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{aiStatus.data.model}</code>
            </div>
          )}
          {aiUsage.data && (
            <div>
              <span className="text-muted">Today: </span>
              <span className="font-medium tabular-nums">
                {formatNumber(aiUsage.data.usedToday)} / {formatNumber(aiUsage.data.dailyLimit)}
              </span>
            </div>
          )}
        </div>

        {aiUsage.isLoading ? (
          <Skeleton className="h-24" />
        ) : aiUsage.data && aiUsage.data.totalCalls > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">AI usage over the last {aiUsage.data.periodDays} days</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="px-2 pb-2 font-medium">Feature</th>
                  <th scope="col" className="px-2 pb-2 text-right font-medium">Calls</th>
                  <th scope="col" className="px-2 pb-2 text-right font-medium">Avg latency</th>
                  <th scope="col" className="px-2 pb-2 text-right font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {aiUsage.data.byFeature.map((row) => (
                  <tr key={row.feature}>
                    <td className="px-2 py-2">{humanise(row.feature)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatNumber(row.calls)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{row.averageLatencyMs} ms</td>
                    <td className="px-2 py-2 text-right tabular-nums text-muted">
                      {formatNumber(row.inputTokens + row.outputTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {aiUsage.data.degradedCalls > 0 && (
              <p className="mt-3 text-xs text-muted">
                {formatNumber(aiUsage.data.degradedCalls)} of {formatNumber(aiUsage.data.totalCalls)} calls fell
                back to rule-based results.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">No AI calls recorded in the last 30 days.</p>
        )}
      </Card>

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <PasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Modals                                                                     */
/* -------------------------------------------------------------------------- */

const InviteModal = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({ name: '', email: '', role: 'MEMBER', password: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const invite = useMutation({
    mutationFn: () => api.post('/auth/members', form),
    onSuccess: () => {
      toast('Member invited. Share the temporary password with them.', 'success');
      setForm({ name: '', email: '', role: 'MEMBER', password: '' });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      toast(error instanceof ApiError ? error.message : 'Invite failed.', 'error');
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    invite.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite a team member"
      description="They sign in with this temporary password and can change it afterwards."
      size="sm"
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" error={fieldErrors.name} required>
          {(id) => (
            <Input id={id} required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          )}
        </Field>

        <Field label="Email" error={fieldErrors.email} required>
          {(id) => (
            <Input
              id={id}
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          )}
        </Field>

        <Field label="Role">
          {(id) => (
            <Select id={id} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
              <option value="ADMIN">Admin</option>
              <option value="MEMBER">Member</option>
              <option value="VIEWER">Viewer</option>
            </Select>
          )}
        </Field>

        <Field
          label="Temporary password"
          hint="At least 10 characters"
          error={fieldErrors.password}
          required
        >
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="text"
              required
              minLength={10}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          )}
        </Field>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={invite.isPending}>Send invite</Button>
        </div>
      </form>
    </Modal>
  );
};

const PasswordModal = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { toast } = useToast();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const change = useMutation({
    mutationFn: () => api.post('/auth/change-password', form),
    onSuccess: () => {
      // Every session is revoked server-side, so a full reload to the login page
      // is the honest outcome — pretending the user is still signed in would
      // just produce a wall of 401s.
      toast('Password changed. Please sign in again.', 'success');
      window.location.href = '/login';
    },
    onError: (error) => {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      toast(error instanceof ApiError ? error.message : 'Could not change password.', 'error');
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change password"
      description="This signs you out of all devices."
      size="sm"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFieldErrors({});
          change.mutate();
        }}
        className="space-y-4"
      >
        <Field label="Current password" error={fieldErrors.currentPassword} required>
          {(id) => (
            <Input
              id={id}
              type="password"
              required
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))}
            />
          )}
        </Field>

        <Field label="New password" hint="At least 10 characters" error={fieldErrors.newPassword} required>
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={form.newPassword}
              onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
            />
          )}
        </Field>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={change.isPending}>Change password</Button>
        </div>
      </form>
    </Modal>
  );
};
