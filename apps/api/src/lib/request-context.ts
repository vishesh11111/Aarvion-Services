/**
 * Per-request context propagated via AsyncLocalStorage.
 *
 * This is what lets a log line emitted three layers deep inside a service still
 * carry the request id, user and tenant — without threading a context object
 * through every function signature in the codebase.
 *
 * It is used for *observability only*. Tenant isolation deliberately does NOT
 * read from here: authorisation that depends on ambient state is authorisation
 * that eventually leaks. Repositories take an explicit `TenantContext` argument.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  userId?: string;
  organizationId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

/**
 * Enrich the active context once the request has been authenticated. Mutating
 * the stored object is intentional — it is scoped to this request's async tree.
 */
export const enrichRequestContext = (patch: Partial<Omit<RequestContext, 'requestId'>>): void => {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
};
